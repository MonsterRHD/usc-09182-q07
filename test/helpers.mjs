import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';

export async function startService() {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-'));
  const store = EventStore.load(dir);
  const notices = [];
  const server = createServer(createApp(store, { notifier: (n) => notices.push(n) }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    base,
    store,
    notices,
    reload: () => EventStore.load(dir),
    cmd: (type, payload, opts = {}) => cmd(base, type, payload, opts),
    get: (path) => fetch(base + path).then((r) => r.json().then((body) => ({ status: r.status, body }))),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function cmd(base, type, payload, { key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  const r = await fetch(base + '/v1/commands', {
    method: 'POST',
    headers,
    body: JSON.stringify({ type, payload }),
  });
  const body = await r.json();
  return { status: r.status, body };
}
