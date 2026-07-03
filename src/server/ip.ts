import type { IncomingMessage } from 'http';
import type { ConfigStore } from '../store/config';

/** 去掉 IPv4 映射成 IPv6 的前缀（::ffff:1.2.3.4 -> 1.2.3.4），保证日志/白名单一致 */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** 取单个请求头的首个值（按逗号分隔并去空白），无则返回空串 */
function firstHeader(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return typeof v === 'string' && v ? v.split(',')[0].trim() : '';
}

/**
 * 解析客户端真实 IP。按 store 配置实时读取，运行时切换立即生效。优先级：
 *   1. 开启 Cloudflare 时：CF-Connecting-IP（取不到则继续回退）
 *   2. 信任代理头时：X-Real-IP / X-Forwarded-For
 *   3. 回退：socket.remoteAddress
 */
export function getClientIp(req: IncomingMessage, store: ConfigStore): string {
  if (store.cfEnabled) {
    const cf = firstHeader(req, 'cf-connecting-ip');
    if (cf) return normalizeIp(cf);
  }
  if (store.trustProxy) {
    const xreal = firstHeader(req, 'x-real-ip');
    if (xreal) return normalizeIp(xreal);
    const xff = firstHeader(req, 'x-forwarded-for');
    if (xff) return normalizeIp(xff);
  }
  return normalizeIp(req.socket.remoteAddress || '');
}
