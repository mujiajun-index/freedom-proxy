import { BlockList } from 'net';

// 基于 Node 内置 net.BlockList 实现 IP 白名单（支持单 IP 与 CIDR，IPv4/IPv6）。
// 使用方式：把“允许”的地址/网段加入列表，check() 为 true 表示命中（即放行）。

export interface WhitelistParseResult {
  ok: boolean;
  errors: string[]; // 解析失败的条目
}

export class IpWhitelist {
  private list: BlockList;
  /** 是否启用（spec 为空时不启用，表示不限制） */
  readonly enabled: boolean;

  constructor(spec: string) {
    this.list = new BlockList();
    this.enabled = !!spec && spec.trim().length > 0;
    if (!this.enabled) return;
    for (const raw of spec.split(';')) {
      const entry = raw.trim();
      if (!entry) continue;
      this.addEntry(entry);
    }
  }

  private addEntry(entry: string): void {
    const isV6 = entry.includes(':');
    const family: 'ipv4' | 'ipv6' = isV6 ? 'ipv6' : 'ipv4';
    try {
      if (entry.includes('/')) {
        const [net, prefixStr] = entry.split('/');
        const prefix = parseInt(prefixStr, 10);
        this.list.addSubnet(net, prefix, family);
      } else {
        this.list.addAddress(entry, family);
      }
    } catch {
      // 非法条目静默忽略（上层校验应在保存前拦截）
    }
  }

  /** 校验某 IP 是否被允许 */
  allows(ip: string | undefined | null): boolean {
    if (!this.enabled) return true;
    if (!ip) return false;
    // 处理 IPv4 映射地址 ::ffff:1.2.3.4
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    const family: 'ipv4' | 'ipv6' = normalized.includes(':') ? 'ipv6' : 'ipv4';
    try {
      return this.list.check(normalized, family);
    } catch {
      return false;
    }
  }
}

/** 校验白名单字符串语法，返回非法条目（供 API 保存前校验） */
export function validateWhitelistSpec(spec: string): WhitelistParseResult {
  const errors: string[] = [];
  if (!spec || spec.trim().length === 0) return { ok: true, errors };
  for (const raw of spec.split(';')) {
    const entry = raw.trim();
    if (!entry) continue;
    const isV6 = entry.includes(':');
    const family: 'ipv4' | 'ipv6' = isV6 ? 'ipv6' : 'ipv4';
    try {
      const bl = new BlockList();
      if (entry.includes('/')) {
        const [net, prefixStr] = entry.split('/');
        const prefix = parseInt(prefixStr, 10);
        if (Number.isNaN(prefix)) throw new Error('bad prefix');
        bl.addSubnet(net, prefix, family);
      } else {
        bl.addAddress(entry, family);
      }
    } catch {
      errors.push(entry);
    }
  }
  return { ok: errors.length === 0, errors };
}
