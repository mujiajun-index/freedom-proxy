import fs from 'fs';
import path from 'path';
import type { AccessLogConfig, AccessLogEntry } from '../types';

export interface LogQuery {
  limit?: number;
  ip?: string;
  path?: string;
  status?: string;
  mapping?: string;
  start?: string;
  end?: string;
  order?: 'asc' | 'desc';
}

export interface QueryResult {
  total: number;
  items: AccessLogEntry[];
}

export class AccessLogger {
  private readonly file: string;
  private cfg: AccessLogConfig;
  /** 自上次轮转以来的写入计数，用于节流保留期清理 */
  private writeCount = 0;

  constructor(cfg: AccessLogConfig, baseDir: string) {
    this.cfg = cfg;
    this.file = path.isAbsolute(cfg.file) ? cfg.file : path.resolve(baseDir, cfg.file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  get filePath(): string {
    return this.file;
  }

  /** 追加一条访问日志（异步、不阻塞请求） */
  log(entry: AccessLogEntry): void {
    if (!this.cfg.enabled) return;
    if (this.cfg.logProxyOnly && entry.mapping === '-') return;
    this.writeCount++;
    // 每 256 次写入检查一次轮转/清理，避免频繁 stat
    if (this.writeCount % 256 === 0) {
      this.maybeRotate();
    }
    fs.appendFile(this.file, JSON.stringify(entry) + '\n', (err) => {
      if (err) console.error('[accessLog] write error:', err.message);
    });
  }

  private sizeBytes(): number {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  private readLines(): string[] {
    try {
      const content = fs.readFileSync(this.file, 'utf8');
      if (!content) return [];
      return content.split('\n').filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /** 删除超过保留期的旧条目（原地重写当前文件） */
  private applyRetention(): void {
    const days = this.cfg.retentionDays;
    if (!days || days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const lines = this.readLines();
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AccessLogEntry;
        if (new Date(entry.time).getTime() < cutoff) {
          removed++;
          continue;
        }
      } catch {
        /* 损坏行直接丢弃 */
        removed++;
        continue;
      }
      kept.push(line);
    }
    if (removed > 0) {
      try {
        fs.writeFileSync(this.file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      } catch (err) {
        console.error('[accessLog] retention rewrite error:', (err as Error).message);
      }
    }
  }

  /** 达到上限则轮转：current→.1，.1→.2，…，删除超出 keepFiles 的 */
  private maybeRotate(): void {
    const maxBytes = this.cfg.maxFileMB * 1024 * 1024;
    if (this.sizeBytes() < maxBytes) return;
    this.applyRetention();
    if (this.sizeBytes() < maxBytes) return;

    const keep = Math.max(1, this.cfg.keepFiles);
    // 删除最旧的一份
    try {
      fs.rmSync(`${this.file}.${keep}`);
    } catch {
      /* 不存在则忽略 */
    }
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* ignore */
    }
  }

  private parseAll(): AccessLogEntry[] {
    return this.readLines()
      .map((l) => {
        try {
          return JSON.parse(l) as AccessLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AccessLogEntry => e !== null);
  }

  private applyFilter(items: AccessLogEntry[], q: LogQuery): AccessLogEntry[] {
    let out = items;
    if (q.ip) out = out.filter((e) => e.ip === q.ip || e.ip.includes(q.ip!));
    if (q.path) out = out.filter((e) => e.path.includes(q.path!));
    if (q.status) out = out.filter((e) => String(e.status) === String(q.status));
    if (q.mapping) out = out.filter((e) => e.mapping === q.mapping);
    if (q.start) {
      const s = new Date(q.start).getTime();
      if (!Number.isNaN(s)) out = out.filter((e) => new Date(e.time).getTime() >= s);
    }
    if (q.end) {
      const en = new Date(q.end).getTime();
      if (!Number.isNaN(en)) out = out.filter((e) => new Date(e.time).getTime() <= en);
    }
    const dir = q.order === 'asc' ? 1 : -1;
    out = out.slice().sort((a, b) => dir * (new Date(a.time).getTime() - new Date(b.time).getTime()));
    return out;
  }

  query(q: LogQuery): QueryResult {
    const items = this.applyFilter(this.parseAll(), q);
    const limit = Math.min(q.limit ?? 200, 1000);
    return { total: items.length, items: items.slice(0, limit) };
  }

  /** 导出（不限 limit，便于离线分析） */
  exportItems(q: LogQuery): AccessLogEntry[] {
    return this.applyFilter(this.parseAll(), q);
  }

  clear(): void {
    try {
      fs.writeFileSync(this.file, '', 'utf8');
    } catch (err) {
      console.error('[accessLog] clear error:', (err as Error).message);
    }
  }
}
