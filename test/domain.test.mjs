import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store.mjs';
import { KilnService, summarizeReadings } from '../src/domain.mjs';

/** 可控时钟：事件时间戳与曲线读数共用同一条时间轴。 */
function fakeClock(start = '2026-09-19T01:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t).toISOString(),
    tick: (min) => {
      t += min * 60000;
      return new Date(t).toISOString();
    },
    at: (min) => new Date(new Date(start).getTime() + min * 60000).toISOString(),
  };
}

function setup() {
  const clock = fakeClock();
  const svc = new KilnService(new EventStore(':memory:'), clock.now);
  return { svc, clock, store: svc.store };
}

test('月末核账：一批作品拆两炉、倒序曲线、停电冻结、补烧、判废、抽检、追溯全链路', () => {
  const { svc, clock, store } = setup();

  // 1) 登记母批：泥料来源 / 成型时间 / 作坊 / 阴干环境 / 含水率
  const reg = svc.register({
    kind: 'batch',
    name: '九月泥坯·甲批',
    claySource: '浚县黄河澄泥·2026-09 批次 C03',
    formedAt: '2026-09-12T08:00:00.000Z',
    workshop: '甲作坊',
    dryingEnv: { tempC: 22, humidityPct: 78, location: '北厢房阴干架' },
    moisture: 12.4,
  });
  const parentId = reg.itemId;

  // 同批还有一件单独追踪的作品，后续判废，用于核账损耗
  const piece = svc.register({
    kind: 'item',
    name: '泥咕咕·单件 07',
    claySource: '浚县黄河澄泥·2026-09 批次 C03',
    formedAt: '2026-09-12T09:00:00.000Z',
    workshop: '甲作坊',
    dryingEnv: { tempC: 22, humidityPct: 80 },
    moisture: 13.1,
  }).itemId;

  // 2) 拆批到两炉
  const split = svc.splitBatch({ parentBatchId: parentId, parts: [{ qty: 20 }, { qty: 18 }] });
  const [b1, b2] = split.childBatchIds;
  assert.equal(split.event.parts.length, 2);

  // 3) 两炉同时装烧
  clock.tick(0);
  const f1 = svc.startFiring({ kilnId: 'K1', itemIds: [b1, piece] }).firingId;
  const f2 = svc.startFiring({ kilnId: 'K2', itemIds: [b2] }).firingId;

  // 4) K1 曲线倒序上传（先传后段再传前段），全部正常
  const normalCurve = [
    { ts: clock.at(0), temp: 20 },
    { ts: clock.at(10), temp: 80 },
    { ts: clock.at(20), temp: 160 },
    { ts: clock.at(30), temp: 260 },
    { ts: clock.at(60), temp: 560 },
    { ts: clock.at(90), temp: 860 },
    { ts: clock.at(120), temp: 1230 },
  ];
  let seq = 0;
  for (const r of [...normalCurve].reverse()) {
    const out = svc.ingestReading({ kilnId: 'K1', firingId: f1, messageId: `k1-${seq++}`, ...r });
    assert.equal(out.frozen, false);
  }
  // 倒序到达不影响摘要时序
  const s1 = svc.state.kilns.get('K1');
  assert.deepEqual(summarizeReadings(s1.readings).startedAt, clock.at(0));
  assert.equal(summarizeReadings(s1.readings).maxTemp, 1230);

  clock.tick(121);
  svc.unload({ kilnId: 'K1', firingId: f1 });
  const rel = svc.inspect({ itemId: b1, firingId: f1, result: 'released', inspector: '老张' });
  assert.equal(rel.status, '已放行');
  svc.inspect({ itemId: piece, firingId: f1, result: 'scrap', cracks: 3, note: '口沿开裂', inspector: '老张' });

  // 已放行结论不可被后到的异常读数推翻
  const late = svc.ingestReading({ kilnId: 'K1', firingId: f1, messageId: 'k1-late', ts: clock.at(125), temp: 1500 });
  assert.equal(late.ignoredAfterUnload, true);
  assert.equal(late.frozen, false);
  assert.equal(svc.state.items.get(b1).status, '已放行');

  // 5) K2 模拟中途停电：显式中断/恢复 + 曲线 40 分钟缺口
  svc.ingestReading({ kilnId: 'K2', firingId: f2, messageId: 'k2-0', ts: clock.at(0), temp: 20 });
  svc.ingestReading({ kilnId: 'K2', firingId: f2, messageId: 'k2-1', ts: clock.at(10), temp: 90 });
  svc.interrupt({ kilnId: 'K2', firingId: f2, reason: '厂区中途停电' });
  assert.equal(svc.state.items.get(b2).status, '烧制中断');
  // 中断期间不能新开窑次（用一个尚未入炉的备用批验证）
  const spare = svc.register({
    kind: 'batch', name: '备用批', claySource: '浚县黄河澄泥·2026-09 批次 C03',
    formedAt: '2026-09-12T10:00:00.000Z', workshop: '乙作坊',
  }).itemId;
  assert.throws(() => svc.startFiring({ kilnId: 'K2', itemIds: [spare] }), /未出窑/);
  clock.tick(38);
  svc.resume({ kilnId: 'K2', firingId: f2 });

  // 停电后第一条读数触发缺口判定 -> 冻结 + 通知责任人
  const freezeOut = svc.ingestReading({ kilnId: 'K2', firingId: f2, messageId: 'k2-2', ts: clock.at(50), temp: 150 });
  assert.equal(freezeOut.frozen, true);
  assert.deepEqual(freezeOut.abnormalFlags, ['missing']);
  assert.equal(svc.state.items.get(b2).frozen, true);
  assert.equal(svc.state.items.get(b2).status, '冻结待查');
  const notes = svc.notifications();
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].owners, ['甲作坊']);
  assert.equal(notes[0].kilnId, 'K2');

  // 冻结后不能放行/转补烧，须先核查解冻
  assert.throws(() => svc.inspect({ itemId: b2, result: 'released' }), /冻结/);

  // 冻结后迟到的正常读数仍然记录，但不改变冻结结论（不自动解冻）
  const lateWhileFrozen = svc.ingestReading({ kilnId: 'K2', firingId: f2, messageId: 'k2-3', ts: clock.at(60), temp: 240 });
  assert.equal(lateWhileFrozen.alreadyFrozen, true);
  assert.equal(svc.state.items.get(b2).frozen, true);

  // 6) 责任人现场核查解冻 -> 出窑 -> 判补烧 -> 换 K3 补烧 -> 放行
  svc.unfreeze({ kilnId: 'K2', firingId: f2, reason: '停电缺口经测温复核，坯体无异常', resumed: true });
  assert.equal(svc.state.items.get(b2).frozen, false);
  svc.unload({ kilnId: 'K2', firingId: f2 });
  svc.inspect({ itemId: b2, firingId: f2, result: 'refire', cracks: 1, note: '底层轻微开裂，安排补烧', inspector: '老张' });
  assert.equal(svc.state.items.get(b2).status, '待补烧');

  const f3 = svc.startFiring({ kilnId: 'K3', itemIds: [b2] }).firingId;
  let rid = 0;
  for (const [gap, temp] of [[0, 100], [10, 220], [30, 520], [30, 900], [30, 1200]]) {
    const ts = clock.tick(gap);
    svc.ingestReading({ kilnId: 'K3', firingId: f3, messageId: `k3-${rid++}`, ts, temp });
  }
  clock.tick(1);
  svc.unload({ kilnId: 'K3', firingId: f3 });
  svc.inspect({ itemId: b2, firingId: f3, result: 'released', inspector: '老张' });
  assert.equal(svc.state.items.get(b2).status, '已放行');

  // 7) 样品抽检：合格批通过，缺陷率超 5% 不通过
  assert.equal(svc.sampleCheck({ batchId: b1, sampleSize: 20, defectCount: 0 }).passed, true);
  assert.equal(svc.sampleCheck({ batchId: b1, sampleSize: 20, defectCount: 2 }).passed, false);

  // 8) 追溯：母批 -> 两个子批 -> 各自窑炉曲线与检查，连续谱系
  const traceParent = svc.trace(parentId);
  assert.equal(traceParent.childBatches.length, 2);
  const types = traceParent.childBatches.flatMap((c) => c.lineage.map((e) => e.type));
  assert.ok(types.includes('batch_split'));
  const traceB2 = svc.trace(b2);
  assert.equal(traceB2.currentKiln.kilnId, 'K3'); // 当前所在窑次取最后一次
  assert.equal(traceB2.firingHistory.length, 2); // 原烧 + 补烧
  assert.deepEqual(traceB2.firingHistory.map((h) => h.kilnId), ['K2', 'K3']);
  assert.ok(traceB2.firingHistory[0].interrupted); // 停电留痕
  assert.ok(traceB2.firingHistory[0].abnormalFlags.includes('missing')); // 异常曲线随窑次保留
  assert.equal(traceB2.claySource, '浚县黄河澄泥·2026-09 批次 C03'); // 谱系回溯到泥料
  assert.equal(traceB2.inspections[0].result, 'refire');
  assert.equal(traceB2.inspections[1].result, 'released');
  assert.equal(traceB2.sampleChecks.length, 0);

  // 9) 月末核账：母批不计数量；放行 2、判废 1、开裂合计 4（补烧 1 + 判废 3）
  const rep = svc.report({ workshop: '甲作坊' });
  assert.equal(rep.units, 3);
  assert.equal(rep.released, 2);
  assert.equal(rep.scrap, 1);
  assert.equal(rep.pendingRefire, 0);
  assert.equal(rep.frozen, 0);
  assert.equal(rep.cracksTotal, 3); // 判废件口沿 3 裂；补烧件末次检查已合格记 0
  assert.equal(rep.freezeNotifications.length, 1);
  assert.equal(rep.sampleChecks.length, 2);
  assert.ok(rep.losses.some((l) => l.itemId === piece && l.result === 'scrap'));
  assert.ok(rep.losses.some((l) => l.itemId === b2 && l.result === 'refire'));
});

test('设备消息重传幂等：相同 messageId 只产生一次事件', () => {
  const { svc, clock } = setup();
  const b = svc.register({ kind: 'batch', name: '幂等批', claySource: '泥料 X', formedAt: clock.now(), workshop: '乙作坊' }).itemId;
  const f = svc.startFiring({ kilnId: 'K9', itemIds: [b] }).firingId;
  const before = svc.store.version;
  const r1 = svc.ingestReading({ kilnId: 'K9', firingId: f, messageId: 'dup-1', ts: clock.at(5), temp: 50 });
  const afterFirst = svc.store.version;
  const r2 = svc.ingestReading({ kilnId: 'K9', firingId: f, messageId: 'dup-1', ts: clock.at(5), temp: 999 });
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(svc.store.version, afterFirst); // 重传零新增事件
  assert.ok(afterFirst > before);
  // 重传携带的不同温度未被采纳
  assert.equal(svc.state.kilns.get('K9').readings.length, 1);
  assert.equal(svc.state.kilns.get('K9').readings[0].temp, 50);
});

test('温变速率异常与温度越限也会冻结', () => {
  const { svc, clock } = setup();
  const b = svc.register({ kind: 'batch', name: '速率批', claySource: '泥料 Y', formedAt: clock.now(), workshop: '丙作坊' }).itemId;
  const f = svc.startFiring({ kilnId: 'K8', itemIds: [b] }).firingId;
  svc.ingestReading({ kilnId: 'K8', firingId: f, messageId: 'base', ts: clock.at(0), temp: 20 });
  const out = svc.ingestReading({ kilnId: 'K8', firingId: f, messageId: 'fast', ts: clock.at(10), temp: 600 });
  assert.equal(out.frozen, true);
  assert.ok(out.abnormalFlags.includes('rate'));
  assert.equal(svc.state.kilns.get('K8').frozen, true);
});

test('终局结论不可覆盖：判废/放行后再次检查被拒', () => {
  const { svc, clock } = setup();
  const it = svc.register({ kind: 'item', name: '单件 Z', claySource: '泥料 Z', formedAt: clock.now(), workshop: '丁作坊' }).itemId;
  const f = svc.startFiring({ kilnId: 'K7', itemIds: [it] }).firingId;
  svc.ingestReading({ kilnId: 'K7', firingId: f, messageId: 'z1', ts: clock.at(10), temp: 100 });
  clock.tick(11);
  svc.unload({ kilnId: 'K7', firingId: f });
  svc.inspect({ itemId: it, result: 'scrap' });
  assert.throws(() => svc.inspect({ itemId: it, result: 'released' }), /不可覆盖/);
});

test('干燥环境可在登记后补录，并随谱系保留', () => {
  const { svc, clock } = setup();
  const it = svc.register({ kind: 'item', name: '补录件', claySource: '泥料 D', formedAt: clock.now(), workshop: '戊作坊' }).itemId;
  svc.recordDrying(it, { env: { tempC: 24, humidityPct: 72 }, moisture: 10.2 });
  const tr = svc.trace(it);
  assert.deepEqual(tr.dryingEnv, { tempC: 24, humidityPct: 72 });
  assert.equal(tr.moisture, 10.2);
});
