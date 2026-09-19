import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from './store.mjs';
import { createApp } from './app.mjs';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const PORT = process.env.PORT || 3000;

mkdirSync(DATA_DIR, { recursive: true });
const store = EventStore.load(DATA_DIR);

// 责任人通知：冻结等告警追加落盘，便于外部通知系统或人工领取。
const notifier = (notice) => {
  const line = JSON.stringify({ ...notice, deliveredAt: new Date().toISOString() });
  appendFileSync(join(DATA_DIR, 'notices.log'), line + '\n');
  console.error(`[notify] ${notice.severity} -> ${(notice.toOwnerIds || []).join(',') || '值班负责人'}：${notice.reason}`);
};

const server = createServer(createApp(store, { notifier }));

// 重新部署后续烧：未完成的窑炉批次已在事件日志中，重启后状态自动恢复，可继续 interrupt/resume/complete。
server.listen(PORT, () => {
  const running = [...store.state.kilnBatches.values()].filter((k) => k.status === 'running' || k.status === 'interrupted');
  console.log(`泥塑干燥烧制追踪服务已启动 :${PORT}，已重放 ${store.state.seq} 个事件，在烧/中断窑批 ${running.length} 个`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
