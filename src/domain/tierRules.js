/**
 * 会员等级判定规则（纯函数，方便单测与复用）：
 * 1. 成长值等级：取 growthThreshold <= member.growth 的最高等级；
 * 2. 付费等级：有效订阅（status=active 且 endAt 未过期）中等级最高者；
 * 3. 实际生效等级取两者中更高的一个 —— 付费可以临时获得更高等级，到期后回落到成长值等级。
 */

export function sortByRankAsc(tiers) {
  return [...tiers].sort((a, b) => a.rank - b.rank);
}

export function growthTierOf(tiers, growth) {
  const ordered = sortByRankAsc(tiers);
  let current = ordered[0];
  for (const tier of ordered) {
    if (growth >= tier.growthThreshold) current = tier;
  }
  return current;
}

export function activeSubscriptionsOf(subscriptions, memberId, nowIso) {
  return subscriptions.filter(
    (sub) => sub.memberId === memberId && sub.status === 'active' && sub.endAt > nowIso,
  );
}

export function resolveMembership({ tiers, member, subscriptions, nowIso }) {
  const growthTier = growthTierOf(tiers, member.growth);
  const tierOfCode = new Map(tiers.map((tier) => [tier.code, tier]));
  const activeSubs = activeSubscriptionsOf(subscriptions, member.id, nowIso)
    .map((sub) => ({ ...sub, tier: tierOfCode.get(sub.tierCode) }))
    .filter((sub) => Boolean(sub.tier))
    .sort((a, b) => b.tier.rank - a.tier.rank || (a.endAt < b.endAt ? -1 : 1));

  const paidSubscription = activeSubs[0] ?? null;
  const paidTier = paidSubscription?.tier ?? null;
  const usePaid = paidTier !== null && paidTier.rank > growthTier.rank;

  return {
    tier: usePaid ? paidTier : growthTier,
    source: usePaid ? 'subscription' : 'growth',
    growthTier,
    subscription: paidSubscription,
  };
}
