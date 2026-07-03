# FreedomProxy

> 一个 Web 化、可自由配置的代理转发服务。管理员登录后台即可配置「本地路径前缀 → 目标地址」的映射，访问 `/openai` 即代理到 `https://api.openai.com`。支持随机管理地址、IP 白名单，开箱即用的 Docker 部署。

## 它解决什么问题

当你有多个上游服务（OpenAI、内网 API、第三方接口……），希望统一从同一个域名、不同路径前缀访问，又不想每次改后端代码、不想把管理后台暴露在固定地址上时，freedomProxy 让你：

- 在网页后台「自由」增删改代理映射规则，**无需重启**即生效；
- 用一个**随机生成的管理地址**（类似宝塔面板的安全入口）访问后台，避免后台地址被扫描；
- 通过 **IP 白名单**限制只有指定 IP 才能访问；

## 核心特性

| 特性 | 说明 |
| --- | --- |
| 🔄 自由代理映射 | 配置「路径前缀 → 目标 URL」，如 `/openai` → `https://api.openai.com`，热生效 |
| 🔌 WebSocket 代理 | ws/wss 升级请求按前缀透明反向代理（握手透传 + 双向裸流，自动 http→ws / https→wss） |
| 🔐 管理员登录 | 账号 + 密码登录后台，密码哈希存储，会话鉴权 |
| 🎲 随机管理地址 | 首次启动随机生成（如 `/32dfa51e`），写入配置后**固定不变**，类似宝塔面板 |
| 🌐 IP 白名单 | 可选；配置后仅白名单内 IP 可访问，多个用 `;` 分隔，支持单 IP / CIDR |
| 📝 访问日志 | 记录访问 IP、地址、时间、命中映射、状态码、耗时等，独立日志文件，支持查询/筛选/清空 |
| 📦 JSON 持久化 | 映射规则与管理配置统一存于单个 `config.json`；访问日志单独存于 JSONL 日志文件 |
| 🐳 Docker 部署 | 提供开箱即用的 `Dockerfile` 与 `docker-compose.yaml`，镜像自包含，宿主机**无需安装 Node** |

## 技术栈

- **后端**：Node.js + TypeScript（原生 `http` / 轻量框架，负责代理引擎、后台 API、鉴权与白名单中间件）
- **前端**：原生 HTML / CSS / JavaScript（管理后台静态页面，无前端框架依赖）
- **存储**：JSON 配置文件（`config.json`）
- **部署**：Docker 容器化（推荐，自带 Node 20 运行时）；也支持 npm 直接运行（开发/本地）

> 本项目由 `main.ts`（Deno 单目标代理参考实现）演进而来，演进关系见 [架构设计](docs/01-架构设计.md#与-maintts-的演进对比)。

## 快速开始

### Docker（推荐）

仓库已含 `Dockerfile` 与 `docker-compose.yaml`，二选一即可。

**方式一：docker compose（最省事）**

```bash
docker compose up -d --build
```

**方式二：手动构建运行**

```bash
docker build -t freedomproxy:latest .

docker run --name freedomproxy -d --restart always \
  -p 3000:3000 \
  -e TZ=Asia/Shanghai \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=改成你的强密码 \
  -e TRUST_PROXY=false \
  -e CF_ENABLED=false \
  -v ./data:/app/data \
  freedomproxy:latest
```

常用配置项说明：

- `-p 3000:3000`：宿主机端口 → 容器 `3000`，改左边即可换对外端口；
- `-v ./data:/app/data`：持久化 `config.json` 与访问日志，**勿删**（换路径改左边）；
- `-e TZ=Asia/Shanghai`：访问日志按北京时间记录；
- `ADMIN_PASSWORD`：不设则首启随机生成，用 `docker logs freedomproxy` 查看打印的密码；
- `TRUST_PROXY`：服务直接对外暴露时设 `false`；若部署在反向代理之后，设为 `true` 并在后台「系统维护」开启「信任代理头」。

> 完整环境变量见 [配置说明](docs/03-配置说明.md)，部署细节见 [部署指南](docs/05-部署指南.md)。

### npm（本地开发）

需 Node.js ≥ 18：

```bash
npm install            # 安装依赖
npm run dev            # 开发模式（tsx 热重载），或：
npm run build && npm start   # 编译后运行（默认监听 3000）
```

### 使用流程

1. **获取随机管理地址**：首次启动会在控制台/日志打印形如 `管理后台地址: http://localhost:3000/32dfa51e` 的地址，该 token 已写入 `config.json`，之后固定。

   ```bash
   docker logs freedomproxy        # 首启日志里有「管理后台地址」和（未设密码时的）随机密码
   docker logs -f freedomproxy     # 实时日志
   ```

2. **登录后台**：访问该地址，使用管理员账号密码登录（账号密码见 [配置说明](docs/03-配置说明.md#管理员凭据)）。
3. **新增映射**：例如前缀 `/openai`、目标 `https://api.openai.com`，保存即生效。访问 `http://localhost:3000/openai/v1/...` 将被转发到 `https://api.openai.com/v1/...`。
4. **（可选）配置 IP 白名单**：在后台填写允许的 IP（`;` 分隔），保存后非白名单 IP 将被拒绝。详见 [使用手册](docs/06-使用手册.md)。

> 记得在服务器防火墙放行对外端口（默认 `3000`）。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [架构设计](docs/01-架构设计.md) | 整体架构、模块划分、目录结构、请求处理流程、与 main.ts 对比 |
| [功能说明](docs/02-功能说明.md) | 登录、代理映射 CRUD、随机管理地址、IP 白名单、访问日志 |
| [配置说明](docs/03-配置说明.md) | `config.json` 字段表、环境变量、IP 白名单语法 |
| [API 文档](docs/04-API文档.md) | 管理后台 API、代理转发行为约定 |
| [部署指南](docs/05-部署指南.md) | Docker 容器化部署、Node.js 运行、白名单落地、HTTPS |
| [使用手册](docs/06-使用手册.md) | 管理后台操作指引与常见排查 |

## 代理映射示例

```
访问：  http://你的域名/openai/v1/chat/completions
映射：  /openai  →  https://api.openai.com
转发到：https://api.openai.com/v1/chat/completions
```

前缀被剥离后拼接到目标 URL，请求方法、请求头、请求体与查询参数均透传，响应状态码、响应头与响应体原样回传。详见 [API 文档 · 代理转发行为](docs/04-API文档.md#代理转发行为约定)。

## 目录结构（建议）

```
freedomProxy/
├── README.md
├── Dockerfile                 # 容器镜像构建（构建期编译 TS + 打包静态资源）
├── docker-compose.yaml        # 一键编排（端口/环境变量/持久化卷）
├── docs/                      # 项目文档（本目录）
├── src/                       # TypeScript 源码
│   ├── server/                # HTTP 服务、路由分发
│   ├── proxy/                 # 代理引擎（匹配前缀、转发）
│   ├── auth/                  # 登录、会话、鉴权中间件
│   └── store/                 # config.json 读写
├── public/                    # 管理后台静态资源（HTML/CSS/JS）
├── config.json                # 配置与映射规则（运行时生成/维护）
└── main.ts                    # Deno 单目标代理参考实现（演进起点）
```

## 许可证

（由项目维护者补充）
