import { randomUUID } from 'node:crypto';

/**
 * 泥塑干燥烧制追踪 —— 领域逻辑（事件溯源）。
 *
 * 关键约束（对应业务要求）：
 * 1. 所有状态变更都是不可变事件；后到的传感器读数只会追加，
 *    绝不会覆盖已采纳的检查结论 / 放行 / 判废。
 * 2. provenance 构成连续谱系：成型 -> 入炉(可拆批) -> 中断/恢复 ->
 *    出窑检查(可补烧/判废/放行) -> 抽检；任何环节都能向上回溯到泥料。
 * 3. 相同设备消息（同一 messageId）重传保持幂等。
 * 4. 异常温度曲线立即冻结相关窑次与其中批次，并给责任人挂通知。
 */

export const now = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${randomUUID()}`;

export class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const reject = (status, message) => {
  throw new DomainError(status, message);
};

const freezeReasons = (flags) => {
  const map = { missing: '曲线不完整（缺失读数）', rate: '温变速率异常', range: '温度越限' };
  return flags.filter(Boolean).map((f) => map[f]);
};

/** 按时间戳归并窑炉曲线读数（倒序上传也能得到正确时序），并做异常判定。 */
export function summarizeReadings(readings) {
  const sorted = [...readings].sort((a, b) => a.ts.localeCompare(b.ts));
  const temps = sorted.map((r) => r.temp);
  const summary = {
    points: sorted.length,
    startedAt: sorted[0]?.ts ?? null,
    endedAt: sorted[sorted.length - 1]?.ts ?? null,
    minTemp: temps.length ? Math.min(...temps) : null,
    maxTemp: temps.length ? Math.max(...temps) : null,
    abnormalFlags: [],
    abnormal: false,
  };
  if (sorted.length === 0) return summary;

  // 速率异常：相邻读数每分钟温变超过阈值（陶艺窑炉正常爬升仅每分钟数度）。
  const MAX_RATE_PER_MIN = 20;
  let worstRate = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dt = (new Date(sorted[i].ts) - new Date(sorted[i - 1].ts)) / 60000;
    if (dt > 0) {
      const rate = Math.abs(sorted[i].temp - sorted[i - 1].temp) / dt;
      worstRate = Math.max(worstRate, rate);
      if (rate > MAX_RATE_PER_MIN) summary.abnormalFlags.push('rate');
    }
  }
  summary.maxRatePerMin = Number.isFinite(worstRate) ? Math.round(worstRate * 100) / 100 : null;

  // 曲线不完整：相邻读数间隔过大（中途停电期间传感器停发）。
  for (let i = 1; i < sorted.length; i++) {
    const gapMin = (new Date(sorted[i].ts) - new Date(sorted[i - 1].ts)) / 60000;
    if (gapMin > 30) summary.abnormalFlags.push('missing');
  }

  if (summary.minTemp < 0 || summary.maxTemp > 1400) summary.abnormalFlags.push('range');
  summary.abnormalFlags = [...new Set(summary.abnormalFlags)];
  summary.abnormal = summary.abnormalFlags.length > 0;
  return summary;
}

/** 纯函数：把事件流折叠成当前状态。 */
export function reduce(events) {
  const state = {
    items: new Map(), // itemId/batchId -> 单元
    kilns: new Map(), // kilnId -> 窑次视图
    messages: new Set(), // 已去重的设备消息
    notifications: [],
  };

  const ensureUnit = (id) => {
    if (!state.items.has(id)) {
      state.items.set(id, { id, lineage: [], batches: [], childBatches: [], parentBatchId: null });
    }
    return state.items.get(id);
  };
  const ensureKiln = (id) => {
    if (!state.kilns.has(id)) {
      state.kilns.set(id, { id, readings: [], firings: [], lineage: [] });
    }
    return state.kilns.get(id);
  };

  for (const e of events) {
    switch (e.type) {
      case 'item_registered': {
        const u = ensureUnit(e.itemId);
        Object.assign(u, {
          kind: e.kind,
          name: e.name,
          claySource: e.claySource,
          formedAt: e.formedAt,
          workshop: e.workshop,
          dryingEnv: e.dryingEnv ?? null,
          moisture: e.moisture ?? null,
          qty: e.qty ?? null,
          status: '已登记',
          frozen: false,
          freezeReasons: [],
        });
        u.lineage.push(e);
        break;
      }
      case 'drying_recorded': {
        const u = ensureUnit(e.itemId);
        u.dryingEnv = e.dryingEnv.env ?? e.dryingEnv;
        if (e.dryingEnv.moisture !== undefined) u.moisture = e.dryingEnv.moisture;
        u.lineage.push(e);
        break;
      }
      case 'batch_split': {
        const parent = ensureUnit(e.parentBatchId);
        e.childBatchIds.forEach((childId, i) => {
          const child = ensureUnit(childId);
          Object.assign(child, {
            kind: 'batch',
            name: `${parent.name ?? e.parentBatchId}·拆批${childId.slice(-4)}`,
            claySource: parent.claySource,
            formedAt: parent.formedAt,
            workshop: parent.workshop,
            dryingEnv: parent.dryingEnv ?? null,
            moisture: parent.moisture ?? null,
            qty: e.parts?.[i]?.qty ?? null,
            status: '已拆批',
            frozen: false,
            freezeReasons: [],
            parentBatchId: e.parentBatchId,
          });
          child.lineage.push(e);
          parent.childBatches.push(childId);
        });
        parent.lineage.push(e);
        break;
      }
      case 'kiln_firing_started': {
        const kiln = ensureKiln(e.kilnId);
        kiln.lineage.push(e);
        kiln.firings.push({
          firingId: e.firingId,
          seq: e.seq,
          plannedCurve: e.plannedCurve ?? null,
          startedAt: e.ts,
          endedAt: null,
          interrupted: false,
          interruptions: [],
          status: '烧制中',
          itemIds: [...e.itemIds],
        });
        for (const id of e.itemIds) {
          const u = ensureUnit(id);
          u.status = '烧制中';
          u.kilnId = e.kilnId;
          u.firingId = e.firingId;
          u.lineage.push(e);
        }
        break;
      }
      case 'kiln_interrupted': {
        const kiln = ensureKiln(e.kilnId);
        kiln.lineage.push(e);
        const f = kiln.firings.find((x) => x.firingId === e.firingId);
        if (f) {
          f.interrupted = true;
          f.status = '中断';
          f.interruptions.push({ at: e.ts, reason: e.reason, resumedAt: null });
        }
        for (const id of e.itemIds) {
          const u = ensureUnit(id);
          u.status = '烧制中断';
          u.lineage.push(e);
        }
        break;
      }
      case 'kiln_resumed': {
        const kiln = ensureKiln(e.kilnId);
        kiln.lineage.push(e);
        const f = kiln.firings.find((x) => x.firingId === e.firingId);
        if (f) {
          const last = f.interruptions[f.interruptions.length - 1];
          if (last) last.resumedAt = e.ts;
          f.status = '烧制中';
        }
        for (const id of e.itemIds) {
          const u = ensureUnit(id);
          u.status = '烧制中';
          u.lineage.push(e);
        }
        break;
      }
      case 'temp_reading_recorded': {
        state.messages.add(e.messageId);
        const kiln = ensureKiln(e.kilnId);
        kiln.readings.push({ ts: e.ts, temp: e.temp, seq: e.seq });
        break;
      }
      case 'curve_frozen': {
        state.messages.add(e.messageId);
        const kiln = ensureKiln(e.kilnId);
        kiln.lineage.push(e);
        kiln.frozen = true;
        const f = kiln.firings.find((x) => x.firingId === e.firingId);
        if (f) {
          f.status = '冻结';
          f.abnormalFlags = e.abnormalFlags;
          f.summary = e.summary;
        }
        for (const id of e.itemIds) {
          const u = ensureUnit(id);
          u.frozen = true;
          u.freezeReasons = freezeReasons(e.abnormalFlags);
          u.status = '冻结待查';
          u.lineage.push(e);
        }
        state.notifications.push({
          at: e.ts,
          kilnId: e.kilnId,
          firingId: e.firingId,
          owners: e.owners,
          abnormalFlags: e.abnormalFlags,
          summary: e.summary,
          itemIds: e.itemIds,
        });
        break;
      }
      case 'firing_unfrozen': {
        const kiln = ensureKiln(e.kilnId);
        kiln.lineage.push(e);
        kiln.frozen = false;
        const f = kiln.firings.find((x) => x.firingId === e.firingId);
        if (f) f.status = '烧制中';
        for (const id of e.itemIds) {
          const u = ensureUnit(id);
          u.frozen = false;
          u.freezeReasons = [];
          if (u.status === '冻结待查') u.status = '烧制中';
          u.lineage.push(e);
        }
        break;
      }
      case 'kiln_unloaded': {
        const kiln = ensureKiln(e.kilnId);
        kiln.lineage.push(e);
        const f = kiln.firings.find((x) => x.firingId === e.firingId);
        if (f) {
          f.endedAt = e.ts;
          f.status = '已出窑';
        }
        break;
      }
      case 'inspection_recorded': {
        const u = ensureUnit(e.itemId);
        const insp = {
          at: e.ts,
          firingId: e.firingId,
          result: e.result,
          cracks: e.cracks ?? 0,
          note: e.note ?? '',
          inspector: e.inspector ?? null,
        };
        u.inspections = u.inspections || [];
        u.inspections.push(insp);
        u.lineage.push(e);
        if (e.result === 'released') u.status = '已放行';
        if (e.result === 'scrap') u.status = '判废';
        if (e.result === 'refire') u.status = '待补烧';
        break;
      }
      case 'sample_check_recorded': {
        const u = ensureUnit(e.batchId);
        u.sampleChecks = u.sampleChecks || [];
        u.sampleChecks.push({
          at: e.ts,
          sampleSize: e.sampleSize,
          defectCount: e.defectCount,
          passed: e.passed,
          note: e.note ?? '',
        });
        u.lineage.push(e);
        break;
      }
      default:
        break;
    }
  }
  return state;
}

export class KilnService {
  constructor(store, clock = now) {
    this.store = store;
    this.clock = clock;
  }

  get state() {
    return reduce(this.store.events);
  }

  #commit(events) {
    this.store.append(events);
    return events;
  }

  #getUnit(state, id) {
    return state.items.get(id) ?? reject(404, `未找到单件或批次：${id}`);
  }

  // ---------- 泥料 / 成型 / 干燥 ----------

  register({ kind = 'item', name, claySource, formedAt, workshop, dryingEnv, moisture, qty = null, itemId }) {
    if (!name) reject(400, 'name 必填');
    if (!claySource) reject(400, 'claySource（泥料来源）必填');
    if (!formedAt) reject(400, 'formedAt（成型时间）必填');
    if (!workshop) reject(400, 'workshop（作坊）必填');
    if (!['item', 'batch'].includes(kind)) reject(400, "kind 只能是 'item' 或 'batch'");
    if (qty !== null && (!Number.isInteger(qty) || qty <= 0)) reject(400, 'qty 必须为正整数');
    const state = this.state;
    const id = itemId || newId(kind === 'batch' ? 'batch' : 'item');
    if (state.items.has(id)) reject(409, `标识已存在：${id}`);
    const e = {
      type: 'item_registered',
      ts: this.clock(),
      itemId: id,
      kind,
      name,
      claySource,
      formedAt,
      workshop,
      dryingEnv: dryingEnv ?? null,
      moisture: moisture ?? null,
      qty,
    };
    this.#commit([e]);
    return { itemId: id, event: e };
  }

  recordDrying(itemId, dryingEnv) {
    const state = this.state;
    this.#getUnit(state, itemId);
    const e = { type: 'drying_recorded', ts: this.clock(), itemId, dryingEnv };
    // 干燥记录也走注册事件的信息更新通道
    this.#commit([e]);
    return { event: e };
  }

  /** 批次拆分：一批作品拆到两炉时，先拆成两个子批。谱系不断。 */
  splitBatch({ parentBatchId, parts }) {
    if (!Array.isArray(parts) || parts.length < 2) reject(400, 'parts 至少要有两个拆分目标');
    const state = this.state;
    const parent = this.#getUnit(state, parentBatchId);
    if (parent.kind !== 'batch') reject(400, '只有批次可以拆分');
    const totalQty = parts.reduce((s, p) => s + (p.qty ?? 0), 0);
    if (parent.qty && totalQty > parent.qty) reject(400, '拆分数量之和超过母批数量');
    const childBatchIds = parts.map((p) => p.batchId || newId('batch'));
    const dup = childBatchIds.find((id) => state.items.has(id));
    if (dup) reject(409, `子批标识已存在：${dup}`);
    const e = {
      type: 'batch_split',
      ts: this.clock(),
      parentBatchId,
      childBatchIds,
      parts: parts.map((p, i) => ({ batchId: childBatchIds[i], qty: p.qty ?? null, note: p.note ?? '' })),
    };
    this.#commit([e]);
    return { parentBatchId, childBatchIds, event: e };
  }

  // ---------- 窑炉 / 曲线 ----------

  startFiring({ kilnId, itemIds, plannedCurve, firingId }) {
    if (!kilnId) reject(400, 'kilnId 必填');
    if (!Array.isArray(itemIds) || itemIds.length === 0) reject(400, 'itemIds 必填且非空');
    const state = this.state;
    for (const id of itemIds) {
      const u = this.#getUnit(state, id);
      if (u.frozen) reject(409, `${id} 已被冻结，不能入炉`);
      if (u.status === '烧制中') reject(409, `${id} 已在窑中`);
      if (u.status === '已放行') reject(409, `${id} 已放行，不能再次入炉（如需处理请走补烧登记）`);
    }
    const id = firingId || newId('firing');
    if (state.kilns.get(kilnId)?.firings.some((f) => f.firingId === id)) {
      reject(409, `窑次已存在：${id}`);
    }
    const active = state.kilns.get(kilnId)?.firings.filter((f) => !f.endedAt) ?? [];
    if (active.length > 0) {
      reject(409, `窑炉 ${kilnId} 已有未出窑的窑次（中断后请先恢复或处置）`);
    }
    const seq = (state.kilns.get(kilnId)?.firings.length ?? 0) + 1;
    const e = {
      type: 'kiln_firing_started',
      ts: this.clock(),
      kilnId,
      firingId: id,
      seq,
      itemIds: [...itemIds],
      plannedCurve: plannedCurve ?? null,
    };
    this.#commit([e]);
    return { kilnId, firingId: id, event: e };
  }

  interrupt({ kilnId, firingId, reason }) {
    const state = this.state;
    const f = this.#findActiveFiring(state, kilnId, firingId);
    if (f.status === '中断') reject(409, '该窑次已经处于中断状态');
    const e = { type: 'kiln_interrupted', ts: this.clock(), kilnId, firingId: f.firingId, reason: reason ?? '中途停电', itemIds: [...f.itemIds] };
    this.#commit([e]);
    return { event: e };
  }

  resume({ kilnId, firingId }) {
    const state = this.state;
    const f = this.#findActiveFiring(state, kilnId, firingId);
    if (f.status !== '中断') reject(409, '该窑次未处于中断状态，无需恢复');
    const e = { type: 'kiln_resumed', ts: this.clock(), kilnId, firingId: f.firingId, itemIds: [...f.itemIds] };
    this.#commit([e]);
    return { event: e };
  }

  /**
   * 设备上报温度曲线读数。
   * - messageId 幂等：同一消息重传直接返回首传结果，不产生第二条事件。
   * - 读数允许倒序到达，按时间戳归并。
   * - 曲线异常（停电缺口/温变异常/越限）-> 冻结当前窑次批次 + 通知责任人。
   * - 冻结之后迟到的读数仍然记录，但不会改变已采纳的冻结结论。
   */
  ingestReading({ kilnId, firingId, messageId, ts, temp }) {
    if (!messageId) reject(400, 'messageId 必填（设备消息去重键）');
    if (!kilnId || !firingId) reject(400, 'kilnId / firingId 必填');
    if (!ts || Number.isNaN(Date.parse(ts))) reject(400, 'ts 必须是合法时间戳');
    if (typeof temp !== 'number' || Number.isNaN(temp)) reject(400, 'temp 必须是数字');

    const state = this.state;
    if (state.messages.has(messageId)) {
      return { duplicate: true, messageId };
    }
    const firing = state.kilns.get(kilnId)?.firings.find((x) => x.firingId === firingId);
    if (!firing) reject(404, `未找到窑次：${kilnId}/${firingId}`);

    const seq = state.kilns.get(kilnId).readings.length + 1;
    const events = [{ type: 'temp_reading_recorded', ts, recordedAt: this.clock(), kilnId, firingId, messageId, temp, seq }];

    // 用“加入本读数后”的完整曲线判断异常；倒序上传同样按时间戳排序。
    const summary = summarizeReadings([...state.kilns.get(kilnId).readings, { ts, temp }]);
    const alreadyFrozen = state.kilns.get(kilnId).frozen === true;
    // 窑次已出窑后迟到的读数只做记录，不再触发冻结——已采纳的放行/判废结论不可被推翻。
    const stillInKiln = !firing.endedAt;
    if (summary.abnormal && !alreadyFrozen && stillInKiln) {
      const owners = [...new Set(firing.itemIds.map((id) => state.items.get(id)?.workshop).filter(Boolean))];
      events.push({
        type: 'curve_frozen',
        ts: this.clock(),
        kilnId,
        firingId,
        messageId: `${messageId}:freeze`,
        abnormalFlags: summary.abnormalFlags,
        summary,
        itemIds: [...firing.itemIds],
        owners,
      });
    }
    this.#commit(events);
    const triggered = summary.abnormal && !alreadyFrozen && stillInKiln;
    return {
      duplicate: false,
      frozen: triggered,
      alreadyFrozen: alreadyFrozen && summary.abnormal,
      ignoredAfterUnload: summary.abnormal && !stillInKiln,
      abnormalFlags: summary.abnormalFlags,
      summary,
      events,
    };
  }

  /** 责任人现场核查后解除冻结（解冻理由留痕）。 */
  unfreeze({ kilnId, firingId, reason, resumed = false }) {
    const state = this.state;
    const kiln = state.kilns.get(kilnId);
    if (!kiln?.frozen) reject(409, '该窑次当前未冻结');
    const f = kiln.firings.find((x) => x.firingId === firingId);
    const e = {
      type: 'firing_unfrozen',
      ts: this.clock(),
      kilnId,
      firingId,
      reason: reason ?? '责任人核查后解除',
      resumed,
      itemIds: [...(f?.itemIds ?? [])],
    };
    this.#commit([e]);
    return { event: e };
  }

  unload({ kilnId, firingId }) {
    const state = this.state;
    const f = this.#findActiveFiring(state, kilnId, firingId);
    if (f.status === '中断') reject(409, '窑次仍处于中断，请先恢复或记录处置');
    const e = { type: 'kiln_unloaded', ts: this.clock(), kilnId, firingId: f.firingId };
    this.#commit([e]);
    return { event: e };
  }

  /** 出窑检查：release 放行 / refire 待补烧 / scrap 判废。结论一经采纳不可被读数覆盖。 */
  inspect({ itemId, firingId, result, cracks = 0, note, inspector }) {
    if (!['released', 'refire', 'scrap'].includes(result)) reject(400, "result 只能是 released / refire / scrap");
    const state = this.state;
    const u = this.#getUnit(state, itemId);
    if (u.status === '已放行' || u.status === '判废') {
      reject(409, `${itemId} 已有终局结论（${u.status}），检查结论不可覆盖`);
    }
    if (u.frozen && result !== 'scrap') {
      reject(409, `${itemId} 已冻结待查，须由责任人核查解冻后才能${result === 'released' ? '放行' : '转补烧'}`);
    }
    if (u.kilnId) {
      const firing = state.kilns.get(u.kilnId)?.firings.find((x) => x.firingId === (firingId ?? u.firingId));
      if (firing && !firing.endedAt) reject(409, `${itemId} 尚未出窑，不能做出窑检查（冻结窑次可先出窑再判废）`);
    }
    const e = {
      type: 'inspection_recorded',
      ts: this.clock(),
      itemId,
      firingId: firingId ?? u.firingId ?? null,
      result,
      cracks,
      note: note ?? '',
      inspector: inspector ?? null,
    };
    this.#commit([e]);
    return { event: e, status: result === 'released' ? '已放行' : result === 'scrap' ? '判废' : '待补烧' };
  }

  /** 样品抽检（针对批次）。 */
  sampleCheck({ batchId, sampleSize, defectCount, note }) {
    if (!Number.isInteger(sampleSize) || sampleSize <= 0) reject(400, 'sampleSize 必须为正整数');
    if (!Number.isInteger(defectCount) || defectCount < 0) reject(400, 'defectCount 必须为非负整数');
    const state = this.state;
    this.#getUnit(state, batchId);
    const passed = defectCount / sampleSize <= 0.05;
    const e = {
      type: 'sample_check_recorded',
      ts: this.clock(),
      batchId,
      sampleSize,
      defectCount,
      passed,
      note: note ?? '',
    };
    this.#commit([e]);
    return { event: e, passed };
  }

  #findActiveFiring(state, kilnId, firingId) {
    const kiln = state.kilns.get(kilnId);
    const f = kiln?.firings.find((x) => x.firingId === firingId);
    if (!f) reject(404, `未找到窑次：${kilnId}/${firingId}`);
    return f;
  }

  // ---------- 查询 / 追溯 / 核账 ----------

  trace(id) {
    const state = this.state;
    const u = state.items.get(id);
    if (!u) reject(404, `未找到：${id}`);
    return this.#traceUnit(state, id, new Set());
  }

  #traceUnit(state, id, seen) {
    if (seen.has(id)) return null;
    seen.add(id);
    const u = state.items.get(id);
    const kilnReadings = u.kilnId
      ? summarizeReadings(
          state.kilns.get(u.kilnId)?.readings.filter((r) => {
            const f = state.kilns.get(u.kilnId).firings.find((x) => x.firingId === u.firingId);
            if (!f || !r.ts) return false;
            return r.ts >= f.startedAt && (!f.endedAt || r.ts <= f.endedAt);
          }) ?? [],
        )
      : null;
    const firingHistory = [...state.kilns.values()].flatMap((k) =>
      k.firings
        .filter((f) => f.itemIds.includes(u.id))
        .map((f) => ({
          kilnId: k.id,
          firingId: f.firingId,
          seq: f.seq,
          status: f.status,
          startedAt: f.startedAt,
          endedAt: f.endedAt,
          plannedCurve: f.plannedCurve,
          interrupted: f.interrupted,
          interruptions: f.interruptions,
          abnormalFlags: f.abnormalFlags ?? [],
          summary:
            f.summary ??
            summarizeReadings(k.readings.filter((r) => r.ts >= f.startedAt && (!f.endedAt || r.ts <= f.endedAt))),
        })),
    );
    return {
      itemId: u.id,
      kind: u.kind,
      name: u.name,
      claySource: u.claySource,
      formedAt: u.formedAt,
      workshop: u.workshop,
      dryingEnv: u.dryingEnv,
      moisture: u.moisture,
      status: u.status,
      frozen: u.frozen,
      freezeReasons: u.freezeReasons,
      parentBatchId: u.parentBatchId,
      childBatches: u.childBatches.map((c) => this.#traceUnit(state, c, seen)),
      currentKiln: u.kilnId ? { kilnId: u.kilnId, firingId: u.firingId, readings: kilnReadings } : null,
      firingHistory,
      inspections: u.inspections ?? [],
      sampleChecks: u.sampleChecks ?? [],
      lineage: u.lineage.map((e) => ({ type: e.type, ts: e.ts, ...(e.reason ? { reason: e.reason } : {}) })),
    };
  }

  /** 月末核账：损耗 / 放行 / 冻结 / 抽检 汇总，可按作坊过滤。 */
  report({ workshop } = {}) {
    const state = this.state;
    const units = [...state.items.values()].filter((u) => !workshop || u.workshop === workshop);
    const leaf = units.filter((u) => u.childBatches.length === 0); // 拆批后母批不计数量
    const result = {
      generatedAt: this.clock(),
      workshop: workshop ?? '全部',
      units: leaf.length,
      released: leaf.filter((u) => u.status === '已放行').length,
      scrap: leaf.filter((u) => u.status === '判废').length,
      pendingRefire: leaf.filter((u) => u.status === '待补烧').length,
      frozen: leaf.filter((u) => u.frozen).length,
      inKiln: leaf.filter((u) => ['烧制中', '烧制中断', '冻结待查'].includes(u.status)).length,
      notYetFired: leaf.filter((u) => !u.kilnId && u.status !== '判废' && u.status !== '已放行').length,
      cracksTotal: leaf.reduce((s, u) => s + (u.inspections?.[u.inspections.length - 1]?.cracks ?? 0), 0),
      sampleChecks: leaf.flatMap((u) =>
        (u.sampleChecks ?? []).map((c) => ({ batchId: u.id, ...c })),
      ),
      freezeNotifications: state.notifications
        .filter((n) => !workshop || n.owners.includes(workshop))
        .map((n) => ({ at: n.at, kilnId: n.kilnId, firingId: n.firingId, owners: n.owners, abnormalFlags: n.abnormalFlags })),
      losses: [],
    };
    // 损耗明细：判废 + 开裂但已放行的返工记录
    for (const u of leaf) {
      for (const insp of u.inspections ?? []) {
        if (insp.result === 'scrap' || (insp.cracks ?? 0) > 0) {
          result.losses.push({
            itemId: u.id,
            name: u.name,
            workshop: u.workshop,
            firingId: insp.firingId,
            result: insp.result,
            cracks: insp.cracks,
            note: insp.note,
          });
        }
      }
    }
    return result;
  }

  notifications() {
    return this.state.notifications;
  }
}
