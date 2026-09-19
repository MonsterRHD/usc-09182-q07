import { createServer } from 'node:http';
import { EventStore } from './store.mjs';
import { KilnService, DomainError } from './domain.mjs';

/**
 * HTTP 接口（均为 JSON）：
 * 注册/干燥   POST /api/units            {kind,name,claySource,formedAt,workshop,dryingEnv,moisture}
 *             POST /api/units/:id/drying {env,moisture}
 * 拆批        POST /api/batches/:id/split {parts:[{qty,note,batchId?}]}
 * 入炉        POST /api/kilns/:kilnId/firings {itemIds,plannedCurve,firingId?}
 * 停电/恢复   POST /api/kilns/:kilnId/firings/:firingId/interrupt | /resume
 * 曲线读数    POST /api/kilns/:kilnId/firings/:firingId/readings
 *             {messageId,ts,temp}  —— 同 messageId 重传幂等；倒序上传允许
 * 解冻        POST /api/kilns/:kilnId/firings/:firingId/unfreeze {reason,resumed}
 * 出窑        POST /api/kilns/:kilnId/firings/:firingId/unload
 * 检查        POST /api/units/:id/inspect {result: released|refire|scrap,cracks,note,inspector}
 * 抽检        POST /api/batches/:id/sample-check {sampleSize,defectCount,note}
 * 追溯        GET  /api/units/:id/trace
 * 核账        GET  /api/report?workshop=xx
 * 通知        GET  /api/notifications
 * 健康        GET  /health
 */
export function createApp(store = new EventStore()) {
  const svc = new KilnService(store);

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/health') {
        return send(res, 200, { status: 'ok', eventVersion: store.version });
      }

      const body = await readJson(req);

      // ---- 注册 ----
      let m;
      if (req.method === 'POST' && p === '/api/units') {
        return send(res, 201, svc.register(body));
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/units\/([^/]+)\/drying$/))) {
        return send(res, 200, svc.recordDrying(m[1], body));
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/batches\/([^/]+)\/split$/))) {
        return send(res, 201, svc.splitBatch({ parentBatchId: m[1], parts: body.parts }));
      }
      // ---- 窑炉 ----
      if (req.method === 'POST' && (m = p.match(/^\/api\/kilns\/([^/]+)\/firings$/))) {
        return send(res, 201, svc.startFiring({ kilnId: m[1], ...body }));
      }
      if (m = p.match(/^\/api\/kilns\/([^/]+)\/firings\/([^/]+)\/(interrupt|resume|unfreeze|unload)$/)) {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const [, kilnId, firingId, action] = m;
        if (action === 'interrupt') return send(res, 200, svc.interrupt({ kilnId, firingId, ...body }));
        if (action === 'resume') return send(res, 200, svc.resume({ kilnId, firingId }));
        if (action === 'unfreeze') return send(res, 200, svc.unfreeze({ kilnId, firingId, ...body }));
        return send(res, 200, svc.unload({ kilnId, firingId }));
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/kilns\/([^/]+)\/firings\/([^/]+)\/readings$/))) {
        const r = svc.ingestReading({ kilnId: m[1], firingId: m[2], ...body });
        return send(res, r.duplicate ? 200 : 201, r);
      }
      // ---- 检查 / 抽检 ----
      if (req.method === 'POST' && (m = p.match(/^\/api\/units\/([^/]+)\/inspect$/))) {
        return send(res, 201, svc.inspect({ itemId: m[1], ...body }));
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/batches\/([^/]+)\/sample-check$/))) {
        return send(res, 201, svc.sampleCheck({ batchId: m[1], ...body }));
      }
      // ---- 查询 ----
      if (req.method === 'GET' && (m = p.match(/^\/api\/units\/([^/]+)\/trace$/))) {
        return send(res, 200, svc.trace(m[1]));
      }
      if (req.method === 'GET' && p === '/api/report') {
        return send(res, 200, svc.report({ workshop: url.searchParams.get('workshop') || undefined }));
      }
      if (req.method === 'GET' && p === '/api/notifications') {
        return send(res, 200, { notifications: svc.notifications() });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof DomainError) return send(res, err.status, { error: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { error: '请求体不是合法 JSON' });
      return send(res, 500, { error: err.message });
    }
  });

  server.on('close', () => {});
  return { server, svc };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new SyntaxError('body too large'));
    });
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    req.on('error', reject);
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const store = new EventStore(process.env.DATA_FILE || 'data/events.jsonl');
  const { server } = createApp(store);
  server.listen(process.env.PORT || 3000, () => {
    console.log(`泥塑干燥烧制追踪服务已启动，端口 ${process.env.PORT || 3000}，事件版本 ${store.version}`);
  });
}
