import net from 'net';
import tls from 'tls';
import type { IncomingMessage } from 'http';
import type { ConfigStore } from '../store/config';
import type { AccessLogger } from '../logger/access';
import { formatLocalTime } from '../logger/access';
import { IpWhitelist } from '../whitelist';
import { matchMapping } from './engine';
import { getClientIp } from '../server/ip';

export interface UpgradeDeps {
  store: ConfigStore;
  logger: AccessLogger;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 创建 WebSocket 升级处理器（透明反向代理）。
 * 思路：按映射前缀匹配后，连接到目标（http→ws、https→wss），
 * 把客户端的 WS 握手请求透传给目标，再把目标的 101 响应回给客户端，
 * 随后两个裸 socket 双向透传（WS 帧不解析，天然透明）。
 */
export function createUpgradeHandler(deps: UpgradeDeps) {
  const { store, logger } = deps;

  return (req: IncomingMessage, socket: net.Socket, head: Buffer): void => {
    const start = Date.now();
    let logged = false;
    let upgraded = false;
    let cleaned = false;
    let mapping = '-';
    let targetUrl = '';

    const clientIp = getClientIp(req, store);
    const ua = (req.headers['user-agent'] as string) || '';

    // 防止客户端 socket 的未处理 'error' 导致进程崩溃（升级连接随时可能 error，且早返回路径也要兜底）
    socket.on('error', () => {
      /* swallow */
    });

    let pathname = '/';
    let search = '';
    try {
      const u = new URL(req.url || '/', 'http://localhost');
      pathname = u.pathname;
      search = u.search;
    } catch {
      /* ignore */
    }
    const adminPrefix = '/' + store.adminToken;
    const isAdminArea = pathname === adminPrefix || pathname.startsWith(adminPrefix + '/');

    const logOnce = (status: number) => {
      if (logged || isAdminArea) return;
      logged = true;
      logger.log({
        time: formatLocalTime(new Date()),
        ip: clientIp,
        method: req.method || 'GET',
        path: req.url || '/',
        status,
        elapsedMs: Date.now() - start,
        mapping,
        target: targetUrl,
        userAgent: ua,
        bytes: 0,
        streamType: 'stream',
      });
    };

    const closeClient = (status: number, reason: string) => {
      if (cleaned) return;
      cleaned = true;
      try {
        socket.write(
          `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(
            reason
          )}\r\n\r\n${reason}`
        );
        socket.end();
      } catch {
        /* ignore */
      }
      logOnce(status);
    };

    // IP 白名单
    const whitelist = new IpWhitelist(store.whitelistSpec);
    if (!whitelist.allows(clientIp)) {
      closeClient(403, 'Forbidden');
      return;
    }

    // 匹配映射
    const match = matchMapping(pathname, store.mappings);
    if (!match) {
      closeClient(404, 'Not Found');
      return;
    }
    mapping = match.mapping.prefix;

    const base = match.mapping.target.replace(/\/+$/, '');
    targetUrl = base + match.rest + search;

    let targetUrlObj: URL;
    try {
      targetUrlObj = new URL(targetUrl);
    } catch {
      closeClient(502, 'Bad Target');
      return;
    }
    const isTls = targetUrlObj.protocol === 'https:' || targetUrlObj.protocol === 'wss:';
    const port = targetUrlObj.port ? parseInt(targetUrlObj.port, 10) : isTls ? 443 : 80;
    const reqPath = (targetUrlObj.pathname || '/') + (targetUrlObj.search || '');

    // 构造到目标的握手请求（透传原始头，仅改写 Host）
    let raw = `${req.method || 'GET'} ${reqPath} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (k.toLowerCase() === 'host') continue;
      raw += `${k}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += `Host: ${targetUrlObj.host}\r\n\r\n`;

    const target = isTls
      ? tls.connect({ host: targetUrlObj.hostname, port, servername: targetUrlObj.hostname })
      : net.connect({ host: targetUrlObj.hostname, port });

    let buf = Buffer.alloc(0);
    const handshakeTimer = setTimeout(() => {
      try {
        target.destroy();
      } catch {
        /* ignore */
      }
      closeClient(504, 'Gateway Timeout');
    }, 15000);

    target.on('error', () => {
      if (!upgraded) {
        clearTimeout(handshakeTimer);
        closeClient(502, 'WebSocket Upstream Error');
      } else {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    });

    target.on('close', () => {
      clearTimeout(handshakeTimer);
      try {
        socket.end();
      } catch {
        /* ignore */
      }
    });

    socket.on('error', () => {
      try {
        target.destroy();
      } catch {
        /* ignore */
      }
    });
    socket.on('close', () => {
      try {
        target.destroy();
      } catch {
        /* ignore */
      }
    });

    // 发送握手（写入会缓冲到连接建立后发出）
    target.write(raw);
    if (head && head.length) target.write(head);

    target.on('data', (chunk: Buffer) => {
      if (upgraded) {
        // 已升级：目标 → 客户端 透传
        try {
          if (!socket.destroyed) socket.write(chunk);
        } catch {
          /* ignore */
        }
        return;
      }

      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 65536) {
          clearTimeout(handshakeTimer);
          try {
            target.destroy();
          } catch {
            /* ignore */
          }
          closeClient(502, 'Upstream Handshake Too Large');
        }
        return;
      }

      const headerBlock = buf.subarray(0, idx + 4);
      const remainder = buf.subarray(idx + 4);
      const firstLine = headerBlock.toString('utf8').split('\r\n')[0];
      const status = parseInt(firstLine.split(' ')[1] || '0', 10);
      clearTimeout(handshakeTimer);

      // 把上游的握手响应（含可能的扩展头）原样回给客户端
      try {
        socket.write(headerBlock);
      } catch {
        /* ignore */
      }

      if (status !== 101) {
        // 非 101：回传错误响应后关闭
        try {
          if (remainder.length) socket.write(remainder);
          socket.end();
        } catch {
          /* ignore */
        }
        try {
          target.destroy();
        } catch {
          /* ignore */
        }
        logOnce(status || 502);
        return;
      }

      upgraded = true;
      try {
        if (remainder.length) socket.write(remainder);
      } catch {
        /* ignore */
      }
      logOnce(101);

      // 客户端 → 目标 透传（WS 客户端在收到 101 前不会发送帧）
      socket.on('data', (c: Buffer) => {
        try {
          if (!target.destroyed) target.write(c);
        } catch {
          /* ignore */
        }
      });
    });
  };
}
