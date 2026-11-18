import { ConflictError, NotFoundError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { addMonthsIso } from '../domain/time.js';

export function createSubscriptionService(ctx) {
  const { db, persist, now } = ctx;

  function find(subscriptionId) {
    return db.subscriptions.find((subscription) => subscription.id === subscriptionId) ?? null;
  }

  function get(subscriptionId) {
    const subscription = find(subscriptionId);
    if (!subscription) throw new NotFoundError('订阅', subscriptionId);
    return subscription;
  }

  function listByMember(memberId) {
    return db.subscriptions
      .filter((subscription) => subscription.memberId === memberId)
      .sort((a, b) => (a.endAt < b.endAt ? 1 : -1));
  }

  function findExtendable(memberId, planId, timestamp) {
    return (
      db.subscriptions
        .filter(
          (subscription) =>
            subscription.memberId === memberId &&
            subscription.planId === planId &&
            subscription.status === 'active' &&
            subscription.endAt > timestamp,
        )
        .sort((a, b) => (a.endAt < b.endAt ? -1 : 1))[0] ?? null
    );
  }

  function extend(subscription, plan, order) {
    subscription.endAt = addMonthsIso(subscription.endAt, plan.periodMonths);
    subscription.renewalCount += 1;
    subscription.lastOrderId = order.id;
    subscription.status = 'active';
    if (order.autoRenew !== undefined) subscription.autoRenew = Boolean(order.autoRenew);
    subscription.updatedAt = now();
    return subscription;
  }

  /**
   * 支付成功后落订阅：
   * - 自动续费订单：直接延长原订阅，不产生空档；
   * - 同套餐仍在有效期内：顺延到期时间（续费）；
   * - 其他情况：新建一条订阅，与既有订阅并存，等级取最高。
   */
  function applyPurchase({ member, plan, order }) {
    const timestamp = now();
    let subscription;
    let action;

    if (order.renewalOfSubscriptionId) {
      subscription = get(order.renewalOfSubscriptionId);
      extend(subscription, plan, order);
      action = 'renewed';
    } else {
      const existing = findExtendable(member.id, plan.id, timestamp);
      if (existing) {
        subscription = extend(existing, plan, order);
        action = 'extended';
      } else {
        subscription = {
          id: newId('sub'),
          memberId: member.id,
          planId: plan.id,
          tierCode: plan.tierCode,
          status: 'active',
          startAt: timestamp,
          endAt: addMonthsIso(timestamp, plan.periodMonths),
          autoRenew: Boolean(order.autoRenew),
          sourceOrderId: order.id,
          lastOrderId: order.id,
          renewalCount: 0,
          cancelledAt: null,
          cancelReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        db.subscriptions.push(subscription);
        action = 'created';
      }
    }
    persist();
    return { subscription, action };
  }

  function cancel(subscription, { reason = null } = {}) {
    if (subscription.status !== 'active') {
      throw new ConflictError('SUBSCRIPTION_NOT_ACTIVE', '该订阅当前状态不可退订', {
        subscriptionId: subscription.id,
        status: subscription.status,
      });
    }
    const timestamp = now();
    subscription.status = 'cancelled';
    subscription.cancelledAt = timestamp;
    subscription.cancelReason = reason;
    subscription.autoRenew = false;
    subscription.updatedAt = timestamp;
    persist();
    return subscription;
  }

  function expire(subscription) {
    const timestamp = now();
    subscription.status = 'expired';
    subscription.autoRenew = false;
    subscription.updatedAt = timestamp;
    persist();
    return subscription;
  }

  function view(subscription) {
    const plan = db.plans.find((item) => item.id === subscription.planId) ?? null;
    return {
      id: subscription.id,
      memberId: subscription.memberId,
      planId: subscription.planId,
      planName: plan?.name ?? subscription.planId,
      tierCode: subscription.tierCode,
      status: subscription.status,
      autoRenew: subscription.autoRenew,
      startAt: subscription.startAt,
      endAt: subscription.endAt,
      renewalCount: subscription.renewalCount,
      sourceOrderId: subscription.sourceOrderId,
      lastOrderId: subscription.lastOrderId,
      cancelledAt: subscription.cancelledAt,
      createdAt: subscription.createdAt,
    };
  }

  return { find, get, listByMember, applyPurchase, cancel, expire, view, findExtendable };
}
