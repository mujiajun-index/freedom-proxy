import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AccessLogConfig, AccessLogEntry } from '../types';
import { onShutdown } from '../server/runtime';

export interface LogQuery {
  page?: number;
  pageSize?: number;
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
  page: number;
  pageSize: number;
  items: AccessLogEntry[];
}

/** 本地时间格式：YYYY-MM-DD HH:mm:ss.SSS */
export function formatLocalTime(d: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 将日志时间字符串解析为毫秒时间戳。
 * 兼容本地格式 `YYYY-MM-DD HH:mm:ss.SSS`（按本地时区）与 ISO 字符串；解析失败返回 0。
 */
function parseLogTime(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s);
  if (m) {
    const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ============ 日志后端抽象：Node 走文件（含轮转），Deno 走批量 KV ============

/**
 * 访问日志存储后端。
 * append 为 fire-and-forget（不阻塞请求）；readAll/clear 为异步。
 */
export interface LogBackend {
  /** 追加一条日志（尽力而为，不抛错阻塞请求） */
  append(entry: AccessLogEntry): void;
  /** 读取全部日志（已解析），供查询/导出 */
  readAll(): Promise<AccessLogEntry[]>;
  /** 清空全部日志 */
  clear(): Promise<void>;
  /** 存储位置描述（用于启动 banner 展示） */
  readonly location: string;
}

/** 文件后端（Node/Docker）：严格复用原有 appendFile / 轮转 / 保留期逻辑 */
export class FileLogBackend implements LogBackend {
  private readonly file: string;
  private cfg: AccessLogConfig;
  /** 自上次轮转以来的写入计数，用于节流保留期清理 */
  private writeCount = 0;

  constructor(cfg: AccessLogConfig, baseDir: string) {
    this.cfg = cfg;
    this.file = path.isAbsolute(cfg.file) ? cfg.file : path.resolve(baseDir, cfg.file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  get location(): string {
    return this.file;
  }

  append(entry: AccessLogEntry): void {
    this.writeCount++;
    // 每 256 次写入检查一次轮转/清理，避免频繁 stat
    if (this.writeCount % 256 === 0) {
      this.maybeRotate();
    }
    fs.appendFile(this.file, JSON.stringify(entry) + '\n', (err) => {
      if (err) console.error('[accessLog] write error:', err.message);
    });
  }

  async readAll(): Promise<AccessLogEntry[]> {
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

  async clear(): Promise<void> {
    try {
      fs.writeFileSync(this.file, '', 'utf8');
    } catch (err) {
      console.error('[accessLog] clear error:', (err as Error).message);
    }
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
}

/** 批量阈值：缓冲达到该条数触发一次 KV 写 */
const FLUSH_COUNT = 50;
/** 定时刷新间隔（毫秒）：仅在缓冲非空时真正写入 */
const FLUSH_INTERVAL_MS = 20000;
/** KV 中日志批量的 key 前缀 */
const LOG_PREFIX = ['logs'];

/** Deno KV 批量后端：缓冲写 + 计数/定时/SIGINT 收尾，守在免费写额度内 */
export class KvBatchLogBackend implements LogBackend {
  private buffer: AccessLogEntry[] = [];
  private flushing = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private timer: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly kv: any) {
    // 定时刷新：缓冲非空时才真正落 KV（scheduleFlush 内判空）
    this.timer = setInterval(() => {
      this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
    // 关停收尾：借 SIGINT 的 5 秒窗口把残余缓冲刷入 KV
    onShutdown(() => this.scheduleFlush());
  }

  get location(): string {
    return '(Deno KV: logs, 批量)';
  }

  append(entry: AccessLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_COUNT) this.scheduleFlush();
  }

  /**
   * 触发一次刷新（fire-and-forget 安全）：快照并清空缓冲后写 KV。
   * 写失败时把快照放回缓冲头部，下次重试，避免丢日志。
   */
  scheduleFlush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return Promise.resolve();
    this.flushing = true;
    const snapshot = this.buffer;
    this.buffer = [];
    const key = [LOG_PREFIX[0], Date.now(), crypto.randomBytes(6).toString('hex')];
    return this.kv
      .set(key, snapshot)
      .catch((err: unknown) => {
        this.buffer = [...snapshot, ...this.buffer];
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[accessLog] KV flush error:', msg);
      })
      .finally(() => {
        this.flushing = false;
      });
  }

  async readAll(): Promise<AccessLogEntry[]> {
    // 先把当前缓冲并入，保证查询到最新未刷日志
    await this.scheduleFlush();
    const out: AccessLogEntry[] = [];
    for await (const entry of this.kv.list({ prefix: LOG_PREFIX })) {
      const batch = entry.value as AccessLogEntry[];
      if (Array.isArray(batch)) for (const l of batch) out.push(l);
    }
    return out;
  }

  async clear(): Promise<void> {
    this.buffer = [];
    for await (const entry of this.kv.list({ prefix: LOG_PREFIX })) {
      await this.kv.delete(entry.key);
    }
  }
}

/** 访问日志器：仅负责启用/过滤开关与查询/导出逻辑，I/O 委托给 backend */
export class AccessLogger {
  private cfg: AccessLogConfig;
  private backend: LogBackend;

  constructor(cfg: AccessLogConfig, backend: LogBackend) {
    this.cfg = cfg;
    this.backend = backend;
  }

  get filePath(): string {
    return this.backend.location;
  }

  /** 追加一条访问日志（异步、不阻塞请求） */
  log(entry: AccessLogEntry): void {
    if (!this.cfg.enabled) return;
    if (this.cfg.logProxyOnly && entry.mapping === '-') return;
    this.backend.append(entry);
  }

  private applyFilter(items: AccessLogEntry[], q: LogQuery): AccessLogEntry[] {
    let out = items;
    if (q.ip) out = out.filter((e) => e.ip === q.ip || e.ip.includes(q.ip!));
    if (q.path) out = out.filter((e) => e.path.includes(q.path!));
    if (q.status) out = out.filter((e) => String(e.status) === String(q.status));
    if (q.mapping) out = out.filter((e) => e.mapping === q.mapping);
    if (q.start) {
      const s = parseLogTime(q.start);
      out = out.filter((e) => parseLogTime(e.time) >= s);
    }
    if (q.end) {
      const en = parseLogTime(q.end);
      out = out.filter((e) => parseLogTime(e.time) <= en);
    }
    const dir = q.order === 'asc' ? 1 : -1;
    out = out.slice().sort((a, b) => dir * (parseLogTime(a.time) - parseLogTime(b.time)));
    return out;
  }

  async query(q: LogQuery): Promise<QueryResult> {
    const items = this.applyFilter(await this.backend.readAll(), q);
    const total = items.length;
    const pageSize = Math.min(Math.max(1, q.pageSize ?? 100), 1000);
    const page = Math.max(1, q.page ?? 1);
    const startIdx = (page - 1) * pageSize;
    return {
      total,
      page,
      pageSize,
      items: items.slice(startIdx, startIdx + pageSize),
    };
  }

  /** 导出（不限 limit，便于离线分析） */
  async exportItems(q: LogQuery): Promise<AccessLogEntry[]> {
    return this.applyFilter(await this.backend.readAll(), q);
  }

  async clear(): Promise<void> {
    await this.backend.clear();
  }
}
