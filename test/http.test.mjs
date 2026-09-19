import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';
import { EventStore } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'kiln-'));

function startApp(file) {
  const app = createApp(new EventStore(file));
  return new Promise((resolve) => {
    const srv = app.server.listen(0, () => {
      const p = srv.address().port;
      resolve({ base: `http://127.0.0.1:${p}`, close: () => srv.close(), svc: app.svc });
    });
  });
}

const api = (base, method, path, body) =>
  fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

let app;
before(async () => {
  app = await startApp(join(dir, 'events.jsonl'));
});
after(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('健康检查返回事件版本', async () => {
  const r = await api(app.base, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('HTTP 全流程：登记->拆批->两炉->读数->停电冻结->通知', async () => {
  const reg = await api(app.base, 'POST', '/api/units', {
    kind: 'batch',
    name: 'HTTP 批',
    claySource: '澄泥 C1',
    formedAt: '2026-09-10T08:00:00Z',
    workshop: '甲作坊',
    moisture: 11,
  });
  assert.equal(reg.status, 201);
  const batch = reg.json.itemId;

  const split = await api(app.base, 'POST', `/api/batches/${batch}/split`, { parts: [{ qty: 5 }, { qty: 5 }] });
  assert.equal(split.status, 201);
  const [c1, c2] = split.json.childBatchIds;

  const f1 = await api(app.base, 'POST', '/api/kilns/KH1/firings', { itemIds: [c1] });
  const f2 = await api(app.base, 'POST', '/api/kilns/KH2/firings', { itemIds: [c2] });
  assert.equal(f1.status, 201);
  assert.equal(f2.status, 201);

  // 幂等：同 messageId 重传
  const msg = { messageId: 'm-1', ts: '2026-09-19T02:00:00Z', temp: 80 };
  const a = await api(app.base, 'POST', `/api/kilns/KH1/firings/${f1.json.firingId}/readings`, msg);
  const b = await api(app.base, 'POST', `/api/kilns/KH1/firings/${f1.json.firingId}/readings`, msg);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);

  // K2 停电缺口 -> 冻结
  await api(app.base, 'POST', `/api/kilns/KH2/firings/${f2.json.firingId}/readings`, {
    messageId: 'm-2', ts: '2026-09-19T02:00:00Z', temp: 80,
  });
  await api(app.base, 'POST', `/api/kilns/KH2/firings/${f2.json.firingId}/interrupt`, { reason: '停电' });
  const frozen = await api(app.base, 'POST', `/api/kilns/KH2/firings/${f2.json.firingId}/readings`, {
    messageId: 'm-3', ts: '2026-09-19T02:45:00Z', temp: 160,
  });
  assert.equal(frozen.json.frozen, true);

  const notes = await api(app.base, 'GET', '/api/notifications');
  assert.equal(notes.json.notifications.length, 1);
  assert.deepEqual(notes.json.notifications[0].owners, ['甲作坊']);

  // 冻结期间放行被拒
  const blocked = await api(app.base, 'POST', `/api/units/${c2}/inspect`, { result: 'released' });
  assert.equal(blocked.status, 409);
});

test('重新部署后：未出窑窑次从事件日志恢复并可继续', async () => {
  // 新开一个独立文件，入炉后“进程重启”
  const file = join(dir, 'restart.jsonl');
  const a1 = await startApp(file);
  const reg = await api(a1.base, 'POST', '/api/units', {
    kind: 'item', name: '续烧件', claySource: '澄泥 C2', formedAt: '2026-09-11T08:00:00Z', workshop: '乙作坊',
  });
  const id = reg.json.itemId;
  const f = await api(a1.base, 'POST', '/api/kilns/KR/firings', { itemIds: [id] });
  const firingId = f.json.firingId;
  await api(a1.base, 'POST', `/api/kilns/KR/firings/${firingId}/readings`, {
    messageId: 'r1', ts: '2026-09-19T03:00:00Z', temp: 100,
  });
  // 中断中“服务下线”
  await api(a1.base, 'POST', `/api/kilns/KR/firings/${firingId}/interrupt`, { reason: '停电' });
  a1.close();

  // 重新部署：新进程重放 JSONL
  const a2 = await startApp(file);
  const health = await api(a2.base, 'GET', '/health');
  assert.ok(health.json.eventVersion >= 4);
  const trace = await api(a2.base, 'GET', `/api/units/${id}/trace`);
  assert.equal(trace.json.status, '烧制中断');
  assert.equal(trace.json.firingHistory[0].interrupted, true);

  // 继续烧制 -> 出窑 -> 放行
  await api(a2.base, 'POST', `/api/kilns/KR/firings/${firingId}/resume`, {});
  await api(a2.base, 'POST', `/api/kilns/KR/firings/${firingId}/readings`, {
    messageId: 'r2', ts: '2026-09-19T03:10:00Z', temp: 180,
  });
  await api(a2.base, 'POST', `/api/kilns/KR/firings/${firingId}/readings`, {
    messageId: 'r3', ts: '2026-09-19T03:20:00Z', temp: 260,
  });
  const unload = await api(a2.base, 'POST', `/api/kilns/KR/firings/${firingId}/unload`, {});
  assert.equal(unload.status, 200);
  const inspect = await api(a2.base, 'POST', `/api/units/${id}/inspect`, { result: 'released' });
  assert.equal(inspect.status, 201);
  assert.equal(inspect.json.status, '已放行');
  a2.close();
});

test('参数校验与 404', async () => {
  const bad = await api(app.base, 'POST', '/api/units', { name: '缺泥料' });
  assert.equal(bad.status, 400);
  const nf = await api(app.base, 'GET', '/api/units/nope/trace');
  assert.equal(nf.status, 404);
});
