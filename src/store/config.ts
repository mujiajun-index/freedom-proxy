import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Config, Mapping } from '../types';
import { hashPassword, generatePassword } from '../auth/password';
import { validateWhitelistSpec } from '../whitelist';

function randomToken(): string {
  return crypto.randomBytes(4).toString('hex'); // 8 位十六进制，如 32dfa51e
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function defaultConfig(): Config {
  return {
    adminToken: '',
    adminUser: process.env.ADMIN_USER || 'admin',
    adminPasswordHash: '',
    ipWhitelist: '',
    port: 3000,
    sessionSecret: '',
    accessLog: {
      enabled: true,
      file: 'logs/access.jsonl',
      logProxyOnly: false,
      maxFileMB: 100,
      keepFiles: 5,
      retentionDays: 30,
    },
    mappings: [],
  };
}

/** 原子写入 JSON 文件（先写临时文件再重命名） */
function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): Partial<Config> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export interface InitResult {
  config: Config;
  firstRun: boolean;
  /** 首启随机生成的密码明文（仅当未配置密码时），需打印一次 */
  generatedPassword?: string;
}

/** 初始化配置：加载或创建 config.json，应用环境变量覆盖 */
export function initConfig(filePath: string): InitResult {
  const base = defaultConfig();
  let firstRun = false;
  let cfg: Config;
  let generatedPassword: string | undefined;

  if (fs.existsSync(filePath)) {
    const raw = readJson(filePath);
    cfg = {
      ...base,
      ...raw,
      accessLog: { ...base.accessLog, ...(raw.accessLog || {}) },
      mappings: Array.isArray(raw.mappings) ? (raw.mappings as Mapping[]) : [],
    };
    if (!cfg.adminToken) {
      cfg.adminToken = randomToken();
      firstRun = true;
    }
    if (!cfg.sessionSecret) {
      cfg.sessionSecret = randomSecret();
      firstRun = true;
    }
  } else {
    firstRun = true;
    cfg = base;
    cfg.adminToken = randomToken();
    cfg.sessionSecret = randomSecret();
  }

  // 环境变量覆盖
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10) || cfg.port;
  if (process.env.ADMIN_USER) cfg.adminUser = process.env.ADMIN_USER;
  if (process.env.SESSION_SECRET) cfg.sessionSecret = process.env.SESSION_SECRET;
  if (process.env.ACCESS_LOG_PATH) cfg.accessLog.file = process.env.ACCESS_LOG_PATH;

  // 密码：env 明文优先（启动时哈希），否则用已存哈希，再否则首启随机生成
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw) {
    cfg.adminPasswordHash = hashPassword(envPw);
  } else if (!cfg.adminPasswordHash) {
    generatedPassword = generatePassword();
    cfg.adminPasswordHash = hashPassword(generatedPassword);
  }

  writeJsonAtomic(filePath, cfg);
  return { config: cfg, firstRun, generatedPassword };
}

export interface NewMappingInput {
  prefix: string;
  target: string;
  enabled?: boolean;
  note?: string;
}

/** 运行时配置存储：加载后内存缓存，变更时原子落盘 */
export class ConfigStore {
  private cfg: Config;
  private readonly filePath: string;

  constructor(init: InitResult, filePath: string) {
    this.cfg = init.config;
    this.filePath = filePath;
  }

  private persist(): void {
    writeJsonAtomic(this.filePath, this.cfg);
  }

  get all(): Config {
    return this.cfg;
  }
  get adminToken(): string {
    return this.cfg.adminToken;
  }
  get sessionSecret(): string {
    return this.cfg.sessionSecret;
  }
  get port(): number {
    return this.cfg.port;
  }
  get adminUser(): string {
    return this.cfg.adminUser;
  }
  get passwordHash(): string {
    return this.cfg.adminPasswordHash;
  }
  get whitelistSpec(): string {
    return this.cfg.ipWhitelist;
  }
  get mappings(): readonly Mapping[] {
    return this.cfg.mappings;
  }
  get accessLog() {
    return this.cfg.accessLog;
  }

  /** 校验并规范化前缀：确保以 / 开头、不以 / 结尾 */
  static normalizePrefix(prefix: string): string {
    let p = (prefix || '').trim();
    if (!p) throw new Error('prefix 不能为空');
    if (!p.startsWith('/')) p = '/' + p;
    while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  }

  static isValidTarget(target: string): boolean {
    try {
      const u = new URL(target);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  listMappings(): Mapping[] {
    return this.cfg.mappings.map((m) => ({ ...m }));
  }

  addMapping(input: NewMappingInput): Mapping {
    const prefix = ConfigStore.normalizePrefix(input.prefix);
    if (!ConfigStore.isValidTarget(input.target)) throw new Error('target 不是合法的 http(s) URL');
    if (this.cfg.mappings.some((m) => m.prefix === prefix)) {
      throw new Error(`前缀 ${prefix} 已存在`);
    }
    const mapping: Mapping = {
      id: `map_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      prefix,
      target: input.target.trim(),
      enabled: input.enabled !== false,
      note: input.note?.trim() || '',
    };
    this.cfg.mappings.push(mapping);
    this.persist();
    return { ...mapping };
  }

  updateMapping(id: string, input: NewMappingInput): Mapping | null {
    const idx = this.cfg.mappings.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const prefix = ConfigStore.normalizePrefix(input.prefix);
    if (!ConfigStore.isValidTarget(input.target)) throw new Error('target 不是合法的 http(s) URL');
    if (this.cfg.mappings.some((m) => m.prefix === prefix && m.id !== id)) {
      throw new Error(`前缀 ${prefix} 已存在`);
    }
    this.cfg.mappings[idx] = {
      ...this.cfg.mappings[idx],
      prefix,
      target: input.target.trim(),
      enabled: input.enabled !== false,
      note: input.note?.trim() || '',
    };
    this.persist();
    return { ...this.cfg.mappings[idx] };
  }

  patchMapping(id: string, patch: Partial<Pick<Mapping, 'enabled'>>): Mapping | null {
    const idx = this.cfg.mappings.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    if (typeof patch.enabled === 'boolean') this.cfg.mappings[idx].enabled = patch.enabled;
    this.persist();
    return { ...this.cfg.mappings[idx] };
  }

  deleteMapping(id: string): boolean {
    const before = this.cfg.mappings.length;
    this.cfg.mappings = this.cfg.mappings.filter((m) => m.id !== id);
    const changed = this.cfg.mappings.length !== before;
    if (changed) this.persist();
    return changed;
  }

  findMapping(id: string): Mapping | null {
    const m = this.cfg.mappings.find((x) => x.id === id);
    return m ? { ...m } : null;
  }

  setWhitelist(spec: string): { ok: true } | { ok: false; errors: string[] } {
    const result = validateWhitelistSpec(spec);
    if (!result.ok) return { ok: false, errors: result.errors };
    this.cfg.ipWhitelist = spec.trim();
    this.persist();
    return { ok: true };
  }
}
