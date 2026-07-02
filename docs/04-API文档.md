# API 文档

本文档定义 freedomProxy 的两类接口：

1. **管理后台 API**：路径前缀为 `/{token}/api/*`，用于登录、映射 CRUD、白名单管理、连通性测试。除登录外均需会话鉴权。
2. **代理转发行为**：命中映射前缀的请求按约定转发，非 API、非后台路径。

> 下文示例中 `{token}` 即 [配置说明](03-配置说明.md#admintoken-管理后台地址) 中的 `adminToken`，例如 `32dfa51e`。

## 约定

- **Base URL**：`http(s)://你的域名`
- **请求体 / 响应体**：除登录外，后台 API 均使用 `application/json`。
- **统一错误格式**：
  ```json
  { "ok": false, "error": "错误描述" }
  ```
- **成功格式**：
  ```json
  { "ok": true, "data": { ... } }
  ```
- **鉴权**：除 `POST /{token}/api/login` 外，所有后台 API 请求须携带会话凭证（登录返回的 HttpOnly Cookie，或 `Authorization: Bearer <token>`，二选一由实现决定）。未鉴权返回 `401`。

---

## 一、认证

### 登录

`POST /{token}/api/login`

校验管理员账号密码，成功后下发会话凭证。

**请求体**
```json
{
  "username": "admin",
  "password": "你的明文密码"
}
```

**响应（成功，200）**
```json
{ "ok": true, "data": { "user": "admin" } }
```
并通过 `Set-Cookie` 下发会话（HttpOnly、SameSite、含有效期）。

**响应（失败，401）**
```json
{ "ok": false, "error": "用户名或密码错误" }
```

### 登出

`POST /{token}/api/logout`

销毁当前会话。

**响应（200）**
```json
{ "ok": true }
```

### 当前登录态

`GET /{token}/api/session`

返回当前会话信息，前端据此判断是否已登录。

**响应（200）**
```json
{ "ok": true, "data": { "user": "admin" } }
```

---

## 二、代理映射管理

### 获取映射列表

`GET /{token}/api/mappings`

**响应（200）**
```json
{
  "ok": true,
  "data": [
    {
      "id": "map_openai",
      "prefix": "/openai",
      "target": "https://api.openai.com",
      "enabled": true,
      "note": "OpenAI 官方接口"
    }
  ]
}
```

### 新增映射

`POST /{token}/api/mappings`

**请求体**
```json
{
  "prefix": "/claude",
  "target": "https://api.anthropic.com",
  "enabled": true,
  "note": "Anthropic 接口"
}
```

**响应（201）**：返回带服务端生成 `id` 的完整对象。
```json
{
  "ok": true,
  "data": {
    "id": "map_1719800000000",
    "prefix": "/claude",
    "target": "https://api.anthropic.com",
    "enabled": true,
    "note": "Anthropic 接口"
  }
}
```

**校验规则**
- `prefix` 必填，须以 `/` 开头，不能与已有 `prefix` 完全重复。
- `target` 必填，须为合法 URL（`http(s)://` 开头）。
- 校验失败返回 `400` 与错误描述。

### 更新映射

`PUT /{token}/api/mappings/{id}`

**请求体**：同新增（`id` 由路径指定，无需在体内）。

**响应（200）**：返回更新后的完整对象。不存在则 `404`。

### 删除映射

`DELETE /{token}/api/mappings/{id}`

**响应（200）**
```json
{ "ok": true }
```
不存在则 `404`。

### 启用 / 禁用映射

可通过 `PUT /{token}/api/mappings/{id}` 修改 `enabled` 字段实现；也可提供便捷接口：

`PATCH /{token}/api/mappings/{id}`
```json
{ "enabled": false }
```

---

## 三、IP 白名单

### 获取白名单

`GET /{token}/api/whitelist`

**响应（200）**
```json
{
  "ok": true,
  "data": { "ipWhitelist": "192.168.1.10;10.0.0.0/24" }
}
```

### 更新白名单

`PUT /{token}/api/whitelist`

**请求体**
```json
{ "ipWhitelist": "192.168.1.10;10.0.0.0/24;203.0.113.5" }
```

**响应（200）**
```json
{ "ok": true, "data": { "ipWhitelist": "192.168.1.10;10.0.0.0/24;203.0.113.5" } }
```

**校验规则**
- 多个条目以 `;` 分隔；支持单 IP 与 CIDR。
- 空字符串 `""` 合法，表示不限制。
- 任一条目格式非法返回 `400`，例如：
  ```json
  { "ok": false, "error": "无效的条目: 999.1.1.1" }
  ```
- 更新后**热生效**，无需重启。

> 注意：若把当前管理员自身 IP 误移出白名单，将导致立即无法访问。后台宜在保存前给出确认提示。详见 [使用手册 · 常见排查](06-使用手册.md#常见排查)。

---

## 四、连通性测试

### 测试单条映射

`POST /{token}/api/test`

对指定映射的 `target` 发起一次探测，返回可达性与耗时。

**请求体**
```json
{ "id": "map_openai", "method": "HEAD", "path": "/" }
```
- `id`：必填，要测试的映射。
- `method`：可选，默认 `HEAD`（目标不支持时可改 `GET`）。
- `path`：可选，附加到 `target` 的探测路径，默认 `/`。

**响应（200）**
```json
{
  "ok": true,
  "data": {
    "reachable": true,
    "status": 200,
    "elapsedMs": 142,
    "url": "https://api.openai.com/"
  }
}
```
- `reachable=false` 时附带 `error` 原因（DNS 失败、连接超时、TLS 错误等）。

---

## 五、代理转发行为约定

凡**未命中** `/{token}` 前缀、且**命中**某条启用映射 `prefix` 的请求，按以下规则转发：

### 1. 路径与查询

- 在所有启用映射中按**最长前缀**匹配请求路径。
- 命中后剥离 `prefix`，将剩余路径拼接到 `target`：
  ```
  prefix  = /openai
  target  = https://api.openai.com
  请求    = /openai/v1/chat?x=1
  转发到  = https://api.openai.com/v1/chat?x=1
  ```
- 原请求的 query string 原样附加。

### 2. 请求转发

- `method`：原样透传（GET/POST/PUT/DELETE/PATCH 等）。
- `headers`：原样透传，但**剔除/改写**以下与代理自身或目标冲突的项：
  - `Host`：改写为 `target` 的主机名（多数目标按 Host 路由）。
  - `Connection`、`Content-Length`：按流式传输需要由底层处理。
  - `Accept-Encoding`：可保留，由目标决定压缩；如需代理透传原始压缩字节，注意底层 fetch 可能自动解压。
- `body`：原样透传（流式，支持大文件/流式上传）。

### 3. 响应回传

- `status`、`statusText`：原样回传。
- `headers`：原样回传（可按需剔除 `Transfer-Encoding` 等传输层头）。
- `body`：流式回传，支持 SSE / 大响应体 / 流式下载。

### 4. 未命中与错误

- 请求路径未命中任何启用映射 → 返回提示信息或 `404`（不暴露后台）。
- 转发过程网络错误（DNS/连接/超时）→ 返回 `502` 并附简短错误说明，**不泄露内部堆栈**。
- 目标返回的错误响应（4xx/5xx）原样回传，不由代理改写。

---

## 六、访问日志

记录每次访问（IP、地址、时间、命中映射、状态码、耗时等），存于 `logs/access.jsonl`。字段与配置见 [功能说明 · 访问日志](02-功能说明.md#5-访问日志) 与 [配置说明 · accessLog](03-配置说明.md#accesslog-访问日志)。

### 查询日志

`GET /{token}/api/logs`

**查询参数（均可选）**

| 参数 | 说明 |
| --- | --- |
| `page` | 页码，1 基，默认 `1` |
| `pageSize` | 每页条数，默认 `100`，上限 `1000` |
| `ip` | 按客户端 IP 筛选 |
| `path` | 按请求路径模糊筛选 |
| `status` | 按状态码筛选，如 `502` |
| `mapping` | 按命中的映射 prefix 筛选 |
| `start` / `end` | 时间区间（`YYYY-MM-DD HH:mm:ss.SSS` 或 ISO） |
| `order` | `desc`（默认，最新在前）/ `asc` |

**响应（200）**（`items` 每条包含全部字段，前端「详情」即展示这些）
```json
{
  "ok": true,
  "data": {
    "total": 1234,
    "page": 1,
    "pageSize": 100,
    "items": [
      {
        "time": "2026-07-02 10:15:30.154",
        "ip": "203.0.113.5",
        "method": "POST",
        "path": "/openai/v1/chat/completions",
        "status": 200,
        "elapsedMs": 318,
        "mapping": "/openai",
        "target": "https://api.openai.com/v1/chat/completions",
        "userAgent": "curl/8.0",
        "bytes": 1024,
        "streamType": "stream"
      }
    ]
  }
}
```

> `time` 为本地时间格式 `YYYY-MM-DD HH:mm:ss.SSS`；`total` 为筛选后的总条数，据此计算总页数。导出接口 `/api/logs/export` 忽略分页，返回全部筛选结果。

### 清空日志

`DELETE /{token}/api/logs`

清空当前日志文件（轮转产生的历史文件按 `keepFiles` / `retentionDays` 管理）。

**响应（200）**
```json
{ "ok": true, "data": { "cleared": true } }
```

### 导出日志（可选）

`GET /{token}/api/logs/export?format=jsonl`

按筛选条件导出日志，返回 `application/x-ndjson`（或 `csv`）文件流，便于离线分析。

---

## 七、状态码汇总

| 状态码 | 含义 |
| --- | --- |
| 200 / 201 | 成功 / 创建成功 |
| 400 | 请求参数或白名单格式非法 |
| 401 | 未登录或会话失效 |
| 403 | 命中 IP 白名单拒绝 |
| 404 | 资源（映射）不存在，或代理路径未命中 |
| 502 | 代理转发时上游网络错误 |

## 八、相关文档

- 配置字段：[03-配置说明](03-配置说明.md)
- 功能背景：[02-功能说明](02-功能说明.md)
- 操作流程：[06-使用手册](06-使用手册.md)
