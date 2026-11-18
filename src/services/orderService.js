import { ConflictError, NotFoundError, ValidationError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { optionalBoolean, optionalString, requireObject } from '../core/validate.js';

export function createOrderService(ctx) {
  const { db, persist, now } = ctx;
  const services = () => ctx.services;

  function find(orderId) {
    return db.orders.find((order) => order.id === orderId) ?? null;
  }

  function get(orderId) {
    const order = find(orderId);
    if (!order) throw new NotFoundError('订单', orderId);
    return order;
  }

  function listByMember(memberId) {
    return db.orders
      .filter((order) => order.memberId === memberId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function view(order) {
    const plan = db.plans.find((item) => item.id === order.planId) ?? null;
    return {
      id: order.id,
      memberId: order.memberId,
      planId: order.planId,
      planName: plan?.name ?? order.planId,
      kind: order.kind,
      status: order.status,
      amountCents: order.amountCents,
      currency: order.currency,
      autoRenew: order.autoRenew,
      subscriptionId: order.subscriptionId,
      renewalOfSubscriptionId: order.renewalOfSubscriptionId,
      growthAwarded: order.growthAwarded,
      pointsAwarded: order.pointsAwarded,
      paidAt: order.paidAt,
      refundedAt: order.refundedAt,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
    };
  }

  function create(member, body) {
    requireObject(body);
    const { members, catalog } = services();
    members.requireActive(member);
    const planId = optionalString(body, 'planId', { min: 3, max: 64 });
    if (!planId) throw new ValidationError('缺少 planId');
    const plan = catalog.getPlan(planId);
    if (!plan.active) throw new ConflictError('PLAN_INACTIVE', '该套餐已下架', { planId });

    const autoRenew = optionalBoolean(body, 'autoRenew', { fallback: false });
    const timestamp = now();
    const order = {
      id: newId('ord'),
      memberId: member.id,
      planId: plan.id,
      kind: 'purchase',
      status: 'pending',
      amountCents: plan.priceCents,
      currency: plan.currency,
      autoRenew,
      subscriptionId: null,
      renewalOfSubscriptionId: null,
      growthAwarded: 0,
      pointsAwarded: 0,
      paidAt: null,
      refundedAt: null,
      cancelledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.orders.push(order);
    persist();
    return order;
  }

  function createRenewal(subscription, plan) {
    const timestamp = now();
    const order = {
      id: newId('ord'),
      memberId: subscription.memberId,
      planId: plan.id,
      kind: 'renewal',
      status: 'pending',
      amountCents: plan.priceCents,
      currency: plan.currency,
      autoRenew: true,
      subscriptionId: subscription.id,
      renewalOfSubscriptionId: subscription.id,
      growthAwarded: 0,
      pointsAwarded: 0,
      paidAt: null,
      refundedAt: null,
      cancelledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.orders.push(order);
    persist();
    return order;
  }

  /**
   * 支付确认（支付回调 / 管理端代付 / 自动续费）：
   * 幂等——已支付订单重复调用直接返回原结果；其余非 pending 状态一律拒绝。
   */
  function pay(order, { source = 'callback' } = {}) {
    if (order.status === 'paid') return { order, idempotent: true, subscription: null, action: 'none' };
    if (order.status !== 'pending') {
      throw new ConflictError('ORDER_NOT_PAYABLE', '订单当前状态不可支付', { orderId: order.id, status: order.status });
    }

    const { members, catalog, subscriptions, points, benefits } = services();
    const member = members.get(order.memberId);
    members.requireActive(member);
    const plan = catalog.getPlan(order.planId);
    const timestamp = now();

    order.status = 'paid';
    order.paidAt = timestamp;
    order.paymentSource = source;
    order.updatedAt = timestamp;
    order.growthAwarded = plan.growth;
    order.pointsAwarded = plan.bonusPoints;

    const { subscription, action } = subscriptions.applyPurchase({ member, plan, order });
    order.subscriptionId = subscription.id;
    order.updatedAt = now();

    members.addGrowth(member, plan.growth);
    if (plan.bonusPoints > 0) {
      points.earn(member, {
        amount: plan.bonusPoints,
        reason: `订阅「${plan.name}」奖励积分`,
        idempotencyKey: `order:${order.id}:bonus`,
        refType: 'order',
        refId: order.id,
      });
    }
    benefits.ensureGrants(member);
    persist();

    return { order, idempotent: false, subscription, action };
  }

  function cancel(order) {
    if (order.status !== 'pending') {
      throw new ConflictError('ORDER_NOT_CANCELLABLE', '仅待支付订单可以取消', { orderId: order.id, status: order.status });
    }
    order.status = 'cancelled';
    order.cancelledAt = now();
    order.updatedAt = order.cancelledAt;
    persist();
    return order;
  }

  /**
   * 退款：取消对应订阅并回收该订阅发放的权益；
   * 成长值与赠送积分按订单记录回滚（积分最多扣到 0，不产生负余额）。
   */
  function refund(order, body = {}) {
    requireObject(body ?? {});
    if (order.status !== 'paid') {
      throw new ConflictError('ORDER_NOT_REFUNDABLE', '仅已支付订单可以退款', { orderId: order.id, status: order.status });
    }
    const { members, subscriptions, points, benefits } = services();
    const member = members.get(order.memberId);
    const timestamp = now();
    const reason = optionalString(body, 'reason', { max: 200 }) ?? null;

    order.status = 'refunded';
    order.refundedAt = timestamp;
    order.refundReason = reason;
    order.updatedAt = timestamp;

    let revokedGrants = 0;
    let cancelledSubscription = null;
    if (order.subscriptionId) {
      const subscription = subscriptions.find(order.subscriptionId);
      if (subscription && subscription.status === 'active') {
        cancelledSubscription = subscriptions.cancel(subscription, { reason: reason ?? '订单退款' });
      }
      revokedGrants = benefits.revokeBySubscription(order.subscriptionId);
    }

    if (order.growthAwarded > 0) members.addGrowth(member, -order.growthAwarded);
    let clawedBackPoints = 0;
    if (order.pointsAwarded > 0) {
      const result = points.clawback(member, {
        amount: order.pointsAwarded,
        reason: `订单退款回收赠送积分（${order.id}）`,
        idempotencyKey: `order:${order.id}:refund`,
      });
      clawedBackPoints = result.clawedBack ?? 0;
    }

    persist();
    return { order, cancelledSubscription, revokedGrants, clawedBackPoints };
  }

  return { find, get, listByMember, view, create, createRenewal, pay, cancel, refund };
}
