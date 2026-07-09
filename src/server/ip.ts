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
 * 解析客户端真实 IP。按 store 配置实时读取，运行时切换立即生效。优先级：
 *   1. 开启 Cloudflare 时：CF-Connecting-IP（取不到则继续回退）
 *   2. Deno（含 Deploy）：应用始终在平台边缘之后，socket.remoteAddress 是内部 vsock 地址，
 *      真实 IP 只能取自平台写入的转发头（结构上始终可信，无需用户开关）
 *   3. Node 信任代理头时：X-Real-IP / X-Forwarded-For
 *   4. 回退：socket.remoteAddress（Node 直连时为真实 IP；Deno 下为 vsock，过滤后记 "-"）
 */
export function getClientIp(req: IncomingMessage, store: ConfigStore): string {
  if (store.cfEnabled) {
    const cf = firstHeader(req, 'cf-connecting-ip');
    if (cf) return normalizeIp(cf);
  }

  if (isDeno) {
    // Deno Deploy：平台边缘唯一可信来源
    const xff = firstHeader(req, 'x-forwarded-for');
    if (xff) return normalizeIp(xff);
    const xreal = firstHeader(req, 'x-real-ip');
    if (xreal) return normalizeIp(xreal);
  } else if (store.trustProxy) {
    // Node：仅在声明信任反代时才取转发头
    const xreal = firstHeader(req, 'x-real-ip');
    if (xreal) return normalizeIp(xreal);
    const xff = firstHeader(req, 'x-forwarded-for');
    if (xff) return normalizeIp(xff);
  }

  const sock = normalizeIp(req.socket.remoteAddress || '');
  return isRealIp(sock) ? sock : '-';
}
