import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * 敏感字段加解密（AES-256-GCM）。
 *
 * 处理范围：达人证件号、银行卡号等「泄露即违规」的字段。
 * 为什么不只做哈希：证件号在业务上需要回显（签约、报税），必须可逆。
 * 为什么用 GCM 而不是 CBC：GCM 自带完整性校验，能发现密文被篡改。
 * 密钥派生：从 JWT_ACCESS_SECRET 经 scrypt 派生出固定 32 字节密钥。
 *   生产环境应改为独立的 KMS 数据密钥（见 docs/architecture.md「密钥管理」章节），
 *   此处保持零外部依赖，保证本地与 CI 可跑通。
 *
 * 密文格式：v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
 * 前缀 v1 为密钥轮换留出空间——将来可同时存在 v2 密文并平滑迁移。
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 96 bit
const KEY_SALT = 'creatorops:sensitive-field:v1';

let cachedKey: Buffer | null = null;

function deriveKey(secret: string): Buffer {
  if (cachedKey) return cachedKey;
  if (!secret || secret.length < 16) {
    throw new Error('敏感字段加密密钥不可用：请配置足够强度的 JWT_ACCESS_SECRET');
  }
  cachedKey = scryptSync(secret, KEY_SALT, 32);
  return cachedKey;
}

/** 加密敏感字段；传入空值原样返回，避免把 null 变成密文 */
export function encryptSensitive(plain: string | null | undefined, secret: string): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(
    ':',
  );
}

/**
 * 解密敏感字段。
 * 解密失败返回 null 而不是抛错：历史数据可能用旧密钥加密，
 * 让「查列表时个别字段为空」比「整个接口 500」更符合业务预期，
 * 同时把异常留给调用方决定是否告警。
 */
export function decryptSensitive(payload: string | null | undefined, secret: string): string | null {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const key = deriveKey(secret);
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 手机号脱敏：138****8888 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 4) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** 证件号脱敏：1101**********1234 */
export function maskIdCard(idCard: string | null | undefined): string | null {
  if (!idCard) return null;
  if (idCard.length <= 6) return '******';
  return `${idCard.slice(0, 4)}${'*'.repeat(Math.max(idCard.length - 8, 1))}${idCard.slice(-4)}`;
}

/** 姓名脱敏：张* / 欧阳** */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name.length <= 1) return name;
  return `${name[0]}${'*'.repeat(name.length - 1)}`;
}

/** 微信号脱敏：保留首尾各 2 位 */
export function maskWechat(wechat: string | null | undefined): string | null {
  if (!wechat) return null;
  if (wechat.length <= 4) return '****';
  return `${wechat.slice(0, 2)}****${wechat.slice(-2)}`;
}

export const sensitiveFieldInternals = { VERSION, ALGORITHM };
