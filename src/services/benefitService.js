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
  const usagesOf = () => (Array.isArray(db.benefitUsages) ? db.benefitUsages : []);

  function isValid(grant, timestamp) {
    return grant.status === 'active' && grant.remaining > 0 && (grant.validUntil === null || grant.validUntil > timestamp);
  }

  /** 展示口径：只要授权仍有效就计入配额，即使剩余为 0（否则已用完的额度会从 quota/used 中消失） */
  function isReportable(grant, timestamp) {
    return grant.status === 'active' && (grant.validUntil === null || grant.validUntil > timestamp);
  }

  /**
   * 已核销量账本：以「会员 + 权益 + 周期 + periodKey」为维度记录真实消耗，
   * 是回收后重算的唯一事实来源（AC-06.5 / D-13：已消耗额度不返还）。
   */
  function usedOf(memberId, benefitCode, period, periodKey) {
    return usagesOf()
      .filter(
        (usage) =>
          usage.memberId === memberId &&
          usage.benefitCode === benefitCode &&
          usage.period === period &&
          usage.periodKey === periodKey,
      )
      .reduce((sum, usage) => sum + usage.quantity, 0);
  }

  function recordUsage(memberId, benefitCode, period, periodKey, quantity, timestamp) {
    if (quantity <= 0) return;
    if (!Array.isArray(db.benefitUsages)) db.benefitUsages = [];
    db.benefitUsages.push({
      id: newId('bus'),
      memberId,
      benefitCode,
      period,
      periodKey,
      quantity,
      consumedAt: timestamp,
    });
  }

  function currentMembership(member) {
    return resolveMembership({ tiers: db.tiers, member, subscriptions: db.subscriptions, nowIso: now() });
  }

  /**
   * 按会员当前生效等级补齐权益额度：
   * - 月度权益按自然月发放，同月内升级只补差额，不重复发放；
   * - 同月降级保留已发放额度（AC-06.7 / D-12），不再追扣；
   * - 回收后重算按「当前配额 - 当月已核销量」计算剩余额度，已消耗额度不返还（AC-06.5 / D-13）；
   * - 终身权益每个会员只发一次，不随订阅到期回收；
   * - 权益归属（source / sourceSubscriptionId）只跟随生效等级的来源，成长值等级不得挂到订阅上（AC-03.2/05.4）。
   */
  function ensureGrants(member) {
    const timestamp = now();
    const { tier, entitlementSubscription } = currentMembership(member);
    const periodKey = monthKeyOf(timestamp);
    const monthEnd = endOfMonthIso(timestamp);
    const sourceSubscriptionId = entitlementSubscription?.id ?? null;
    const source = entitlementSubscription ? 'subscription' : 'tier';
    let created = 0;
    let changed = false;

    function attribute(grant) {
      if (grant.source === source && grant.sourceSubscriptionId === sourceSubscriptionId) return false;
      grant.source = source;
      grant.sourceSubscriptionId = sourceSubscriptionId;
      return true;
    }

    for (const rule of rulesOfTier(tier.code)) {
      const def = defOf(rule.benefitCode);
      if (!def) continue;

      if (rule.period === 'monthly') {
        const used = usedOf(member.id, rule.benefitCode, 'monthly', periodKey);
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
            remaining: Math.max(0, rule.quota - used),
            validFrom: timestamp,
            validUntil: monthEnd,
            status: 'active',
            source,
            sourceSubscriptionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          created += 1;
          continue;
        }
        // 同月升级：补齐到当前配额并按已核销量重算剩余；同月降级保留已发额度
        if (rule.quota > existing.quota) {
          existing.quota = rule.quota;
          existing.tierCode = tier.code;
          existing.remaining = Math.max(0, rule.quota - used);
          existing.updatedAt = timestamp;
          changed = true;
        }
        if (attribute(existing)) {
          existing.updatedAt = timestamp;
          changed = true;
        }
        continue;
      }

      const lifetimeUsed = usedOf(member.id, rule.benefitCode, 'lifetime', 'lifetime');
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
          remaining: Math.max(0, rule.quota - lifetimeUsed),
          validFrom: timestamp,
          validUntil: null,
          status: 'active',
          source,
          sourceSubscriptionId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        created += 1;
        continue;
      }
      if (attribute(existingLifetime)) {
        existingLifetime.updatedAt = timestamp;
        changed = true;
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
        if (!isReportable(grant, timestamp)) return false;
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
      // 逐授权记录消耗，保证月度/终身额度分别可追溯（回收后重算依赖该账本）
      recordUsage(member.id, benefitCode, grant.period, grant.periodKey, used, timestamp);
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
