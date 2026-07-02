import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Mapping } from '../types';

export interface MatchResult {
  mapping: Mapping;
  /** 剥离前缀后的剩余路径 */
  rest: string;
}

/** 在启用的映射中按“最长前缀”匹配请求路径（按路径段边界匹配） */
export function matchMapping(pathname: string, mappings: readonly Mapping[]): MatchResult | null {
  const candidates = mappings
    .filter((m) => m.enabled)
    .slice()
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const m of candidates) {
    const prefix = m.prefix;
    // 根映射 `/` 匹配任意路径；rest 保留完整路径，便于拼接到 target
    if (prefix === '/') {
      return { mapping: m, rest: pathname };
    }
    // 按路径段边界匹配，避免 /api 误命中 /apix
    if (pathname === prefix || (pathname.startsWith(prefix) && pathname[prefix.length] === '/')) {
      return { mapping: m, rest: pathname.slice(prefix.length) };
    }
  }
  return null;
}

// 转发时需要剔除的请求头（hop-by-hop / 与代理自身冲突 / 泄露会话）
const STRIP_REQ_HEADERS = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'host',
]);
// 响应头中由 Node 重新计算的传输层头
const STRIP_RES_HEADERS = new Set(['content-length', 'transfer-encoding']);
// Node fetch (undici) 会自动解压这些编码；解压后响应体已是明文，必须丢弃 Content-Encoding 头，
// 否则浏览器按压缩解码会报 ERR_CONTENT_DECODING_FAILED
const AUTO_DECOMPRESSED = new Set(['gzip', 'deflate', 'br']);

export interface ForwardOutcome {
  status: number;
  bytes: number;
  /** 实际转发目标 URL */
  targetUrl: string;
  /** 响应类型：stream / buffer */
  streamType: string;
}

/** 根据响应判定是否流式：SSE（text/event-stream）或无 Content-Length 的分块响应视为流式 */
function classifyStream(upstream: Response): string {
  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'stream';
  const noBody = upstream.status === 204 || upstream.status === 304;
  if (!noBody && upstream.headers.get('content-length') == null) return 'stream'; // chunked
  return 'buffer';
}

/**
 * 将请求按映射规则转发到目标地址，并把响应流式回传。
 * 成功/失败均会结束 res。
 */
export async function proxyForward(
  req: IncomingMessage,
  res: ServerResponse,
  match: MatchResult,
  search: string
): Promise<ForwardOutcome> {
  // ws/wss 与 http/https 等价（仅区分是否 TLS）：HTTP 转发时归一化为 http/https 以便 fetch
  const base = match.mapping.target
    .replace(/\/+$/, '')
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');
  const targetUrl = base + match.rest + (search || '');

  // 构造转发请求头
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (STRIP_REQ_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }
  // 移除本服务的会话 Cookie，避免泄露到上游
  const cookie = headers.get('cookie');
  if (cookie) {
    const filtered = cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => !c.startsWith('fp_session='))
      .join('; ');
    if (filtered) headers.set('cookie', filtered);
    else headers.delete('cookie');
  }
  // 改写 Host 为目标主机
  try {
    headers.set('host', new URL(targetUrl).host);
  } catch {
    /* ignore */
  }

  const method = req.method || 'GET';
  const init: Record<string, unknown> = {
    method,
    headers,
    redirect: 'manual',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    // 以流式转发请求体
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init as RequestInit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const body = `代理转发失败：${msg}`;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
    } else {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
    return { status: 502, bytes: Buffer.byteLength(body), targetUrl, streamType: 'buffer' };
  }

  // 判定响应是否流式
  const streamType = classifyStream(upstream);

  // 复制响应头
  const respHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const lk = key.toLowerCase();
    if (STRIP_RES_HEADERS.has(lk)) continue;
    // undici 已自动解压的编码：丢弃 Content-Encoding，保持「明文体 + 无编码头」一致
    if (lk === 'content-encoding' && AUTO_DECOMPRESSED.has(value.toLowerCase().trim())) continue;
    respHeaders.set(key, value);
  }

  if (!res.headersSent) {
    res.writeHead(upstream.status, Object.fromEntries(respHeaders.entries()));
  }

  if (!upstream.body) {
    res.end();
    return { status: upstream.status, bytes: 0, targetUrl, streamType };
  }

  // 流式回传响应体
  const nodeStream = Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream<Uint8Array>);
  let bytes = 0;
  nodeStream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });

  return new Promise<ForwardOutcome>((resolve) => {
    nodeStream.on('end', () => {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      resolve({ status: upstream.status, bytes, targetUrl, streamType });
    });
    nodeStream.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      resolve({ status: upstream.status, bytes, targetUrl, streamType });
    });
    nodeStream.pipe(res, { end: false });
  });
}
