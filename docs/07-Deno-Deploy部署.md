# Deno Deploy 部署指南

> 适用于**新版 Deno Deploy**（[console.deno.com](https://console.deno.com)）。旧版 Deploy Classic 已于 2026-07-20 停服，请勿使用。

本项目原生是 Node.js + TypeScript（编译为 CommonJS）。新版 Deno Deploy 的运行时是**标准 Deno 2.x**（隔离 Linux 沙箱），完整支持 `node:http` / `fs` / `path` / `crypto` / `net` / `tls` 等内置模块，因此本项目**无需改写业务代码**即可运行；并通过 **Deno KV** 实现配置与访问日志的跨实例持久化。

## 为什么能在 Deno Deploy 上跑

- 仓库根 `package.json` 已声明 `"type": "commonjs"`：Deno 据此把编译产物 `dist/**/*.js` 当 CommonJS 加载（提供 `exports`/`require`/`__dirname`/`module`），消除 `exports is not defined`。对 Node.js 是 no-op。
- 新版 Deno Deploy 运行时会「等待 HTTP 服务启动后路由请求」，入口里的 `http.createServer(...).listen(port)` 直接生效，平台忽略具体端口号。
- `Buffer` / `process` / 全局 `fetch` 等 Node 全局均可用。

## 持久化：Deno KV（配置 + 访问日志）

Serverless 实例空闲即停、冷启动开新沙箱，本地文件系统**不跨实例持久**。本项目用 **Deno KV** 解决：

- **配置**（映射规则、管理设置、adminToken/密码哈希/会话密钥）：存单键 `["config"]`，冷启动后读回 → 后台改的映射**不再丢失**。
- **访问日志**：**批量写** KV（缓冲满 50 条或每 20 秒刷新一次），并借 Deno Deploy 停机前的 **SIGINT 5 秒窗口**做最后一次刷盘，把残余日志落库。额度友好（见下）。
- 代码内 `Deno.openKv()` 自动连到本项目关联的 KV，无需连接 URL/token。
- Node/Docker 仍走原文件存储（`config.json` + `logs/access.jsonl`，含轮转），**完全不变**。

**KV 免费额度参考**：存储 1 GiB；读 ≈ 1.5 万次/天；写 ≈ 1 万次/天；仅 1 主区域。
- 配置：仅冷启动读 1 次 + 改配置写 1 次，远在额度内。
- 日志：批量写后，1.5 万请求/天 ≈ 几百次写/天，安全。可在控制台 Databases 查看用量。

## 客户端 IP（Deno Deploy）

Deno Deploy 的边缘通过 vsock 转发流量，`req.socket.remoteAddress` 拿到的是内部地址（如 `vsock:2`），**不是真实客户端 IP**。新版 Deno Deploy 把真实客户端 IP 放在 **`x-deno-client-address`** 头（值形如 `[::ffff:1.2.3.4]:5678`），本项目会自动解析该头得到真实 IP，用于访问日志与 IP 白名单。优先级：

1. 开启 Cloudflare（后台「系统维护」）→ `CF-Connecting-IP`（若你在 CF 之后，最准）
2. Deno 平台头 → `x-deno-client-address`（直连 Deno Deploy 时的真实客户端，仅 `isDeno` 时采信，防伪造）
3. `trustProxy` 时 → `X-Real-IP` / `X-Forwarded-For`（Node 与自托管 Deno 在 nginx/反代之后用，需到后台开启「信任代理头」）

> 排查 IP 异常时，可临时设置环境变量 `DEBUG_CLIENT_IP=true`，启动后前 3 个请求会打印全部请求头到日志，便于确认平台实际提供的内容。

## 第一步：创建并关联 KV 数据库（必需）

代码第一次调用 `Deno.openKv()` 前，必须先在控制台为本项目开通 KV，否则启动会失败并打印指引。

1. 进入 [console.deno.com](https://console.deno.com) → 你的项目。
2. 打开 **Databases**（数据库）→ 新建一个 **KV** 数据库。
3. 把该数据库**关联/绑定**到本项目（Attach/Link）。
4. 重新部署。代码内 `Deno.openKv()` 即自动连接。

## 环境变量（均为可选覆盖）

由于配置已持久化到 KV，**首启随机生成的** adminToken / 管理员密码 / 会话密钥**会跨冷启动保留**，无需手动固定。下列变量仅在你想要**显式覆盖**时设置（在 **Settings → Environment Variables**）：

| 变量 | 说明 |
| --- | --- |
| `ADMIN_USER` | 管理员账号，默认 `admin` |
| `ADMIN_PASSWORD` | 管理员密码明文（启动时哈希）；设置后每次启动以它为准 |
| `SESSION_SECRET` | 会话签名密钥；设置后固定，否则用 KV 中持久化的值 |
| `ADMIN_TOKEN` | 管理后台地址前缀（如 `abc123` → `/<域名>/abc123`）；设置后固定 |

> **首次部署如何拿到登录凭据**：不设上述变量时，首启会随机生成并在部署日志（控制台 **Logs/Console**）打印「随机生成密码」与「管理后台地址」，随后写入 KV 持久化。后续冷启动沿用同一套凭据。

## 部署方式 A：GitHub 集成（推荐）

1. 在 [console.deno.com](https://console.deno.com) 新建项目，关联你的 GitHub 仓库。
2. 构建配置：
   - **Build Command**: `npm install && npm run build`
   - **Entrypoint**: `dist/server/index.js`
   - （构建在 Node 环境执行 `tsc`，产出 CJS 到 `dist/`；运行时用 Deno 加载该入口）
3. 按「第一步」创建并关联 KV 数据库。
4. （可选）在 **Environment Variables** 填入上表变量。
5. 部署成功后，访问 `https://<你的项目>.deno.dev/<ADMIN_TOKEN>` 进入管理后台。

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

KV 数据库仍需在控制台先行创建并关联（同「第一步」）。

## 本地用 Deno 验证

```bash
npm run build
deno task start          # 含 --unstable-kv，本地 KV 用内存/本地存储
```

能正常打印 `freedomProxy 已启动` 即说明 Deno 可加载运行；`Ctrl+C` 会触发 SIGINT 把缓冲日志刷入本地 KV。

## 已知限制（Serverless 环境）

- **多实例最终一致**：多实例并发改配置存在极小竞态；单管理员场景可忽略。一个实例写入的配置/日志，其他实例读取时为最终一致（通常亚秒级）。
- **日志极端丢失**：实例被 `SIGKILL`（硬错误/超 5 秒）时可能丢最后一批未刷日志（≤50 条或 ≤20 秒流量），与文件 append 缓冲同等量级。
- **日志无上限**：长期累积会使日志查询变慢；可在后台「访问日志」手动清理。
- **WebSocket 代理**：透明 WS 反代依赖裸 TCP socket（`net`/`tls` + `server.on('upgrade')`），在 Deno Deploy 沙箱下**不一定可用**。HTTP 反向代理与管理后台正常；如需 WS，请在自托管 Docker 部署。
