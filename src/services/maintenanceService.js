/**
 * 定时任务：过期清理 + 自动续费 + 月度权益刷新。
 * 平台侧可用 cron / k8s CronJob 每分钟调用 POST /api/admin/maintenance/run。
 */
export function createMaintenanceService(ctx) {
  const { db, persist, now } = ctx;
  const services = () => ctx.services;

  function run() {
    const { benefits, subscriptions, orders, catalog, members } = services();
    const timestamp = now();

    // 1) 过期权益先失效，避免跨月重复计算
    const expiredGrants = benefits.expireDue();

    // 2) 到期订阅：开了自动续费的先扣款续期，否则置为过期
    let renewedSubscriptions = 0;
    let expiredSubscriptions = 0;
    let skippedAutoRenew = 0;
    const renewalOrderIds = [];

    const dueSubscriptions = db.subscriptions.filter(
      (subscription) => subscription.status === 'active' && subscription.endAt <= timestamp,
    );

    for (const subscription of dueSubscriptions) {
      const plan = db.plans.find((item) => item.id === subscription.planId);
      const member = members.find(subscription.memberId);
      const renewable = subscription.autoRenew && plan?.active && member?.status === 'active';

      if (renewable) {
        const order = orders.createRenewal(subscription, plan);
        const result = orders.pay(order, { source: 'auto_renew' });
        renewalOrderIds.push(result.order.id);
        renewedSubscriptions += 1;
        continue;
      }

      if (subscription.autoRenew) skippedAutoRenew += 1;
      subscriptions.expire(subscription);
      expiredSubscriptions += 1;
    }

    // 3) 刷新在期会员的月度权益（跨月补发）
    let grantedBenefitGrants = 0;
    for (const member of db.members) {
      if (member.status === 'cancelled') continue;
      grantedBenefitGrants += benefits.ensureGrants(member);
    }

    persist();
    return {
      runAt: timestamp,
      expiredBenefitGrants: expiredGrants,
      expiredSubscriptions,
      renewedSubscriptions,
      renewalOrderIds,
      skippedAutoRenew,
      grantedBenefitGrants,
    };
  }

  return { run };
}
