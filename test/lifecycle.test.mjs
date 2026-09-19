import test from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './helpers.mjs';

// 月末核账主流程：登记 → 阴干 → 拆两炉 → 中断续烧 → 出窑 → 抽检 → 放行，核谱系与损耗。
test('批次拆分两炉、中断续烧、放行与损耗核账', async () => {
  const svc = await startService();
  try {
    let r = await svc.cmd('batch.register', {
      claySource: { mine: '浚县紫泥坑', lot: 'M-2026-09' },
      workshop: '北街一号坊',
      formedAt: '2026-09-01T08:00:00Z',
      owner: '张师傅',
      unitIds: ['u1', 'u2', 'u3', 'u4'],
    });
    assert.equal(r.status, 201);
    const parentId = r.body.events[0].batchId;

    r = await svc.cmd('batch.drying_start', { batchId: parentId });
    assert.equal(r.status, 201);

    // 拆分成两支，分别进两炉
    r = await svc.cmd('batch.split', {
      fromBatchId: parentId,
      reason: '月末两炉排产',
      splits: [
        { batchId: 'b-a', unitIds: ['u1', 'u2'] },
        { batchId: 'b-b', unitIds: ['u3', 'u4'] },
      ],
    });
    assert.equal(r.status, 201);

    r = await svc.cmd('kiln_batch.start', { kilnBatchId: 'k1', kilnId: 'kiln-甲', batchIds: ['b-a'] });
    assert.equal(r.status, 201);
    r = await svc.cmd('kiln_batch.start', { kilnBatchId: 'k2', kilnId: 'kiln-乙', batchIds: ['b-b'] });
    assert.equal(r.status, 201);

    // 模拟中途停电，恢复后出窑
    r = await svc.cmd('kiln_batch.interrupt', { kilnBatchId: 'k1', reason: '停电' });
    assert.equal(r.status, 201);
    assert.equal((await svc.get('/v1/batches/b-a')).body.status, 'interrupted');
    // 中断重发幂等
    r = await svc.cmd('kiln_batch.interrupt', { kilnBatchId: 'k1', reason: '停电' });
    assert.equal(r.body.events.length, 0);
    r = await svc.cmd('kiln_batch.resume', { kilnBatchId: 'k1' });
    assert.equal(r.status, 201);

    for (const k of ['k1', 'k2']) {
      r = await svc.cmd('kiln_batch.complete', { kilnBatchId: k });
      assert.equal(r.status, 201);
    }
    for (const b of ['b-a', 'b-b']) {
      assert.equal((await svc.get(`/v1/batches/${b}`)).body.status, 'fired');
    }

    // 出窑检查 + 放行
    r = await svc.cmd('inspection.record', {
      batchId: 'b-a', inspectType: 'exit', result: 'pass', inspector: '李质检',
    });
    assert.equal(r.status, 201);
    const inspA = r.body.events[0].inspectionId;
    r = await svc.cmd('batch.release', { batchId: 'b-a' });
    assert.equal(r.status, 201);
    assert.equal(r.body.events[0].inspectionId, inspA);

    // b-b 出窑不合格 → 判废
    r = await svc.cmd('inspection.record', {
      batchId: 'b-b', inspectType: 'exit', result: 'fail', defects: ['开裂'], inspector: '李质检',
    });
    assert.equal(r.status, 201);
    r = await svc.cmd('batch.release', { batchId: 'b-b' });
    assert.equal(r.status, 409);
    r = await svc.cmd('batch.condemn', { batchId: 'b-b', reason: '梅雨季阴干不均导致开裂' });
    assert.equal(r.status, 201);

    // 损耗核账：4 件，2 放行 2 判废，父批次 split 不重复计件
    const loss = (await svc.get('/v1/reports/loss')).body;
    assert.equal(loss.units.total, 4);
    assert.equal(loss.units.released, 2);
    assert.equal(loss.units.condemned, 2);

    // 谱系：从泥坯父批次可追溯到两炉、检验与判废
    const lin = (await svc.get(`/v1/lineage/${parentId}`)).body;
    const nodeKinds = new Set(lin.nodes.map((n) => n.kind));
    for (const k of ['batch', 'kiln_batch', 'inspection', 'release', 'condemn']) {
      assert.ok(nodeKinds.has(k), `谱系缺少 ${k}`);
    }
    const edgeKinds = lin.edges.map((e) => e.kind);
    assert.ok(edgeKinds.includes('split'));
    assert.ok(edgeKinds.includes('fired_in'));

    // 边按 seq 有序（倒序上传读数不影响既有结论顺序）
    const seqs = lin.edges.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  } finally {
    await svc.close();
  }
});
