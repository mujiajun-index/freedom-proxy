# Deno Deploy 部署指南

> 适用于**新版 Deno Deploy**（[console.deno.com](https://console.deno.com)）。旧版 Deploy Classic 已于 2026-07-20 停服，请勿使用。

本项目原生是 Node.js + TypeScript（编译为 CommonJS）。新版 Deno Deploy 的运行时是**标准 Deno 2.x**（隔离 Linux 沙箱），完整支持 `node:http` / `fs` / `path` / `crypto` / `net` / `tls` 等内置模块，因此本项目**无需改写业务代码**即可运行。

## 为什么能在 Deno Deploy 上跑

- 仓库根 `package.json` 已声明 `"type": "commonjs"`：Deno 据此把编译产物 `dist/**/*.js` 当 CommonJS 加载（提供 `exports`/`require`/`__dirname`/`module`），从而消除 `exports is not defined`。对 Node.js 是 no-op（Node 无 `type` 字段时本就按 CJS）。
- 新版 Deno Deploy 运行时会「等待 HTTP 服务启动后路由请求」，所以入口里的 `http.createServer(...).listen(port)` 直接生效，平台忽略具体端口号。
- `Buffer` / `process` / 全局 `fetch` 等 Node 全局均可用。

## 必需 / 推荐环境变量

新版 Deno Deploy 是 **Serverless**：无流量时实例停止，有请求才冷启动，**文件系统不跨实例持久化**。因此务必用环境变量固定以下凭据，否则每次冷启动会随机重置（管理地址变化、已登录会话失效）：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `ADMIN_USER` | 推荐 | 管理员账号，默认 `admin` |
| `ADMIN_PASSWORD` | **必需** | 管理员密码明文（启动时哈希）；不设则每次冷启动随机生成 |
| `SESSION_SECRET` | **必需** | 会话签名密钥；不设则每次冷启动重置，旧会话全部失效 |
| `ADMIN_TOKEN` | 推荐 | 管理后台地址前缀（如设为 `abc123`，则后台地址为 `/<域名>/abc123`）；不设则每次冷启动随机变化 |

> 以上变量均与 Node/Docker 部署通用，在 Deno Deploy 控制台 **Settings → Environment Variables** 中配置。

## 部署方式 A：GitHub 集成（推荐）

1. 在 [console.deno.com](https://console.deno.com) 新建项目，关联你的 GitHub 仓库。
2. 构建配置：
   - **Build Command**: `npm install && npm run build`
   - **Entrypoint**: `dist/server/index.js`
   - （构建在 Node 环境执行 `tsc`，产出 CJS 到 `dist/`；运行时用 Deno 加载该入口）
3. 在 **Environment Variables** 中填入上表变量。
4. 部署成功后，访问 `https://<你的项目>.deno.dev/<ADMIN_TOKEN>` 进入管理后台。

> ⚠️ 入口必须是 `dist/server/index.js`。若此前报错路径形如 `/app/src/dist/...`，说明入口或工作目录配错，请改为 `dist/server/index.js`。

## 部署方式 B：deployctl（本地构建后上传）

```bash
# 1. 本地构建（需本地有 Node）
npm install && npm run build

# 2. 安装 deployctl
deno install -gArf jsr:@deno/deployctl

# 3. 部署（显式包含 dist/，因其被 .gitignore 忽略）
deployctl deploy \
  --project=<你的项目名> \
  --entrypoint=dist/server/index.js \
  --include=dist
```

环境变量仍需在控制台配置（deployctl 不负责注入运行时环境变量）。

## 本地用 Deno 验证

```bash
npm run build
deno task start          # 等价于 deno run --allow-net --allow-read --allow-write --allow-env dist/server/index.js
```

能正常打印 `freedomProxy 已启动` 即说明 Deno 可加载运行。

## 已知限制（Serverless 环境）

- **数据非持久**：`config.json` 与访问日志写入的文件系统是临时的，**实例停止/冷启动后丢失**。在后台改的映射规则不会跨实例保留。若需持久化，应改为外部存储（如 Deno KV / 数据库），本项目当前未集成。
- **WebSocket 代理**：透明 WS 反代依赖裸 TCP socket（`net`/`tls` + `server.on('upgrade')`）。在 Deno Deploy 沙箱下**不一定可用**。HTTP 反向代理与管理后台功能正常；如需 WS，请在自托管 Docker 部署。
- **单实例语义**：Serverless 多实例下，后台修改的配置只对当前实例生效，不广播到其他实例。
