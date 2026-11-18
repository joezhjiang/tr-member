import { ValidationError } from './errors.js';

export function requireObject(value, field = 'body') {
  if (value === undefined || value === null) throw new ValidationError(`${field} 不能为空`);
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} 必须是对象`);
  return value;
}

export function requireString(source, field, { min = 1, max = 200, pattern, patternHint, trim = true } = {}) {
  const raw = source?.[field];
  if (typeof raw !== 'string') throw new ValidationError(`${field} 必须是字符串`);
  const value = trim ? raw.trim() : raw;
  if (value.length < min || value.length > max) {
    throw new ValidationError(`${field} 长度必须在 ${min}-${max} 之间`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(`${field} 格式不正确${patternHint ? `：${patternHint}` : ''}`);
  }
  return value;
}

export function optionalString(source, field, options = {}) {
  const raw = source?.[field];
  if (raw === undefined || raw === null) return undefined;
  return requireString(source, field, options);
}

export function requireEmail(source, field = 'email') {
  return requireString(source, field, {
    max: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    patternHint: '需为合法邮箱地址',
  });
}

export function requireInt(source, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = source?.[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new ValidationError(`${field} 必须是整数`);
  }
  if (raw < min || raw > max) throw new ValidationError(`${field} 必须在 ${min}-${max} 之间`);
  return raw;
}

export function optionalInt(source, field, options = {}) {
  if (source?.[field] === undefined || source[field] === null) return undefined;
  return requireInt(source, field, options);
}

export function optionalBoolean(source, field, { fallback = undefined } = {}) {
  const raw = source?.[field];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new ValidationError(`${field} 必须是布尔值`);
  return raw;
}

export function oneOf(source, field, allowed, { required = true } = {}) {
  const raw = source?.[field];
  if (raw === undefined || raw === null) {
    if (!required) return undefined;
    throw new ValidationError(`${field} 不能为空`);
  }
  if (!allowed.includes(raw)) {
    throw new ValidationError(`${field} 必须是以下值之一：${allowed.join(' / ')}`);
  }
  return raw;
}

export function requireArray(source, field, { min = 1, max = 100 } = {}) {
  const raw = source?.[field];
  if (!Array.isArray(raw)) throw new ValidationError(`${field} 必须是数组`);
  if (raw.length < min || raw.length > max) {
    throw new ValidationError(`${field} 元素个数必须在 ${min}-${max} 之间`);
  }
  return raw;
}
