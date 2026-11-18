import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** 生成带前缀的资源 id，便于日志排查 */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** 会员访问令牌：只在下发时返回一次，库里只存哈希 */
export function newToken() {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** 常量时间比较，避免令牌校验泄露时序信息 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
