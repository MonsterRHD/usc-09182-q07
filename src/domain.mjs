// 泥塑干燥烧制领域：全部状态由事件重放得到，事件只追加、不修改。
// 后到的传感器读数只追加为 reading.received，永远不会回写已采纳的曲线摘要或检验结论。

export const BATCH_STATUS = {
  REGISTERED: 'registered',
  DRYING: 'drying',
  FIRING: 'firing',
  INTERRUPTED: 'interrupted',
  FIRED: 'fired', // 出窑待检
  RELEASED: 'released',
  CONDEMNED: 'condemned',
  SPLIT: 'split',
};

// 冻结后仍允许的安全动作；其余命令一律拒绝。
const COMMANDS_ALLOWED_WHILE_FROZEN = new Set([
  'kiln_batch.interrupt',
  'batch.unfreeze',
]);

export function createInitialState() {
  return {
    seq: 0,
    batches: new Map(),
    kilnBatches: new Map(),
    devices: new Map(),
    inspections: new Map(),
    notices: [],
    readings: new Map(), // readingId -> 首次事件负载指纹
    eventsById: new Map(), // 事件 id -> 事件对象（幂等重放取回）
    commandKeys: new Map(), // 幂等键 -> 事件 id 列表
    edges: [], // 谱系边：{from, to, kind, at, seq, unitId?}
  };
}

function newBatch(state, rec) {
  state.batches.set(rec.id, {
    kind: 'batch',
    status: BATCH_STATUS.REGISTERED,
    parentIds: [],
    splitOf: null,
    claySource: null,
    workshop: null,
    formedAt: null,
    owner: null,
    unitIds: [],
    dryingStartedAt: null,
    dryingEnv: [],
    kilnBatchId: null,
    firedKilnBatches: [],
    inspections: [],
    frozen: false,
    freezeReasons: [],
    releasedAt: null,
    condemnedAt: null,
    createdAt: null,
    ...rec,
  });
}

function link(state, from, to, kind, e, extra = {}) {
  state.edges.push({ from, to, kind, at: e.at, seq: e.seq, ...extra });
}

export function applyEvent(state, e) {
  state.eventsById.set(e.id, e);
  if (e.key) {
    const list = state.commandKeys.get(e.key) || [];
    list.push(e.id);
    state.commandKeys.set(e.key, list);
  }
  switch (e.type) {
    case 'batch.registered': {
      newBatch(state, {
        id: e.batchId,
        claySource: e.claySource,
        workshop: e.workshop,
        formedAt: e.formedAt,
        owner: e.owner ?? null,
        unitIds: [...(e.unitIds || [])],
        createdAt: e.at,
      });
      break;
    }
    case 'batch.drying_started': {
      const b = state.batches.get(e.batchId);
      b.status = BATCH_STATUS.DRYING;
      b.dryingStartedAt = e.at;
      if (e.workshop) b.workshop = e.workshop;
      break;
    }
    case 'batch.drying_env_recorded': {
      const b = state.batches.get(e.batchId);
      b.dryingEnv.push(strip(e, ['type', 'seq', 'id', 'at', 'key']));
      break;
    }
    case 'batch.split': {
      const parent = state.batches.get(e.fromBatchId);
      parent.status = BATCH_STATUS.SPLIT;
      for (const s of e.splits) {
        newBatch(state, {
          id: s.batchId,
          claySource: parent.claySource,
          workshop: s.workshop || parent.workshop,
          formedAt: parent.formedAt,
          owner: s.owner || parent.owner,
          unitIds: [...s.unitIds],
          splitOf: parent.id,
          parentIds: [parent.id],
          createdAt: e.at,
          status: BATCH_STATUS.DRYING,
          dryingStartedAt: parent.dryingStartedAt,
        });
        link(state, parent.id, s.batchId, 'split', e, { reason: e.reason });
      }
      break;
    }
    case 'device.registered': {
      state.devices.set(e.deviceId, { kilnId: e.kilnId });
      break;
    }
    case 'reading.received': {
      // 仅登记指纹用于幂等与冲突检测；读数不修改任何结论。
      state.readings.set(e.readingId, {
        eventId: e.id,
        fingerprint: fingerprintPayload(e),
      });
      if (e.kind === 'environment') {
        const b = state.batches.get(e.batchId);
        if (b) b.dryingEnv.push(strip(e, ['type', 'seq', 'id', 'key', 'readingId', 'deviceId']));
      } else if (e.kind === 'kiln' && e.kilnBatchId) {
        const kb = state.kilnBatches.get(e.kilnBatchId);
        if (kb) {
          kb.readings.push(strip(e, ['type', 'seq', 'id', 'key', 'readingId', 'kilnBatchId']));
        }
      }
      break;
    }
    case 'kiln_batch.started': {
      state.kilnBatches.set(e.kilnBatchId, {
        id: e.kilnBatchId,
        kilnId: e.kilnId,
        status: 'running',
        batchIds: [...e.batchIds],
        plannedCurve: e.plannedCurve || null,
        startedAt: e.at,
        endedAt: null,
        interrupt: null,
        resumes: [],
        readings: [],
        summaries: [],
        refireOf: e.refireOf || null,
      });
      for (const bid of e.batchIds) {
        const b = state.batches.get(bid);
        b.status = BATCH_STATUS.FIRING;
        b.kilnBatchId = e.kilnBatchId;
        b.firedKilnBatches.push(e.kilnBatchId);
        link(state, bid, e.kilnBatchId, 'fired_in', e);
      }
      break;
    }
    case 'kiln_batch.interrupted': {
      const kb = state.kilnBatches.get(e.kilnBatchId);
      kb.status = 'interrupted';
      kb.interrupt = { at: e.at, reason: e.reason };
      for (const bid of kb.batchIds) {
        const b = state.batches.get(bid);
        if (b.status === BATCH_STATUS.FIRING) b.status = BATCH_STATUS.INTERRUPTED;
      }
      break;
    }
    case 'kiln_batch.resumed': {
      const kb = state.kilnBatches.get(e.kilnBatchId);
      kb.status = 'running';
      kb.resumes.push({ at: e.at });
      for (const bid of kb.batchIds) {
        const b = state.batches.get(bid);
        if (b.status === BATCH_STATUS.INTERRUPTED) b.status = BATCH_STATUS.FIRING;
      }
      break;
    }
    case 'kiln_batch.completed': {
      const kb = state.kilnBatches.get(e.kilnBatchId);
      kb.status = 'completed';
      kb.endedAt = e.endedAt || e.at;
      for (const bid of kb.batchIds) {
        const b = state.batches.get(bid);
        if (!b.frozen && b.status !== BATCH_STATUS.RELEASED && b.status !== BATCH_STATUS.CONDEMNED) {
          b.status = BATCH_STATUS.FIRED;
        }
        b.kilnBatchId = null;
      }
      break;
    }
    case 'kiln_batch.refired': {
      const from = state.kilnBatches.get(e.fromKilnBatchId);
      const to = state.kilnBatches.get(e.toKilnBatchId);
      if (from) from.refiredTo = e.toKilnBatchId;
      if (to) to.refireOf = e.fromKilnBatchId;
      link(state, e.fromKilnBatchId, e.toKilnBatchId, 'refire', e, {
        batchIds: e.batchIds,
        reason: e.reason,
      });
      break;
    }
    case 'curve.summary_adopted': {
      const kb = state.kilnBatches.get(e.kilnBatchId);
      kb.summaries.push(strip(e, ['type', 'seq', 'id', 'key']));
      break;
    }
    case 'batch.frozen': {
      for (const bid of e.batchIds) {
        const b = state.batches.get(bid);
        b.frozen = true;
        b.freezeReasons.push({ at: e.at, reason: e.reason, trigger: e.trigger || null });
        if (b.status === BATCH_STATUS.FIRING) b.status = BATCH_STATUS.INTERRUPTED;
        link(state, bid, `freeze:${e.seq}`, 'frozen', e);
      }
      break;
    }
    case 'batch.unfrozen': {
      for (const bid of e.batchIds) {
        const b = state.batches.get(bid);
        b.frozen = false;
        link(state, `freeze:unfreeze:${e.seq}`, bid, 'unfrozen', e, { reason: e.reason });
      }
      break;
    }
    case 'inspection.recorded': {
      const rec = {
        id: e.inspectionId,
        batchId: e.batchId,
        unitId: e.unitId || null,
        inspectType: e.inspectType,
        result: e.result,
        defects: e.defects || [],
        inspector: e.inspector || null,
        note: e.note || null,
        at: e.at,
      };
      state.inspections.set(e.inspectionId, rec);
      const b = state.batches.get(e.batchId);
      b.inspections.push(rec);
      link(state, e.batchId, e.inspectionId, 'inspected', e, {
        unitId: rec.unitId,
        result: rec.result,
      });
      break;
    }
    case 'batch.released': {
      const b = state.batches.get(e.batchId);
      b.status = BATCH_STATUS.RELEASED;
      b.releasedAt = e.at;
      link(state, e.batchId, `release:${e.inspectionId}`, 'released', e);
      break;
    }
    case 'batch.condemned': {
      const b = state.batches.get(e.batchId);
      b.status = BATCH_STATUS.CONDEMNED;
      b.condemnedAt = e.at;
      b.condemnReason = e.reason;
      link(state, e.batchId, `condemn:${e.inspectionId}`, 'condemned', e, { reason: e.reason });
      break;
    }
    case 'notice.sent': {
      state.notices.push(strip(e, ['type', 'seq', 'id', 'key']));
      break;
    }
    default:
      // 未知事件类型不致命，保证旧版本日志可被新版本读取。
      break;
  }
}

export function isFrozen(state, batchId) {
  return Boolean(state.batches.get(batchId)?.frozen);
}

// 命令涉及冻结批次时拦截（安全命令除外）。
export function assertNotFrozen(state, batchIds, commandType) {
  if (COMMANDS_ALLOWED_WHILE_FROZEN.has(commandType)) return;
  const hit = batchIds.filter((id) => isFrozen(state, id));
  if (hit.length) {
    const err = new Error(`批次 ${hit.join('、')} 已冻结，禁止 ${commandType}`);
    err.code = 'BATCH_FROZEN';
    err.status = 409;
    err.batchIds = hit;
    throw err;
  }
}

export function requireBatch(state, id) {
  const b = state.batches.get(id);
  if (!b) throw httpError(404, 'BATCH_NOT_FOUND', `批次 ${id} 不存在`);
  return b;
}

export function requireKilnBatch(state, id) {
  const kb = state.kilnBatches.get(id);
  if (!kb) throw httpError(404, 'KILN_BATCH_NOT_FOUND', `窑炉批次 ${id} 不存在`);
  return kb;
}

export function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ---------- 曲线异常判定 ----------

export const DEFAULT_CURVE_LIMITS = {
  maxTemp: 1300, // ℃
  maxRampPerHour: 200, // ℃/h
  maxDeviation: 80, // 与目标曲线偏差 ℃
};

export function detectCurveAnomaly(kb, summary) {
  const limits = { ...DEFAULT_CURVE_LIMITS, ...(kb.plannedCurve?.limits || {}) };
  const violations = [];
  if (summary.abnormal === true) violations.push('摘要自带异常标记');
  if (typeof summary.maxTemp === 'number' && summary.maxTemp > limits.maxTemp) {
    violations.push(`最高温 ${summary.maxTemp}℃ 超过上限 ${limits.maxTemp}℃`);
  }
  if (typeof summary.rampPerHourMax === 'number' && summary.rampPerHourMax > limits.maxRampPerHour) {
    violations.push(`最大升温速率 ${summary.rampPerHourMax}℃/h 超过 ${limits.maxRampPerHour}℃/h`);
  }
  if (typeof summary.targetDeviationMax === 'number' && summary.targetDeviationMax > limits.maxDeviation) {
    violations.push(`目标曲线偏差 ${summary.targetDeviationMax}℃ 超过 ${limits.maxDeviation}℃`);
  }
  return { abnormal: violations.length > 0, violations, limits };
}

// ---------- 谱系 ----------

export function buildLineage(state, rootId) {
  const adj = new Map();
  const ensure = (id) => {
    if (!adj.has(id)) adj.set(id, new Set());
    return adj.get(id);
  };
  for (const ed of state.edges) {
    ensure(ed.from).add(ed.to);
    ensure(ed.to).add(ed.from);
  }
  const visited = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.pop();
    for (const nxt of adj.get(cur) || []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }
  const nodes = [];
  for (const id of visited) {
    if (state.batches.has(id)) nodes.push({ kind: 'batch', ...batchView(state.batches.get(id)) });
    else if (state.kilnBatches.has(id)) nodes.push({ kind: 'kiln_batch', ...kilnBatchView(state, state.kilnBatches.get(id)) });
    else if (state.inspections.has(id)) nodes.push({ kind: 'inspection', ...state.inspections.get(id) });
    else if (id.startsWith('freeze:')) nodes.push({ kind: 'freeze', id });
    else if (id.startsWith('release:')) nodes.push({ kind: 'release', id });
    else if (id.startsWith('condemn:')) nodes.push({ kind: 'condemn', id });
  }
  const edges = state.edges
    .filter((ed) => visited.has(ed.from) && visited.has(ed.to))
    .map(({ seq, at, from, to, kind, ...rest }) => ({ from, to, kind, at, seq, ...rest }));
  return { root: rootId, nodes, edges };
}

// ---------- 视图 ----------

export function batchView(b) {
  return {
    id: b.id,
    status: b.status,
    frozen: b.frozen,
    claySource: b.claySource,
    workshop: b.workshop,
    formedAt: b.formedAt,
    owner: b.owner,
    unitIds: b.unitIds,
    parentIds: b.parentIds,
    splitOf: b.splitOf,
    dryingStartedAt: b.dryingStartedAt,
    dryingEnv: b.dryingEnv,
    kilnBatchId: b.kilnBatchId,
    firedKilnBatches: b.firedKilnBatches,
    inspections: b.inspections,
    freezeReasons: b.freezeReasons,
    releasedAt: b.releasedAt,
    condemnedAt: b.condemnedAt,
    condemnReason: b.condemnReason || null,
    createdAt: b.createdAt,
  };
}

export function kilnBatchView(state, kb) {
  return {
    id: kb.id,
    kilnId: kb.kilnId,
    status: kb.status,
    batchIds: kb.batchIds,
    plannedCurve: kb.plannedCurve,
    startedAt: kb.startedAt,
    endedAt: kb.endedAt,
    interrupt: kb.interrupt,
    resumes: kb.resumes,
    refireOf: kb.refireOf,
    refiredTo: kb.refiredTo || null,
    readingCount: kb.readings.length,
    readings: kb.readings,
    summaries: kb.summaries,
  };
}

// 损耗/放行核账：split 父批次不重复计件。
export function lossReport(state) {
  const units = { total: 0, byStatus: {}, condemned: 0, released: 0, inProcess: 0 };
  const batches = { total: 0, byStatus: {} };
  for (const b of state.batches.values()) {
    batches.total += 1;
    batches.byStatus[b.status] = (batches.byStatus[b.status] || 0) + 1;
    if (b.status === BATCH_STATUS.SPLIT) continue;
    const n = b.unitIds.length;
    units.total += n;
    units.byStatus[b.status] = (units.byStatus[b.status] || 0) + n;
    if (b.status === BATCH_STATUS.CONDEMNED) units.condemned += n;
    else if (b.status === BATCH_STATUS.RELEASED) units.released += n;
    else units.inProcess += n;
  }
  return { units, batches, frozenBatchIds: [...state.batches.values()].filter((b) => b.frozen).map((b) => b.id) };
}

// ---------- 工具 ----------

function strip(e, keys) {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (!keys.includes(k)) out[k] = v;
  return out;
}

function fingerprintPayload(e) {
  const { deviceId, kind, kilnBatchId, batchId, temp, humidity, at } = e;
  return JSON.stringify({ deviceId, kind, kilnBatchId, batchId, temp, humidity, at });
}
