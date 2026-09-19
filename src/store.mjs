// 事件溯源存储：事件只追加、不修改。重启时重放整条日志重建状态。
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, applyEvent } from './domain.mjs';

export class EventStore {
  constructor(dir, state) {
    this.dir = dir;
    this.state = state;
  }

  static load(dir) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'events.log');
    const state = createInitialState();
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line);
        state.seq = e.seq;
        applyEvent(state, e);
      }
    }
    return new EventStore(dir, state);
  }

  // 一个命令产生的事件原子顺序落盘；seq 单调递增。
  commit(events) {
    const now = new Date().toISOString();
    const lines = [];
    for (const e of events) {
      this.state.seq += 1;
      e.seq = this.state.seq;
      e.id = e.id || `evt_${this.state.seq}`;
      e.at = e.at || now;
      lines.push(JSON.stringify(e));
      applyEvent(this.state, e);
    }
    appendFileSync(join(this.dir, 'events.log'), lines.join('\n') + '\n');
    return events;
  }
}
