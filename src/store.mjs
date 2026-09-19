import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 仅追加的事件存储。
 * - 落盘为 JSONL，每行一个事件；进程重启后重放即可恢复全部状态，
 *   因此尚未出窑的窑次在重新部署后仍可继续烧制。
 * - file 传 ':memory:' 时仅驻留内存（主要用于测试）。
 */
export class EventStore {
  constructor(file = process.env.DATA_FILE || 'data/events.jsonl') {
    this.file = file;
    this.events = [];
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) this.events.push(JSON.parse(line));
      }
    }
  }

  get version() {
    return this.events.length;
  }

  /** 追加事件；单条 write 由 O_APPEND 保证原子，避免行交错。 */
  append(events) {
    if (events.length === 0) return;
    for (const e of events) this.events.push(e);
    if (this.file !== ':memory:') {
      appendFileSync(this.file, events.map((e) => JSON.stringify(e) + '\n').join(''));
    }
  }
}
