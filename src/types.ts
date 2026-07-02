// 全局类型定义

/** 一条代理映射规则 */
export interface Mapping {
  /** 唯一标识 */
  id: string;
  /** 本地路径前缀，以 / 开头，不以 / 结尾 */
  prefix: string;
  /** 目标基础 URL，如 https://api.openai.com */
  target: string;
  /** 是否启用 */
  enabled: boolean;
  /** 备注 */
  note?: string;
}

/** 访问日志配置 */
export interface AccessLogConfig {
  /** 是否开启访问日志 */
  enabled: boolean;
  /** 日志文件路径（相对工作目录或绝对路径） */
  file: string;
  /** true=仅记录代理转发请求；false=记录全部请求 */
  logProxyOnly: boolean;
  /** 单文件大小上限（MB），达到后轮转 */
  maxFileMB: number;
  /** 保留的历史轮转文件数 */
  keepFiles: number;
  /** 日志保留天数，超期清理 */
  retentionDays: number;
}

/** 完整配置（config.json 结构） */
export interface Config {
  /** 管理后台地址 token，访问 /{adminToken} 进入后台 */
  adminToken: string;
  /** 管理员账号 */
  adminUser: string;
  /** 管理员密码哈希（scrypt$salt$hash） */
  adminPasswordHash: string;
  /** IP 白名单，; 分隔，支持单 IP / CIDR；空 = 不限制 */
  ipWhitelist: string;
  /** Node 服务监听端口 */
  port: number;
  /** 会话签名密钥 */
  sessionSecret: string;
  /** 访问日志配置 */
  accessLog: AccessLogConfig;
  /** 代理映射规则 */
  mappings: Mapping[];
}

/** 一条访问日志 */
export interface AccessLogEntry {
  /** 访问时间（ISO 8601） */
  time: string;
  /** 客户端 IP */
  ip: string;
  /** 请求方法 */
  method: string;
  /** 请求路径（含 query） */
  path: string;
  /** 响应状态码 */
  status: number;
  /** 处理耗时（毫秒） */
  elapsedMs: number;
  /** 命中的映射 prefix，未命中记 "-" */
  mapping: string;
  /** 实际转发的目标 URL，非代理请求为空 */
  target: string;
  /** 客户端 User-Agent */
  userAgent: string;
  /** 响应字节大小 */
  bytes: number;
}
