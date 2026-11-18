/**
 * 时间处理约定：
 * - 系统内所有时间戳都以 ISO-8601 UTC 字符串存储，字符串比较即时间比较；
 * - 订阅在 endAt > now 时视为有效期，权益在 validUntil === null 或 validUntil > now 时有效。
 */

export function addMonthsIso(iso, months) {
  const date = new Date(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  // 处理 1/31 + 1 个月 → 2/28 这类月末收敛
  const daysInTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, daysInTargetMonth));
  return date.toISOString();
}

export function addDaysIso(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

export function endOfMonthIso(iso) {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1).toISOString();
}

export function monthKeyOf(iso) {
  return iso.slice(0, 7);
}

export function isAtOrBefore(a, b) {
  return a <= b;
}
