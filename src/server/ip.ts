import type { IncomingMessage } from 'http';
import type { ConfigStore } from '../store/config';
import { isDeno } from './runtime';

/** 去掉 IPv4 映射成 IPv6 的前缀（::ffff:1.2.3.4 -> 1.2.3.4），保证日志/白名单一致 */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * 是否为真实的客户端 IP。
 * Deno Deploy 上 socket.remoteAddress 是平台内部地址（如 `vsock:2`），unix 套接字、
 * 空值等也不是真实 IP，需过滤掉，避免污染日志与 IP 白名单判定。
 */
function isRealIp(ip: string): boolean {
  if (!ip) return false;
  return !/^(vsock|unix|fd|abstract):?/i.test(ip);
}

/** 取单个请求头的首个值（按逗号分隔并去空白），无则返回空串 */
function firstHeader(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return typeof v === 'string' && v ? v.split(',')[0].trim() : '';
}

/**
 * 解析「地址[:端口]」形式的客户端地址（如新版 Deno Deploy 的 `x-deno-client-address`）。
 * 支持 `[::ffff:1.2.3.4]:5678`、`1.2.3.4:5678`、`1.2.3.4`、`::ffff:1.2.3.4` 等，
 * 剥离端口与 IPv4 映射的 IPv6 前缀，返回纯 IP。
 */
function parseClientAddress(raw: string): string {
  let v = raw.trim();
  if (v.startsWith('[')) {
    // IPv6 形如 [addr]:port
    const end = v.indexOf(']');
    if (end > 0) v = v.slice(1, end);
  } else {
    // 形如 ipv4:port 时剥离端口（纯 IPv6 不带方括号、含多个冒号，不会误伤）
    const first = v.indexOf(':');
    const last = v.lastIndexOf(':');
    if (first === last && first > -1 && /^\d+$/.test(v.slice(last + 1))) {
      v = v.slice(0, last);
    }
  }
  return normalizeIp(v);
}

// ============ 诊断：DEBUG_CLIENT_IP=1 时打印前几个请求的全部头/socket，排查 IP 来源 ============
const DEBUG_IP = String(process.env.DEBUG_CLIENT_IP || '').toLowerCase() === 'true';
let debugLogged = 0;
function debugDump(req: IncomingMessage): void {
  if (!DEBUG_IP || debugLogged >= 3) return;
  debugLogged++;
  // eslint-disable-next-line no-console
  console.log(
    `[debug-client-ip] #${debugLogged} socket.remoteAddress=${req.socket?.remoteAddress} ` +
      `headers=${JSON.stringify(req.headers)}`
  );
}

/**
 * 解析客户端真实 IP。优先级：
 *   1. 开启 Cloudflare 时：CF-Connecting-IP（用户显式声明在 CF 之后，最准）
 *   2. Deno（含 Deploy）：平台权威头 x-deno-client-address（总在平台边缘之后，结构可信、不可伪造）
 *   3. trustProxy 时：X-Real-IP / X-Forwarded-For（Node 与自托管 Deno 在 nginx/反代之后用）
 *   4. 回退：socket.remoteAddress（Node 直连为真实 IP；Deno Deploy 下为内部 vsock，过滤后记 "-"）
 *
 * 安全：x-deno-client-address 仅在 isDeno 时采信——否则 Node 直连下客户端可伪造该头。
 */
export function getClientIp(req: IncomingMessage, store: ConfigStore): string {
  debugDump(req);

  if (store.cfEnabled) {
    const cf = firstHeader(req, 'cf-connecting-ip');
    if (cf) return normalizeIp(cf);
  }

  if (isDeno) {
    const deno = firstHeader(req, 'x-deno-client-address');
    if (deno) return parseClientAddress(deno);
  }

  if (store.trustProxy) {
    const xreal = firstHeader(req, 'x-real-ip');
    if (xreal) return normalizeIp(xreal);
    const xff = firstHeader(req, 'x-forwarded-for');
    if (xff) return normalizeIp(xff);
  }

  const sock = normalizeIp(req.socket.remoteAddress || '');
  return isRealIp(sock) ? sock : '-';
}
