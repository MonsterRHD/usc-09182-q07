// HTTP 接口：命令走 POST /v1/commands，查询为只读投影。
import {
  batchView,
  buildLineage,
  kilnBatchView,
  lossReport,
} from './domain.mjs';
import { handleCommand } from './handlers.mjs';

export function createApp(store, { notifier } = {}) {
  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/health') {
        return json(res, 200, { status: 'ok', seq: store.state.seq });
      }

      if (req.method === 'POST' && pathname === '/v1/commands') {
        const body = await readJson(req);
        if (!body || typeof body.type !== 'string') {
          return json(res, 400, { error: { code: 'BAD_REQUEST', message: '需要 type 字段' } });
        }
        const result = handleCommand(store, body.type, body.payload || {}, {
          idempotencyKey: req.headers['idempotency-key'] || body.idempotencyKey || null,
        });
        for (const e of result.events) {
          if (e.type === 'notice.sent') notifier?.(e);
        }
        return json(res, result.replayed ? 200 : 201, result);
      }

      if (req.method === 'GET' && pathname === '/v1/batches') {
        const list = [...store.state.batches.values()].map(batchView);
        return json(res, 200, { items: list });
      }

      let m;
      if ((m = pathname.match(/^\/v1\/batches\/([^/]+)$/)) && req.method === 'GET') {
        const b = store.state.batches.get(m[1]);
        if (!b) return json(res, 404, { error: { code: 'BATCH_NOT_FOUND', message: '批次不存在' } });
        return json(res, 200, batchView(b));
      }

      if ((m = pathname.match(/^\/v1\/kiln-batches\/([^/]+)$/)) && req.method === 'GET') {
        const kb = store.state.kilnBatches.get(m[1]);
        if (!kb) return json(res, 404, { error: { code: 'KILN_BATCH_NOT_FOUND', message: '窑炉批次不存在' } });
        return json(res, 200, kilnBatchView(store.state, kb));
      }

      if ((m = pathname.match(/^\/v1\/lineage\/([^/]+)$/)) && req.method === 'GET') {
        const id = m[1];
        if (!store.state.batches.has(id) && !store.state.kilnBatches.has(id)) {
          return json(res, 404, { error: { code: 'ROOT_NOT_FOUND', message: '谱系根节点不存在' } });
        }
        return json(res, 200, buildLineage(store.state, id));
      }

      if (req.method === 'GET' && pathname === '/v1/reports/loss') {
        return json(res, 200, lossReport(store.state));
      }

      if (req.method === 'GET' && pathname === '/v1/notices') {
        return json(res, 200, { items: store.state.notices });
      }

      if (req.method === 'GET' && pathname === '/v1/events') {
        return json(res, 200, { seq: store.state.seq, items: [...store.state.eventsById.values()] });
      }

      return json(res, 404, { error: { code: 'NOT_FOUND', message: '未知路由' } });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json(res, status, {
        error: {
          code: err.code || 'INTERNAL',
          message: err.message,
          ...(err.batchIds ? { batchIds: err.batchIds } : {}),
          ...(err.firstEventId ? { firstEventId: err.firstEventId } : {}),
        },
      });
    }
  };
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(Object.assign(new Error('请求体过大'), { status: 413 }));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400, code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}
