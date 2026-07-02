import http from 'http';
import path from 'path';
import { initConfig, ConfigStore } from '../store/config';
import { AccessLogger } from '../logger/access';
import { createRequestHandler } from './router';
import { createUpgradeHandler } from '../proxy/websocket';
import { loadDotenv } from './env';

function truthy(v: string | undefined): boolean {
  return String(v || '').toLowerCase() === 'true';
}

function main(): void {
  // 启动时加载 .env（项目根目录），真实环境变量优先
  loadDotenv(path.resolve(process.cwd(), '.env'));

  const configPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');
  const publicDir = path.resolve(__dirname, '../../public');
  const trustProxy = truthy(process.env.TRUST_PROXY);

  const init = initConfig(configPath);
  const store = new ConfigStore(init, configPath);
  const logger = new AccessLogger(store.accessLog, process.cwd());

  const handle = createRequestHandler({ store, logger, publicDir, trustProxy });

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
  server.on('upgrade', createUpgradeHandler({ store, logger, trustProxy }));

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
      console.log(`  配置已写入   : ${configPath}`);
    }
    console.log('----------------------------------------');
    console.log(`  访问日志     : ${logger.filePath}`);
    console.log(`  信任代理头   : ${trustProxy}`);
    console.log('========================================');
  });
}

main();
