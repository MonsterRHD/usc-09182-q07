import test from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './helpers.mjs';

async function registerFiring(svc) {
  await svc.cmd('batch.register', {
    id: 'b1', claySource: '泥坑A', formedAt: '2026-09-01T08:00:00Z', owner: '张师傅', unitIds: ['u1'],
  });
  await svc.cmd('device.register', { deviceId: 'd1', kilnId: 'kiln-甲' });
  await svc.cmd('kiln_batch.start', { kilnBatchId: 'k1', kilnId: 'kiln-甲', batchIds: ['b1'] });
}

test('相同设备消息重传幂等：不产生重复读数', async () => {
  const svc = await startService();
  try {
    await registerFiring(svc);
    const reading = {
      deviceId: 'd1', readingId: 'r1', kind: 'kiln', kilnBatchId: 'k1',
      at: '2026-09-02T10:00:00Z', temp: 900, seq: 1,
    };
    let r = await svc.cmd('reading.ingest', reading);
    assert.equal(r.status, 201);
    assert.equal(r.body.replayed, false);

    // 完全相同的重传
    r = await svc.cmd('reading.ingest', reading);
    assert.equal(r.status, 200);
    assert.equal(r.body.redelivered, true);
    r = await svc.cmd('reading.ingest', reading);
    assert.equal(r.body.redelivered, true);

    const kb = (await svc.get('/v1/kiln-batches/k1')).body;
    assert.equal(kb.readingCount, 1);
  } finally {
    await svc.close();
  }
});

test('同 readingId 不同负载判定冲突并拒绝覆盖', async () => {
  const svc = await startService();
  try {
    await registerFiring(svc);
    const base = {
      deviceId: 'd1', readingId: 'r2', kind: 'kiln', kilnBatchId: 'k1',
      at: '2026-09-02T10:00:00Z', temp: 900,
    };
    let r = await svc.cmd('reading.ingest', base);
    assert.equal(r.status, 201);
    r = await svc.cmd('reading.ingest', { ...base, temp: 1250 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'READING_CONFLICT');
    assert.ok(r.body.error.firstEventId);

    const kb = (await svc.get('/v1/kiln-batches/k1')).body;
    assert.equal(kb.readings[0].temp, 900); // 首次值不被覆盖
  } finally {
    await svc.close();
  }
});

test('倒序上传读数：后到读数不能覆盖已采纳的曲线摘要', async () => {
  const svc = await startService();
  try {
    await registerFiring(svc);
    // 先上传后段读数并采纳摘要
    await svc.cmd('reading.ingest', {
      deviceId: 'd1', readingId: 'r-late', kind: 'kiln', kilnBatchId: 'k1',
      at: '2026-09-02T14:00:00Z', temp: 1200,
    });
    let r = await svc.cmd('curve.summary_adopt', {
      kilnBatchId: 'k1', summaryId: 's1', maxTemp: 1200, durationMin: 360, adoptedBy: '王窑头',
    });
    assert.equal(r.status, 201);

    // 倒序补传早段读数（网络延迟）
    r = await svc.cmd('reading.ingest', {
      deviceId: 'd1', readingId: 'r-early', kind: 'kiln', kilnBatchId: 'k1',
      at: '2026-09-02T08:00:00Z', temp: 200,
    });
    assert.equal(r.status, 201);

    const kb = (await svc.get('/v1/kiln-batches/k1')).body;
    assert.equal(kb.summaries.length, 1);
    assert.equal(kb.summaries[0].summary.summaryId, 's1');
    assert.equal(kb.summaries[0].summary.maxTemp, 1200); // 结论不变
    assert.equal(kb.readingCount, 2); // 读数照常追加
    // 读数保留设备原始时间，不因晚到而改写
    const times = kb.readings.map((x) => x.at);
    assert.deepEqual(times, ['2026-09-02T14:00:00Z', '2026-09-02T08:00:00Z']);
  } finally {
    await svc.close();
  }
});

test('命令幂等键：同一 Idempotency-Key 重放只生效一次', async () => {
  const svc = await startService();
  try {
    const payload = {
      claySource: '泥坑A', formedAt: '2026-09-01T08:00:00Z', unitIds: ['u1', 'u2'],
    };
    let r = await svc.cmd('batch.register', payload, { key: 'order-77' });
    assert.equal(r.status, 201);
    const firstId = r.body.events[0].id;
    r = await svc.cmd('batch.register', payload, { key: 'order-77' });
    assert.equal(r.status, 200);
    assert.equal(r.body.replayed, true);
    assert.equal(r.body.events[0].id, firstId);

    const list = (await svc.get('/v1/batches')).body.items;
    assert.equal(list.length, 1);
  } finally {
    await svc.close();
  }
});
