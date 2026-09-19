// 应用层：命令 -> 事件。校验业务规则、处理幂等、异常冻结与通知。
import {
  applyEvent,
  assertNotFrozen,
  detectCurveAnomaly,
  httpError,
  requireBatch,
  requireKilnBatch,
} from './domain.mjs';

// 携带幂等键重放时，直接返回首次产生的事件，不再次执行业务。
export function handleCommand(store, commandType, payload, { idempotencyKey } = {}) {
  const state = store.state;
  if (idempotencyKey) {
    const seen = state.commandKeys.get(idempotencyKey);
    if (seen) return { replayed: true, events: seen.map((id) => state.eventsById?.get(id)).filter(Boolean), idempotencyKey };
  }
  const out = HANDLERS[commandType](state, payload);
  // 设备消息重传：readingId 已存在且负载一致，直接回传首次事件，不再追加。
  if (out.__redelivered) {
    return { replayed: true, redelivered: true, events: [state.eventsById.get(out.eventId)], idempotencyKey: idempotencyKey || null };
  }
  const events = out;
  for (const e of events) e.key = e.key || idempotencyKey;
  store.commit(events);
  return { replayed: false, events, idempotencyKey: idempotencyKey || null };
}

const nextId = (state, prefix) => `${prefix}_${state.seq + 1}_${Math.random().toString(36).slice(2, 8)}`;

function expect(obj, keys) {
  for (const k of keys) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === '') {
      throw httpError(400, 'MISSING_FIELD', `缺少字段 ${k}`);
    }
  }
}

const HANDLERS = {
  'batch.register'(state, p) {
    expect(p, ['claySource', 'formedAt']);
    const id = p.id || nextId(state, 'batch');
    if (state.batches.has(id)) throw httpError(409, 'BATCH_EXISTS', `批次 ${id} 已存在`);
    return [{
      type: 'batch.registered',
      batchId: id,
      claySource: p.claySource,
      workshop: p.workshop || null,
      formedAt: p.formedAt,
      owner: p.owner || null,
      unitIds: dedupe(p.unitIds || []),
    }];
  },

  'batch.drying_start'(state, p) {
    const b = requireBatch(state, p.batchId);
    assertNotFrozen(state, [b.id], 'batch.drying_start');
    return [{ type: 'batch.drying_started', batchId: b.id, workshop: p.workshop || b.workshop }];
  },

  'batch.split'(state, p) {
    const parent = requireBatch(state, p.fromBatchId);
    assertNotFrozen(state, [parent.id], 'batch.split');
    if (!Array.isArray(p.splits) || p.splits.length < 2) {
      throw httpError(400, 'BAD_SPLIT', '拆分至少需要两个目标批次');
    }
    if (parent.unitIds.length === 0) {
      throw httpError(400, 'NO_UNITS', '批次没有登记单件，无法按件拆分');
    }
    const allocated = [];
    for (const s of p.splits) {
      if (!Array.isArray(s.unitIds) || s.unitIds.length === 0) {
        throw httpError(400, 'BAD_SPLIT', '每个拆分支必须包含单件');
      }
      for (const u of s.unitIds) {
        if (!parent.unitIds.includes(u)) throw httpError(400, 'UNIT_NOT_IN_BATCH', `单件 ${u} 不属于原批次`);
        if (allocated.includes(u)) throw httpError(409, 'UNIT_DOUBLE_ALLOCATED', `单件 ${u} 被重复分配`);
        allocated.push(u);
      }
    }
    const missing = parent.unitIds.filter((u) => !allocated.includes(u));
    if (missing.length) throw httpError(400, 'SPLIT_NOT_EXHAUSTIVE', `还有单件未分配：${missing.join('、')}`);
    return [{
      type: 'batch.split',
      fromBatchId: parent.id,
      reason: p.reason || null,
      splits: p.splits.map((s) => ({
        batchId: s.batchId || nextId(state, 'batch'),
        unitIds: [...s.unitIds],
        workshop: s.workshop || null,
        owner: s.owner || null,
      })),
    }];
  },

  'device.register'(state, p) {
    expect(p, ['deviceId', 'kilnId']);
    return [{ type: 'device.registered', deviceId: p.deviceId, kilnId: p.kilnId }];
  },

  // 设备消息重传幂等：相同 readingId 返回首次结果；负载不同则判定冲突，拒绝覆盖。
  'reading.ingest'(state, p) {
    expect(p, ['deviceId', 'readingId', 'kind']);
    if (!['kiln', 'environment'].includes(p.kind)) {
      throw httpError(400, 'BAD_READING_KIND', 'kind 只能是 kiln 或 environment');
    }
    const refId = p.kind === 'kiln' ? p.kilnBatchId : p.batchId;
    if (!refId) throw httpError(400, 'MISSING_FIELD', p.kind === 'kiln' ? '缺少 kilnBatchId' : '缺少 batchId');
    if (p.kind === 'kiln') requireKilnBatch(state, p.kilnBatchId);
    else requireBatch(state, p.batchId);
    const e = {
      type: 'reading.received',
      deviceId: p.deviceId,
      readingId: p.readingId,
      kind: p.kind,
      kilnBatchId: p.kilnBatchId || null,
      batchId: p.batchId || null,
      at: p.at || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      temp: p.temp ?? null,
      humidity: p.humidity ?? null,
      seqInDevice: p.seq ?? null,
    };
    const existing = state.readings.get(p.readingId);
    if (existing) {
      if (existing.fingerprint !== fingerprintPayload(e)) {
        throw httpError(409, 'READING_CONFLICT', `读数 ${p.readingId} 已以不同内容存在，拒绝覆盖`, {
          firstEventId: existing.eventId,
        });
      }
      return { __redelivered: true, eventId: existing.eventId };
    }
    return [e];
  },

  'kiln_batch.start'(state, p) {
    expect(p, ['kilnId', 'batchIds']);
    if (!Array.isArray(p.batchIds) || p.batchIds.length === 0) {
      throw httpError(400, 'EMPTY_KILN_BATCH', '窑炉批次至少包含一个作品批次');
    }
    for (const bid of p.batchIds) {
      const b = requireBatch(state, bid);
      assertNotFrozen(state, [bid], 'kiln_batch.start');
      if (b.kilnBatchId) throw httpError(409, 'BATCH_IN_FIRING', `批次 ${bid} 已在窑炉批次 ${b.kilnBatchId} 中`);
      if (['released', 'condemned', 'split'].includes(b.status)) {
        throw httpError(409, 'BATCH_NOT_FIREABLE', `批次 ${bid} 状态 ${b.status} 不能入窑`);
      }
    }
    const id = p.kilnBatchId || nextId(state, 'kiln');
    if (state.kilnBatches.has(id)) throw httpError(409, 'KILN_BATCH_EXISTS', `窑炉批次 ${id} 已存在`);
    return [{
      type: 'kiln_batch.started',
      kilnBatchId: id,
      kilnId: p.kilnId,
      batchIds: [...p.batchIds],
      plannedCurve: p.plannedCurve || null,
      refireOf: p.refireOf || null,
    }];
  },

  'kiln_batch.interrupt'(state, p) {
    const kb = requireKilnBatch(state, p.kilnBatchId);
    if (kb.status === 'interrupted') return []; // 中断重发幂等
    if (kb.status !== 'running') throw httpError(409, 'KILN_NOT_RUNNING', `窑炉批次状态 ${kb.status}，无法中断`);
    return [{ type: 'kiln_batch.interrupted', kilnBatchId: kb.id, reason: p.reason || null }];
  },

  'kiln_batch.resume'(state, p) {
    const kb = requireKilnBatch(state, p.kilnBatchId);
    if (kb.status === 'running') return [];
    if (kb.status !== 'interrupted') throw httpError(409, 'KILN_NOT_INTERRUPTED', `窑炉批次状态 ${kb.status}，无法恢复`);
    assertNotFrozen(state, kb.batchIds, 'kiln_batch.resume');
    return [{ type: 'kiln_batch.resumed', kilnBatchId: kb.id }];
  },

  'kiln_batch.complete'(state, p) {
    const kb = requireKilnBatch(state, p.kilnBatchId);
    if (kb.status === 'completed') return [];
    if (!['running', 'interrupted'].includes(kb.status)) {
      throw httpError(409, 'KILN_NOT_ACTIVE', `窑炉批次状态 ${kb.status}，无法出窑`);
    }
    assertNotFrozen(state, kb.batchIds, 'kiln_batch.complete');
    return [{ type: 'kiln_batch.completed', kilnBatchId: kb.id, endedAt: p.endedAt || null }];
  },

  'kiln_batch.refire'(state, p) {
    const from = requireKilnBatch(state, p.fromKilnBatchId);
    if (!['completed', 'interrupted'].includes(from.status)) {
      throw httpError(409, 'KILN_NOT_REFIREABLE', `窑炉批次状态 ${from.status}，不能补烧`);
    }
    const batchIds = p.batchIds && p.batchIds.length ? p.batchIds : from.batchIds;
    for (const bid of batchIds) {
      if (!from.batchIds.includes(bid)) throw httpError(400, 'BATCH_NOT_IN_KILN', `批次 ${bid} 不在原窑炉批次中`);
      const b = requireBatch(state, bid);
      assertNotFrozen(state, [bid], 'kiln_batch.refire');
      if (b.kilnBatchId) throw httpError(409, 'BATCH_IN_FIRING', `批次 ${bid} 仍在烧制中`);
    }
    const toId = p.toKilnBatchId || nextId(state, 'kiln');
    if (state.kilnBatches.has(toId)) throw httpError(409, 'KILN_BATCH_EXISTS', `窑炉批次 ${toId} 已存在`);
    return [
      {
        type: 'kiln_batch.started',
        kilnBatchId: toId,
        kilnId: p.kilnId || from.kilnId,
        batchIds,
        plannedCurve: p.plannedCurve || from.plannedCurve,
        refireOf: from.id,
      },
      { type: 'kiln_batch.refired', fromKilnBatchId: from.id, toKilnBatchId: toId, batchIds, reason: p.reason || null },
    ];
  },

  // 采纳温度曲线摘要：一旦采纳即定稿；后续读数只追加，不回写本摘要。
  'curve.summary_adopt'(state, p) {
    const kb = requireKilnBatch(state, p.kilnBatchId);
    const summary = {
      summaryId: p.summaryId || nextId(state, 'sum'),
      source: p.source || 'manual',
      maxTemp: p.maxTemp ?? null,
      rampPerHourMax: p.rampPerHourMax ?? null,
      targetDeviationMax: p.targetDeviationMax ?? null,
      durationMin: p.durationMin ?? null,
      abnormal: p.abnormal === true,
      note: p.note || null,
      adoptedBy: p.adoptedBy || null,
    };
    const events = [{ type: 'curve.summary_adopted', kilnBatchId: kb.id, summary }];
    const verdict = detectCurveAnomaly(kb, summary);
    if (verdict.abnormal) {
      const reason = `温度曲线异常：${verdict.violations.join('；')}`;
      const targets = kb.batchIds.filter((bid) => !state.batches.get(bid)?.frozen);
      if (targets.length) {
        events.push({
          type: 'batch.frozen',
          batchIds: targets,
          reason,
          trigger: { kind: 'curve_summary', kilnBatchId: kb.id, summaryId: summary.summaryId, violations: verdict.violations },
        });
        const owners = [...new Set(targets.map((bid) => state.batches.get(bid).owner).filter(Boolean))];
        events.push({
          type: 'notice.sent',
          channel: p.notifyChannel || 'internal',
          toOwnerIds: owners,
          kilnBatchId: kb.id,
          batchIds: targets,
          reason,
          severity: 'critical',
        });
      }
    }
    return events;
  },

  'batch.unfreeze'(state, p) {
    const ids = p.batchIds || (p.kilnBatchId ? requireKilnBatch(state, p.kilnBatchId).batchIds : null);
    if (!ids) throw httpError(400, 'MISSING_FIELD', '需要 batchIds 或 kilnBatchId');
    const frozen = ids.filter((id) => state.batches.get(id)?.frozen);
    if (!frozen.length) return [];
    return [{ type: 'batch.unfrozen', batchIds: frozen, reason: p.reason || null, by: p.by || null }];
  },

  'inspection.record'(state, p) {
    const b = requireBatch(state, p.batchId);
    expect(p, ['result', 'inspectType']);
    if (!['exit', 'sample', 'refire_check', 'drying'].includes(p.inspectType)) {
      throw httpError(400, 'BAD_INSPECT_TYPE', 'inspectType 非法');
    }
    if (!['pass', 'fail', 'conditional'].includes(p.result)) {
      throw httpError(400, 'BAD_RESULT', 'result 只能是 pass/fail/conditional');
    }
    if (p.unitId && !b.unitIds.includes(p.unitId)) {
      throw httpError(400, 'UNIT_NOT_IN_BATCH', `单件 ${p.unitId} 不属于批次 ${b.id}`);
    }
    return [{
      type: 'inspection.recorded',
      inspectionId: p.inspectionId || nextId(state, 'insp'),
      batchId: b.id,
      unitId: p.unitId || null,
      inspectType: p.inspectType,
      result: p.result,
      defects: p.defects || [],
      inspector: p.inspector || null,
      note: p.note || null,
    }];
  },

  'batch.release'(state, p) {
    const b = requireBatch(state, p.batchId);
    assertNotFrozen(state, [b.id], 'batch.release');
    if (b.status !== 'fired') throw httpError(409, 'NOT_FIRED', `批次状态 ${b.status}，出窑合格后才能放行`);
    const exitInspections = b.inspections.filter((i) => ['exit', 'sample'].includes(i.inspectType));
    if (!exitInspections.length) throw httpError(409, 'NO_PASS_INSPECTION', '没有出窑/抽检记录，不能放行');
    if (latestOf(exitInspections).result !== 'pass') {
      throw httpError(409, 'LATEST_INSPECTION_NOT_PASS', '最近一次出窑/抽检未明确合格（conditional 需复验），不能放行');
    }
    return [{
      type: 'batch.released',
      batchId: b.id,
      inspectionId: latestOf(exitInspections).id,
    }];
  },

  'batch.condemn'(state, p) {
    const b = requireBatch(state, p.batchId);
    if (b.status === 'condemned') return [];
    if (b.status === 'released') throw httpError(409, 'ALREADY_RELEASED', '已放行批次不能判废');
    return [{
      type: 'batch.condemned',
      batchId: b.id,
      reason: p.reason || '检验不合格',
      inspectionId: p.inspectionId || null,
    }];
  },
};

function latestOf(inspections) {
  return inspections[inspections.length - 1];
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function fingerprintPayload(e) {
  const { deviceId, kind, kilnBatchId, batchId, temp, humidity, at } = e;
  return JSON.stringify({ deviceId, kind, kilnBatchId, batchId, temp, humidity, at });
}
