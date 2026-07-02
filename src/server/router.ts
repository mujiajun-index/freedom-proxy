import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ConfigStore } from '../store/config';
import type { AccessLogger, LogQuery } from '../logger/access';
import { formatLocalTime } from '../logger/access';
import { IpWhitelist } from '../whitelist';
import { verifyPassword } from '../auth/password';
import { signSession, loginCookieHeader, logoutCookieHeader, SESSION_TTL_MS } from '../auth/session';
import { isAuthenticated } from '../auth/middleware';
import { matchMapping, proxyForward } from '../proxy/engine';

export interface HandlerDeps {
  store: ConfigStore;
  logger: AccessLogger;
  publicDir: string;
  trustProxy: boolean;
}

interface LogCtx {
  ip: string;
  method: string;
  path: string;
  status: number;
  mapping: string;
  target: string;
  userAgent: string;
  bytes: number;
  elapsedMs: number;
  proxied: boolean;
  /** 是否跳过访问日志记录（管理后台自身请求不记录） */
  skipLog: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xreal = req.headers['x-real-ip'];
    if (typeof xreal === 'string' && xreal) return xreal.split(',')[0].trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function respond(
  res: ServerResponse,
  ctx: LogCtx,
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>
): void {
  const body = JSON.stringify(obj);
  ctx.status = status;
  ctx.bytes = Buffer.byteLength(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) });
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildLogQuery(url: URL): LogQuery {
  const g = (k: string): string | undefined => url.searchParams.get(k) || undefined;
  const num = (k: string): number | undefined => {
    const raw = g(k);
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const orderRaw = g('order');
  return {
    page: num('page'),
    pageSize: num('pageSize'),
    ip: g('ip'),
    path: g('path'),
    status: g('status'),
    mapping: g('mapping'),
    start: g('start'),
    end: g('end'),
    order: orderRaw === 'asc' ? 'asc' : orderRaw === 'desc' ? 'desc' : undefined,
  };
}

/** 提供管理后台静态文件（relPath 形如 ''/'/'/'/style.css'） */
function serveStatic(
  res: ServerResponse,
  ctx: LogCtx,
  publicDir: string,
  relPath: string
): void {
  let p = relPath;
  if (p === '' || p === '/') p = '/index.html';
  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, '.' + p);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    const body = 'Forbidden';
    ctx.status = 403;
    ctx.bytes = body.length;
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
    return;
  }
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    ctx.status = 200;
    ctx.bytes = buf.length;
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    const body = 'Not Found';
    ctx.status = 404;
    ctx.bytes = body.length;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }
}

export function createRequestHandler(deps: HandlerDeps) {
  const { store, logger } = deps;

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: LogCtx,
    sub: string,
    method: string,
    url: URL
  ): Promise<void> {
    // 当前管理员/配置信息（供前端展示）
    if (sub === '/api/session' && method === 'GET') {
      return respond(res, ctx, 200, { ok: true, data: { user: store.adminUser } });
    }
    if (sub === '/api/config' && method === 'GET') {
      return respond(res, ctx, 200, {
        ok: true,
        data: {
          adminToken: store.adminToken,
          adminUser: store.adminUser,
          accessLog: store.accessLog,
        },
      });
    }

    // 映射 CRUD
    if (sub === '/api/mappings' && method === 'GET') {
      return respond(res, ctx, 200, { ok: true, data: store.listMappings() });
    }
    if (sub === '/api/mappings' && method === 'POST') {
      const body = await readJsonBody(req);
      const m = store.addMapping(body as { prefix: string; target: string; enabled?: boolean; note?: string });
      return respond(res, ctx, 201, { ok: true, data: m });
    }
    const idMatch = sub.match(/^\/api\/mappings\/([^/]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const m = store.updateMapping(id, body as { prefix: string; target: string; enabled?: boolean; note?: string });
        if (!m) return respond(res, ctx, 404, { ok: false, error: '映射不存在' });
        return respond(res, ctx, 200, { ok: true, data: m });
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        const m = store.patchMapping(id, body as { enabled?: boolean });
        if (!m) return respond(res, ctx, 404, { ok: false, error: '映射不存在' });
        return respond(res, ctx, 200, { ok: true, data: m });
      }
      if (method === 'DELETE') {
        const ok = store.deleteMapping(id);
        if (!ok) return respond(res, ctx, 404, { ok: false, error: '映射不存在' });
        return respond(res, ctx, 200, { ok: true });
      }
    }

    // IP 白名单
    if (sub === '/api/whitelist' && method === 'GET') {
      return respond(res, ctx, 200, { ok: true, data: { ipWhitelist: store.whitelistSpec } });
    }
    if (sub === '/api/whitelist' && method === 'PUT') {
      const body = await readJsonBody(req);
      const spec = String(body.ipWhitelist ?? '');
      const result = store.setWhitelist(spec);
      if (!result.ok) {
        return respond(res, ctx, 400, { ok: false, error: '无效的白名单条目: ' + result.errors.join('; ') });
      }
      return respond(res, ctx, 200, { ok: true, data: { ipWhitelist: store.whitelistSpec } });
    }

    // 连通性测试
    if (sub === '/api/test' && method === 'POST') {
      const body = await readJsonBody(req);
      const m = store.findMapping(String(body.id ?? ''));
      if (!m) return respond(res, ctx, 404, { ok: false, error: '映射不存在' });
      const probeMethod = String(body.method || 'HEAD').toUpperCase() === 'GET' ? 'GET' : 'HEAD';
      let probePath = String(body.path || '/');
      if (!probePath.startsWith('/')) probePath = '/' + probePath;
      const target = m.target.replace(/\/+$/, '') + probePath;
      const t0 = Date.now();
      try {
        const r = await fetch(target, { method: probeMethod, redirect: 'manual' });
        return respond(res, ctx, 200, {
          ok: true,
          data: { reachable: true, status: r.status, elapsedMs: Date.now() - t0, url: target },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return respond(res, ctx, 200, {
          ok: true,
          data: { reachable: false, elapsedMs: Date.now() - t0, url: target, error: msg },
        });
      }
    }

    // 访问日志
    if (sub === '/api/logs' && method === 'GET') {
      const result = logger.query(buildLogQuery(url));
      return respond(res, ctx, 200, { ok: true, data: result });
    }
    if (sub === '/api/logs' && method === 'DELETE') {
      logger.clear();
      return respond(res, ctx, 200, { ok: true, data: { cleared: true } });
    }
    if (sub === '/api/logs/export' && method === 'GET') {
      const items = logger.exportItems(buildLogQuery(url));
      const body = items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
      ctx.status = 200;
      ctx.bytes = Buffer.byteLength(body);
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': 'attachment; filename="access.jsonl"',
      });
      res.end(body);
      return;
    }

    return respond(res, ctx, 404, { ok: false, error: 'API 不存在' });
  }

  async function handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: LogCtx,
    url: URL,
    adminPrefix: string
  ): Promise<void> {
    const sub = url.pathname.slice(adminPrefix.length); // '', '/', '/api/...', '/style.css'
    const method = req.method || 'GET';

    // 访问 /{token}（无尾斜杠）时重定向到 /{token}/，确保页面内相对路径正确解析
    if (sub === '') {
      ctx.status = 302;
      ctx.bytes = 0;
      res.writeHead(302, { location: adminPrefix + '/' });
      res.end();
      return;
    }

    // 登录（无需鉴权）
    if (sub === '/api/login' && method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        return respond(res, ctx, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const user = String(body.username ?? '');
      const pw = String(body.password ?? '');
      if (user !== store.adminUser || !verifyPassword(pw, store.passwordHash)) {
        return respond(res, ctx, 401, { ok: false, error: '用户名或密码错误' });
      }
      const token = signSession({ user, exp: Date.now() + SESSION_TTL_MS }, store.sessionSecret);
      return respond(res, ctx, 200, { ok: true, data: { user } }, { 'set-cookie': loginCookieHeader(token) });
    }

    // 登出
    if (sub === '/api/logout' && method === 'POST') {
      return respond(res, ctx, 200, { ok: true }, { 'set-cookie': logoutCookieHeader() });
    }

    // 其余 API 需鉴权
    if (sub.startsWith('/api/')) {
      if (!isAuthenticated(req, store)) {
        return respond(res, ctx, 401, { ok: false, error: '未登录或会话已过期' });
      }
      try {
        await handleApi(req, res, ctx, sub, method, url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '请求处理出错';
        if (!res.headersSent) respond(res, ctx, 400, { ok: false, error: msg });
      }
      return;
    }

    // 管理后台静态资源
    serveStatic(res, ctx, deps.publicDir, sub);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const ctx: LogCtx = {
      ip: getClientIp(req, deps.trustProxy),
      method: req.method || 'GET',
      path: req.url || '/',
      status: 500,
      mapping: '-',
      target: '',
      userAgent: (req.headers['user-agent'] as string) || '',
      bytes: 0,
      elapsedMs: 0,
      proxied: false,
      skipLog: false,
    };

    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
      ctx.path = url.pathname + (url.search || '');
    } catch {
      const body = 'Bad Request';
      ctx.status = 400;
      ctx.bytes = body.length;
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }

    // 管理后台自身请求（页面 + 后台 API）不计入访问日志
    const adminPrefix = '/' + store.adminToken;
    const isAdminArea = url.pathname === adminPrefix || url.pathname.startsWith(adminPrefix + '/');
    if (isAdminArea) ctx.skipLog = true;

    try {
      // IP 白名单
      const whitelist = new IpWhitelist(store.whitelistSpec);
      if (!whitelist.allows(ctx.ip)) {
        respond(res, ctx, 403, { ok: false, error: 'IP 不在白名单' });
        return;
      }

      if (isAdminArea) {
        await handleAdmin(req, res, ctx, url, adminPrefix);
      } else {
        // 代理转发
        const match = matchMapping(url.pathname, store.mappings);
        if (!match) {
          const body = 'Not Found';
          ctx.status = 404;
          ctx.bytes = body.length;
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(body);
          return;
        }
        ctx.mapping = match.mapping.prefix;
        ctx.proxied = true;
        const outcome = await proxyForward(req, res, match, url.search);
        ctx.status = outcome.status;
        ctx.bytes = outcome.bytes;
        ctx.target = outcome.targetUrl;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal Error';
      if (!res.headersSent) respond(res, ctx, 500, { ok: false, error: msg });
    } finally {
      ctx.elapsedMs = Date.now() - start;
      // 非代理响应需排空未读请求体，避免影响 keep-alive 上的下一个请求
      if (!ctx.proxied) {
        try {
          req.resume();
        } catch {
          /* ignore */
        }
      }
      if (!ctx.skipLog) logger.log({
        time: formatLocalTime(new Date()),
        ip: ctx.ip,
        method: ctx.method,
        path: ctx.path,
        status: ctx.status,
        elapsedMs: ctx.elapsedMs,
        mapping: ctx.mapping,
        target: ctx.target,
        userAgent: ctx.userAgent,
        bytes: ctx.bytes,
      });
    }
  }

  return handle;
}
