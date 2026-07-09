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

// ============ 诊断：DEBUG_CLIENT_IP=1 时打印前几个请求的全部头/socket，用于确认 Deno Deploy 实际提供的客户端 IP 来源 ============
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
 *   1. 开启 Cloudflare 时：CF-Connecting-IP（取不到则继续回退）
 *   2. Deno（含 Deploy）：依次尝试平台/反代写入的头（Fly-Client-IP / True-Client-IP / X-Real-IP / X-Forwarded-For）；
 *      注意——新版 Deno Deploy 实测可能不写任何头，真实 IP 仅存在于 Deno.serve 的 info.remoteAddr
 *      （node:http 拿不到）。此时会回退到 socket 并被过滤为 "-"。
 *   3. Node 信任代理头时：X-Real-IP / X-Forwarded-For
 *   4. 回退：socket.remoteAddress（Node 直连为真实 IP；Deno 下为 vsock，过滤后记 "-"）
 */
export function getClientIp(req: IncomingMessage, store: ConfigStore): string {
  debugDump(req);

  if (store.cfEnabled) {
    const cf = firstHeader(req, 'cf-connecting-ip');
    if (cf) return normalizeIp(cf);
  }

  if (isDeno) {
    // 平台/反代专属头优先（Fly-Client-IP 不可伪造、最准），再退通用转发头
    const candidates = ['fly-client-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for'];
    for (const h of candidates) {
      const v = firstHeader(req, h);
      if (v) return normalizeIp(v);
    }
  } else if (store.trustProxy) {
    const xreal = firstHeader(req, 'x-real-ip');
    if (xreal) return normalizeIp(xreal);
    const xff = firstHeader(req, 'x-forwarded-for');
    if (xff) return normalizeIp(xff);
  }

  const sock = normalizeIp(req.socket.remoteAddress || '');
  return isRealIp(sock) ? sock : '-';
}
