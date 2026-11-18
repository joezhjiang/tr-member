import { ConflictError, ForbiddenError, NotFoundError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { requireInt, requireObject } from '../core/validate.js';
import { endOfMonthIso, monthKeyOf } from '../domain/time.js';
import { resolveMembership } from '../domain/tierRules.js';

export function createBenefitService(ctx) {
  const { db, persist, now } = ctx;

  const defOf = (code) => db.benefitDefs.find((def) => def.code === code) ?? null;
  const rulesOfTier = (tierCode) => db.benefitRules.filter((rule) => rule.tierCode === tierCode);
  const grantsOf = (memberId) => db.benefitGrants.filter((grant) => grant.memberId === memberId);

  function isValid(grant, timestamp) {
    return grant.status === 'active' && grant.remaining > 0 && (grant.validUntil === null || grant.validUntil > timestamp);
  }

  function currentMembership(member) {
    return resolveMembership({ tiers: db.tiers, member, subscriptions: db.subscriptions, nowIso: now() });
  }

  /**
   * 按会员当前生效等级补齐权益额度：
   * - 月度权益按自然月发放，同月内升级只补差额，不重复发放；
   * - 终身权益每个会员只发一次，不随订阅到期回收。
   */
  function ensureGrants(member) {
    const timestamp = now();
    const { tier, subscription } = currentMembership(member);
    const periodKey = monthKeyOf(timestamp);
    const monthEnd = endOfMonthIso(timestamp);
    const sourceSubscriptionId = subscription?.id ?? null;
    const source = subscription ? 'subscription' : 'tier';
    let created = 0;
    let changed = false;

    for (const rule of rulesOfTier(tier.code)) {
      const def = defOf(rule.benefitCode);
      if (!def) continue;

      if (rule.period === 'monthly') {
        const existing = grantsOf(member.id).find(
          (grant) =>
            grant.benefitCode === rule.benefitCode &&
            grant.period === 'monthly' &&
            grant.periodKey === periodKey &&
            grant.status === 'active',
        );
        if (!existing) {
          db.benefitGrants.push({
            id: newId('bgt'),
            memberId: member.id,
            benefitCode: rule.benefitCode,
            tierCode: tier.code,
            period: 'monthly',
            periodKey,
            quota: rule.quota,
            remaining: rule.quota,
            validFrom: timestamp,
            validUntil: monthEnd,
            status: 'active',
            source: subscription ? 'subscription' : 'tier',
            sourceSubscriptionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          created += 1;
          continue;
        }
        // 同月升级：补齐配额差额，并把权益归属切到当前订阅，便于退订时精确回收
        const diff = rule.quota - existing.quota;
        if (diff > 0) {
          existing.quota = rule.quota;
          existing.remaining += diff;
          existing.tierCode = tier.code;
          existing.sourceSubscriptionId = sourceSubscriptionId;
          existing.source = source;
          existing.updatedAt = timestamp;
          changed = true;
        }
        continue;
      }

      const existingLifetime = grantsOf(member.id).find(
        (grant) => grant.benefitCode === rule.benefitCode && grant.period === 'lifetime' && grant.status === 'active',
      );
      if (!existingLifetime) {
        db.benefitGrants.push({
          id: newId('bgt'),
          memberId: member.id,
          benefitCode: rule.benefitCode,
          tierCode: tier.code,
          period: 'lifetime',
          periodKey: 'lifetime',
          quota: rule.quota,
          remaining: rule.quota,
          validFrom: timestamp,
          validUntil: null,
          status: 'active',
          source: subscription ? 'subscription' : 'tier',
          sourceSubscriptionId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        created += 1;
      }
    }

    if (created > 0 || changed) persist();
    return created;
  }

  function entitlementItems(member) {
    const timestamp = now();
    const { tier } = currentMembership(member);
    const periodKey = monthKeyOf(timestamp);

    return rulesOfTier(tier.code).map((rule) => {
      const def = defOf(rule.benefitCode);
      const grants = grantsOf(member.id).filter((grant) => {
        if (grant.benefitCode !== rule.benefitCode) return false;
        if (!isValid(grant, timestamp)) return false;
        return rule.period === 'monthly' ? grant.period === 'monthly' && grant.periodKey === periodKey : grant.period === 'lifetime';
      });
      const quota = grants.reduce((sum, grant) => sum + grant.quota, 0);
      const remaining = grants.reduce((sum, grant) => sum + grant.remaining, 0);
      return {
        code: rule.benefitCode,
        name: def?.name ?? rule.benefitCode,
        unit: def?.unit ?? '次',
        period: rule.period,
        periodKey: rule.period === 'monthly' ? periodKey : 'lifetime',
        quota,
        used: Math.max(0, quota - remaining),
        remaining,
        validUntil: rule.period === 'monthly' ? endOfMonthIso(timestamp) : (grants[0]?.validUntil ?? null),
      };
    });
  }

  function listForMember(member) {
    ensureGrants(member);
    const { tier, source } = currentMembership(member);
    return { tier: { code: tier.code, name: tier.name, rank: tier.rank, source }, items: entitlementItems(member) };
  }

  function consume(member, benefitCode, body) {
    requireObject(body ?? {});
    const quantity = body?.quantity === undefined ? 1 : requireInt(body, 'quantity', { min: 1, max: 999 });
    const timestamp = now();
    const { tier } = currentMembership(member);
    const rule = rulesOfTier(tier.code).find((item) => item.benefitCode === benefitCode);
    if (!rule) {
      throw new ForbiddenError('BENEFIT_NOT_AVAILABLE', `当前等级（${tier.name}）不包含该权益`, {
        benefitCode,
        tier: tier.code,
      });
    }
    if (!defOf(benefitCode)) throw new NotFoundError('权益定义', benefitCode);

    const periodKey = monthKeyOf(timestamp);
    const candidates = grantsOf(member.id)
      .filter((grant) => {
        if (grant.benefitCode !== benefitCode) return false;
        if (!isValid(grant, timestamp)) return false;
        return grant.period === 'monthly' ? grant.periodKey === periodKey : true;
      })
      .sort((a, b) => {
        // 先消耗月度额度，再消耗终身额度；同类型按到期时间早的优先
        if (a.period !== b.period) return a.period === 'monthly' ? -1 : 1;
        return (a.validUntil ?? '9999') < (b.validUntil ?? '9999') ? -1 : 1;
      });

    const available = candidates.reduce((sum, grant) => sum + grant.remaining, 0);
    if (available < quantity) {
      throw new ConflictError('BENEFIT_EXHAUSTED', '权益额度不足', {
        benefitCode,
        requested: quantity,
        remaining: available,
      });
    }

    let left = quantity;
    for (const grant of candidates) {
      if (left === 0) break;
      const used = Math.min(grant.remaining, left);
      grant.remaining -= used;
      grant.updatedAt = timestamp;
      left -= used;
    }
    persist();
    return {
      benefitCode,
      name: defOf(benefitCode)?.name ?? benefitCode,
      consumed: quantity,
      remaining: available - quantity,
      consumedAt: timestamp,
    };
  }

  function expireDue() {
    const timestamp = now();
    let expired = 0;
    for (const grant of db.benefitGrants) {
      if (grant.status === 'active' && grant.validUntil !== null && grant.validUntil <= timestamp) {
        grant.status = 'expired';
        grant.updatedAt = timestamp;
        expired += 1;
      }
    }
    if (expired > 0) persist();
    return expired;
  }

  function revokeBySubscription(subscriptionId) {
    const timestamp = now();
    let revoked = 0;
    for (const grant of db.benefitGrants) {
      if (grant.status === 'active' && grant.sourceSubscriptionId === subscriptionId) {
        grant.status = 'revoked';
        grant.remaining = 0;
        grant.updatedAt = timestamp;
        revoked += 1;
      }
    }
    if (revoked > 0) persist();
    return revoked;
  }

  return { ensureGrants, listForMember, consume, expireDue, revokeBySubscription };
}
