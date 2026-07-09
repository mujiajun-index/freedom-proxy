import http from 'http';
import fs from 'fs';
import path from 'path';
import { initConfig, ConfigStore, FileConfigPersister, KvConfigPersister } from '../store/config';
import type { ConfigPersister } from '../store/config';
import { AccessLogger, FileLogBackend, KvBatchLogBackend } from '../logger/access';
import type { LogBackend } from '../logger/access';
import { createRequestHandler } from './router';
import { createUpgradeHandler } from '../proxy/websocket';
import { loadDotenv } from './env';
import { isDeno, getKv } from './runtime';

/**
 * 解析管理后台静态目录 public/。
 * 优先级：
 *   1. PUBLIC_DIR 环境变量（部署时显式指定绝对路径）
 *   2. dist/public（构建时由 scripts/copy-assets.cjs 拷贝进来，部署产物自包含）
 *   3. <项目根>/public（开发/源码目录布局）
 * 全部找不到时回退到首个候选并告警，避免静默 404。
 */
function resolvePublicDir(): string {
  const explicit = process.env.PUBLIC_DIR;
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) {
      console.warn(`⚠ PUBLIC_DIR 指定的目录不存在: ${p}`);
    }
    return p;
  }
  const candidates = [
    path.resolve(__dirname, '../public'), // dist/public（构建打包）
    path.resolve(__dirname, '../../public'), // 源码 public（开发）
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  console.warn(
    '⚠ 未找到管理后台静态目录 public/，访问管理后台将返回 404 Not Found。\n' +
      `  尝试过: ${candidates.join(' , ')}\n` +
      '  请将 public 目录放到正确位置，或设置 PUBLIC_DIR 环境变量指定其绝对路径。'
  );
  return candidates[0];
}

async function main(): Promise<void> {
  // 启动时加载 .env（项目根目录），真实环境变量优先
  loadDotenv(path.resolve(process.cwd(), '.env'));

  const configPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');
  const publicDir = resolvePublicDir();

  // 配置持久化后端：Deno（含 Deploy）用 KV；Node 用文件（保持原行为）
  let configPersister: ConfigPersister;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kvHandle: any = null;
  if (isDeno) {
    kvHandle = await getKv();
    configPersister = new KvConfigPersister(kvHandle);
  } else {
    configPersister = new FileConfigPersister(configPath);
  }

  const init = await initConfig(configPersister);
  const store = new ConfigStore(init, configPersister);

  // 日志后端：Deno 用批量 KV（额度友好）；Node 用文件（含轮转）
  const logBackend: LogBackend = isDeno
    ? new KvBatchLogBackend(kvHandle)
    : new FileLogBackend(store.accessLog, process.cwd());
  const logger = new AccessLogger(store.accessLog, logBackend);

  const handle = createRequestHandler({ store, logger, publicDir });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[server] unhandled error:', err);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        } else {
          res.destroy();
        }
      } catch {
        /* ignore */
      }
    });
  });

  // WebSocket 升级处理（按映射前缀透明反向代理）
  server.on('upgrade', createUpgradeHandler({ store, logger }));

  server.on('clientError', (err, socket) => {
    console.error('[server] clientError:', err.message);
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  server.listen(store.port, () => {
    const baseUrl = `http://localhost:${store.port}`;
    console.log('========================================');
    console.log(' freedomProxy 已启动');
    console.log('----------------------------------------');
    console.log(`  监听端口     : ${store.port}`);
    console.log(`  管理后台地址 : ${baseUrl}/${store.adminToken}`);
    if (init.firstRun) {
      console.log('----------------------------------------');
      console.log('  ⚠ 首次启动');
      console.log(`  管理员账号   : ${store.adminUser}`);
      if (init.generatedPassword) {
        console.log(`  随机生成密码 : ${init.generatedPassword}`);
        console.log('  （请妥善保存；可设置 ADMIN_PASSWORD 环境变量覆盖）');
      }
      console.log(`  配置已写入   : ${isDeno ? 'Deno KV (["config"])' : configPath}`);
    }
    console.log('----------------------------------------');
    console.log(`  访问日志     : ${logger.filePath}`);
    console.log(`  静态目录     : ${publicDir}`);
    console.log(`  CF  代理     : ${store.cfEnabled ? '开启' : '关闭'}`);
    console.log(`  Nginx 代理   : ${store.trustProxy ? '开启' : '关闭'}`);
    console.log('========================================');
  });
}

main().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
