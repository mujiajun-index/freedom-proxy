import crypto from 'crypto';

// 使用 Node 内置 crypto.scrypt 进行带盐哈希，零外部依赖。
// 存储格式：scrypt$<salt hex>$<hash hex>

const KEYLEN = 64;
const PREFIX = 'scrypt';

/** 对明文密码进行哈希 */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, KEYLEN).toString('hex');
  return `${PREFIX}$${salt}$${hash}`;
}

/** 校验明文密码是否匹配已存储的哈希 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const [, salt, hash] = parts;
  try {
    const computed = crypto.scryptSync(plain, salt, KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    if (computed.length !== expected.length) return false;
    return crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

/** 生成随机密码（首启未配置密码时使用） */
export function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}
