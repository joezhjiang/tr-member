import { ConflictError, ValidationError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { optionalInt, optionalString, requireInt, requireObject } from '../core/validate.js';

const MAX_AMOUNT = 1_000_000;

export function createPointsService(ctx) {
  const { db, persist, now } = ctx;

  function entriesOf(memberId) {
    return db.pointEntries.filter((entry) => entry.memberId === memberId);
  }

  function viewEntry(entry) {
    return {
      id: entry.id,
      type: entry.type,
      delta: entry.delta,
      reason: entry.reason,
      balanceAfter: entry.balanceAfter,
      idempotencyKey: entry.idempotencyKey,
      refType: entry.refType,
      refId: entry.refId,
      createdAt: entry.createdAt,
    };
  }

  function findByKey(memberId, idempotencyKey) {
    return entriesOf(memberId).find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
  }

  function parseInput(body) {
    requireObject(body);
    const amount = requireInt(body, 'amount', { min: 1, max: MAX_AMOUNT });
    const reason = optionalString(body, 'reason', { max: 120 }) ?? '未填写原因';
    const idempotencyKey = optionalString(body, 'idempotencyKey', { min: 8, max: 128 });
    return { amount, reason, idempotencyKey };
  }

  function write(member, { type, delta, reason, idempotencyKey, refType, refId }) {
    const entry = {
      id: newId('pts'),
      memberId: member.id,
      type,
      delta,
      reason,
      balanceAfter: member.pointsBalance + delta,
      idempotencyKey: idempotencyKey ?? null,
      refType: refType ?? null,
      refId: refId ?? null,
      createdAt: now(),
    };
    member.pointsBalance = entry.balanceAfter;
    member.updatedAt = entry.createdAt;
    db.pointEntries.push(entry);
    return entry;
  }

  function replay(member, { type, amount, idempotencyKey }) {
    if (!idempotencyKey) return null;
    const existing = findByKey(member.id, idempotencyKey);
    if (!existing) return null;
    const consistent = existing.type === type && Math.abs(existing.delta) === amount;
    if (!consistent) {
      throw new ConflictError('IDEMPOTENCY_CONFLICT', '相同幂等键已用于不同的积分操作', {
        idempotencyKey,
        existingType: existing.type,
        existingDelta: existing.delta,
      });
    }
    return existing;
  }

  function earn(member, body) {
    const input = parseInput(body);
    const replayed = replay(member, { type: 'earn', amount: input.amount, idempotencyKey: input.idempotencyKey });
    if (replayed) return { entry: viewEntry(replayed), idempotent: true, balance: member.pointsBalance };

    const entry = write(member, {
      type: 'earn',
      delta: input.amount,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    persist();
    return { entry: viewEntry(entry), idempotent: false, balance: member.pointsBalance };
  }

  function spend(member, body) {
    const input = parseInput(body);
    const replayed = replay(member, { type: 'spend', amount: input.amount, idempotencyKey: input.idempotencyKey });
    if (replayed) return { entry: viewEntry(replayed), idempotent: true, balance: member.pointsBalance };

    if (member.pointsBalance < input.amount) {
      throw new ConflictError('INSUFFICIENT_POINTS', '积分余额不足', {
        balance: member.pointsBalance,
        required: input.amount,
      });
    }
    const entry = write(member, {
      type: 'spend',
      delta: -input.amount,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    persist();
    return { entry: viewEntry(entry), idempotent: false, balance: member.pointsBalance };
  }

  /**
   * 退款时回收赠送积分：最多收回当前余额，不产生负余额。
   */
  function clawback(member, { amount, reason, idempotencyKey }) {
    if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError('amount 必须是正整数');
    const existing = idempotencyKey ? findByKey(member.id, idempotencyKey) : null;
    if (existing) return { entry: viewEntry(existing), idempotent: true, balance: member.pointsBalance };

    const actual = Math.min(amount, member.pointsBalance);
    if (actual === 0) return { entry: null, idempotent: false, balance: member.pointsBalance, clawedBack: 0 };
    const entry = write(member, {
      type: 'clawback',
      delta: -actual,
      reason,
      idempotencyKey,
    });
    persist();
    return { entry: viewEntry(entry), idempotent: false, balance: member.pointsBalance, clawedBack: actual };
  }

  function list(memberId, { limit = 20 } = {}) {
    const items = entriesOf(memberId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map(viewEntry);
    return { items, total: entriesOf(memberId).length };
  }

  return { earn, spend, clawback, list, findByKey };
}
