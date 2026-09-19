import test from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './helpers.mjs';

async function registerBatch(svc, id = 'b1') {
  await svc.cmd('batch.register', {
    id, claySource: '泥坑A', formedAt: '2026-09-01T08:00:00Z', owner: '张师傅', unitIds: ['u1', 'u2'],
  });
}

test('异常曲线冻结相关批次并通知责任人', async () => {
  const svc = await startService();
  try {
    await registerBatch(svc);
    await svc.cmd('kiln_batch.start', { kilnBatchId: 'k1', kilnId: 'kiln-甲', batchIds: ['b1'] });

    // 超温曲线摘要 → 冻结 + 通知
    let r = await svc.cmd('curve.summary_adopt', {
      kilnBatchId: 'k1', summaryId: 's-bad', maxTemp: 1450,
    });
    assert.equal(r.status, 201);
    const types = r.body.events.map((e) => e.type);
    assert.ok(types.includes('batch.frozen'));
    assert.ok(types.includes('notice.sent'));

    const b = (await svc.get('/v1/batches/b1')).body;
    assert.equal(b.frozen, true);
    assert.equal(b.status, 'interrupted');
    assert.equal(b.freezeReasons[0].trigger.kind, 'curve_summary');
    assert.equal(svc.notices.length, 1);
    assert.deepEqual(svc.notices[0].toOwnerIds, ['张师傅']);
    assert.deepEqual(svc.notices[0].batchIds, ['b1']);

    // 冻结期间禁止出窑/放行等操作
    r = await svc.cmd('kiln_batch.complete', { kilnBatchId: 'k1' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'BATCH_FROZEN');

    // 排查处置后解冻
    r = await svc.cmd('batch.unfreeze', { kilnBatchId: 'k1', reason: '停电致超温，已检修', by: '王窑头' });
    assert.equal(r.status, 201);
    assert.equal((await svc.get('/v1/batches/b1')).body.frozen, false);
  } finally {
    await svc.close();
  }
});

test('冻结与中断独立：未冻结批次中断后仍可恢复', async () => {
  const svc = await startService();
  try {
    await registerBatch(svc, 'b1');
    await registerBatch(svc, 'b2');
    await svc.cmd('kiln_batch.start', { kilnBatchId: 'k1', kilnId: 'kiln-甲', batchIds: ['b1', 'b2'] });
    await svc.cmd('kiln_batch.interrupt', { kilnBatchId: 'k1', reason: '停电' });
    // 只冻结 b1
    await svc.cmd('batch.unfreeze', { batchIds: ['b1'] }); // 无冻结，返回空，无副作用
    await svc.cmd('curve.summary_adopt', { kilnBatchId: 'k1', summaryId: 's', maxTemp: 1400 });
    assert.deepEqual((await svc.get('/v1/batches/b1')).body.frozen, true);
    assert.deepEqual((await svc.get('/v1/batches/b2')).body.frozen, true); // 同炉均冻结

    // 恢复烧制需要全部解冻
    let r = await svc.cmd('kiln_batch.resume', { kilnBatchId: 'k1' });
    assert.equal(r.status, 409);
    await svc.cmd('batch.unfreeze', { kilnBatchId: 'k1', reason: '处置完成' });
    r = await svc.cmd('kiln_batch.resume', { kilnBatchId: 'k1' });
    assert.equal(r.status, 201);
  } finally {
    await svc.close();
  }
});

test('重新部署后未出窑批次可继续：事件日志重放恢复在烧状态', async () => {
  const svc = await startService();
  try {
    await registerBatch(svc);
    await svc.cmd('kiln_batch.start', { kilnBatchId: 'k1', kilnId: 'kiln-甲', batchIds: ['b1'] });
    await svc.cmd('reading.ingest', {
      deviceId: 'd1', readingId: 'r1', kind: 'kiln', kilnBatchId: 'k1',
      at: '2026-09-02T10:00:00Z', temp: 800,
    });
    await svc.cmd('kiln_batch.interrupt', { kilnBatchId: 'k1', reason: '发布重启前停电' });

    // 模拟重新部署：用同一数据目录重建 store（新进程语义）
    const reloaded = svc.reload();
    assert.equal(reloaded.state.kilnBatches.get('k1').status, 'interrupted');
    assert.equal(reloaded.state.batches.get('b1').status, 'interrupted');
    assert.equal(reloaded.state.kilnBatches.get('k1').readings.length, 1);
    assert.equal(reloaded.state.seq, svc.store.state.seq);
    // 原 store 替换为重放后的 store，继续完成生命周期
    Object.assign(svc.store, { state: reloaded.state });
    let r = await svc.cmd('kiln_batch.resume', { kilnBatchId: 'k1' });
    assert.equal(r.status, 201);
    r = await svc.cmd('kiln_batch.complete', { kilnBatchId: 'k1' });
    assert.equal(r.status, 201);
    assert.equal((await svc.get('/v1/batches/b1')).body.status, 'fired');
  } finally {
    await svc.close();
  }
});

test('补烧形成谱系：补烧后检验合格方可放行', async () => {
  const svc = await startService();
  try {
    await registerBatch(svc);
    await svc.cmd('kiln_batch.start', { kilnBatchId: 'k1', kilnId: 'kiln-甲', batchIds: ['b1'] });
    await svc.cmd('kiln_batch.complete', { kilnBatchId: 'k1' });
    await svc.cmd('inspection.record', {
      batchId: 'b1', inspectType: 'exit', result: 'conditional', defects: ['欠烧'], inspector: '李质检',
    });
    // 补烧
    let r = await svc.cmd('kiln_batch.refire', { fromKilnBatchId: 'k1', toKilnBatchId: 'k2', reason: '欠烧返烧' });
    assert.equal(r.status, 201);
    assert.equal((await svc.get('/v1/batches/b1')).body.status, 'firing');
    await svc.cmd('kiln_batch.complete', { kilnBatchId: 'k2' });
    await svc.cmd('inspection.record', {
      batchId: 'b1', inspectType: 'refire_check', result: 'pass', inspector: '李质检',
    });
    // 没有 exit/sample 的 pass 仍不能放行
    r = await svc.cmd('batch.release', { batchId: 'b1' });
    assert.equal(r.status, 409);
    await svc.cmd('inspection.record', {
      batchId: 'b1', inspectType: 'exit', result: 'pass', inspector: '李质检',
    });
    r = await svc.cmd('batch.release', { batchId: 'b1' });
    assert.equal(r.status, 201);

    const kb2 = (await svc.get('/v1/kiln-batches/k2')).body;
    assert.equal(kb2.refireOf, 'k1');
    const lin = (await svc.get('/v1/lineage/b1')).body;
    assert.ok(lin.edges.some((e) => e.kind === 'refire' && e.from === 'k1' && e.to === 'k2'));
    assert.deepEqual((await svc.get('/v1/batches/b1')).body.firedKilnBatches, ['k1', 'k2']);
  } finally {
    await svc.close();
  }
});

test('样品抽检：单件级检验记录且必须属于批次', async () => {
  const svc = await startService();
  try {
    await registerBatch(svc);
    let r = await svc.cmd('inspection.record', {
      batchId: 'b1', unitId: 'u9', inspectType: 'sample', result: 'pass',
    });
    assert.equal(r.status, 400);
    r = await svc.cmd('inspection.record', {
      batchId: 'b1', unitId: 'u1', inspectType: 'sample', result: 'pass', inspector: '李质检',
    });
    assert.equal(r.status, 201);
    const b = (await svc.get('/v1/batches/b1')).body;
    assert.equal(b.inspections[0].unitId, 'u1');
    assert.equal(b.inspections[0].inspectType, 'sample');
  } finally {
    await svc.close();
  }
});

test('拆分必须穷尽且不得重复分配单件', async () => {
  const svc = await startService();
  try {
    await registerBatch(svc);
    let r = await svc.cmd('batch.split', {
      fromBatchId: 'b1',
      splits: [{ batchId: 'c1', unitIds: ['u1'] }, { batchId: 'c2', unitIds: ['u1'] }],
    });
    assert.equal(r.status, 409);
    r = await svc.cmd('batch.split', {
      fromBatchId: 'b1',
      splits: [{ batchId: 'c1', unitIds: ['u1'] }],
    });
    assert.equal(r.status, 400);
    r = await svc.cmd('batch.split', {
      fromBatchId: 'b1',
      splits: [{ batchId: 'c1', unitIds: ['u1'] }, { batchId: 'c2', unitIds: ['u2'] }],
    });
    assert.equal(r.status, 201);
    // 拆分后子批次继承泥料来源与成型时间，谱系连续
    const c1 = (await svc.get('/v1/batches/c1')).body;
    assert.equal(c1.claySource, '泥坑A');
    assert.equal(c1.splitOf, 'b1');
    assert.equal(c1.formedAt, '2026-09-01T08:00:00Z');
  } finally {
    await svc.close();
  }
});
