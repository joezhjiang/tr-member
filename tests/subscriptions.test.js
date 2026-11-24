import assert from 'node:assert/strict';
import test from 'node:test';
import { startApi } from './helpers.js';

test('退订立即停止权益并回落等级', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'cancel@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const { subscription } = await api.buyPlan(memberId, token, 'plan_gold_monthly');

  const cancelled = await api.request('POST', `/api/subscriptions/${subscription.id}/cancel`, {
    body: { reason: '不想要了' },
    token,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.subscription.status, 'cancelled');
  assert.ok(cancelled.body.revokedGrants >= 1);

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.tier.code, 'silver'); // 成长值 500 仍保留
  assert.equal(profile.body.member.tier.source, 'growth');

  const benefits = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  const codes = benefits.body.items.map((item) => item.code);
  assert.deepEqual(codes.sort(), ['exclusive_coupon', 'free_shipping', 'priority_support']);

  const again = await api.request('POST', `/api/subscriptions/${subscription.id}/cancel`, { token });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SUBSCRIPTION_NOT_ACTIVE');
});

test('管理员退款回滚成长值与赠送积分，并取消订阅', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'refund@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const { order } = await api.buyPlan(memberId, token, 'plan_gold_monthly');

  const refunded = await api.request('POST', `/api/admin/orders/${order.id}/refund`, {
    body: { reason: '用户申请退款' },
    admin: true,
  });
  assert.equal(refunded.status, 200);
  assert.equal(refunded.body.order.status, 'refunded');
  assert.equal(refunded.body.cancelledSubscription.status, 'cancelled');
  assert.ok(refunded.body.revokedGrants >= 1);
  assert.equal(refunded.body.clawedBackPoints, 300);

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.growth, 0);
  assert.equal(profile.body.member.pointsBalance, 0);
  assert.equal(profile.body.member.tier.code, 'free');
  assert.equal(profile.body.member.subscription, null);

  const doubleRefund = await api.request('POST', `/api/admin/orders/${order.id}/refund`, { admin: true });
  assert.equal(doubleRefund.status, 409);
  assert.equal(doubleRefund.body.error.code, 'ORDER_NOT_REFUNDABLE');
});

test('退款只回收可回收的积分，不产生负余额', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'refund-spent@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const { order } = await api.buyPlan(memberId, token, 'plan_gold_monthly');

  // 花掉部分赠送积分
  await api.request('POST', `/api/members/${memberId}/points/spend`, { body: { amount: 200 }, token });

  const refunded = await api.request('POST', `/api/admin/orders/${order.id}/refund`, { admin: true });
  assert.equal(refunded.status, 200);
  assert.equal(refunded.body.clawedBackPoints, 100);

  const ledger = await api.request('GET', `/api/members/${memberId}/points`, { token });
  assert.equal(ledger.body.balance, 0);
  assert.ok(ledger.body.items.every((entry) => entry.balanceAfter >= 0));
});

test('升级订单退款后按剩余订阅重算本月权益，已消耗额度不返还', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'upgrade-refund@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  await api.buyPlan(memberId, token, 'plan_silver_monthly');
  await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: { quantity: 4 }, token });

  const upgraded = await api.buyPlan(memberId, token, 'plan_gold_monthly');
  const afterUpgrade = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(afterUpgrade.body.items.find((item) => item.code === 'free_shipping').remaining, 6);

  const refunded = await api.request('POST', `/api/admin/orders/${upgraded.order.id}/refund`, { admin: true });
  assert.equal(refunded.status, 200);
  assert.ok(refunded.body.revokedGrants >= 1);

  const afterRefund = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(afterRefund.body.tier.code, 'silver');
  const shipping = afterRefund.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 4);
  assert.equal(shipping.used, 4, '同月已核销的 4 次必须保留（AC-06.5）');
  assert.equal(shipping.remaining, 0, '重算按「当前配额 - 已核销量」，不得重发满额');

  const extra = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: {}, token });
  assert.equal(extra.status, 409);
  assert.equal(extra.body.error.code, 'BENEFIT_EXHAUSTED');
});

test('普通顺延不会静默关闭自动续费，显式关闭仍然生效', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'autorenew-extend@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const first = await api.buyPlan(memberId, token, 'plan_silver_monthly', { autoRenew: true });
  assert.equal(first.subscription.autoRenew, true);

  // 普通顺延：未提供 autoRenew
  const second = await api.buyPlan(memberId, token, 'plan_silver_monthly');
  assert.equal(second.pay.body.action, 'extended');
  assert.equal(second.subscription.autoRenew, true, '未提供 autoRenew 时不得关闭自动续费');
  assert.equal(second.subscription.renewalCount, 1);

  // 显式关闭仍然生效
  const third = await api.buyPlan(memberId, token, 'plan_silver_monthly', { autoRenew: false });
  assert.equal(third.pay.body.action, 'extended');
  assert.equal(third.subscription.autoRenew, false);

  // 关闭后到期不再自动扣款（三次顺延后到期时间在 3 个月后）
  api.advanceMonths(3);
  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.status, 200);
  assert.equal(run.body.renewedSubscriptions, 0);
  assert.equal(run.body.expiredSubscriptions, 1);
});

test('退款与退订需要正确权限', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const alice = await api.registerMember({ email: 'perm-owner@example.com' });
  const bob = await api.registerMember({ email: 'perm-other@example.com' });
  const { order, subscription } = await api.buyPlan(alice.body.member.id, alice.body.token, 'plan_silver_monthly');

  const refundByMember = await api.request('POST', `/api/admin/orders/${order.id}/refund`, {
    token: alice.body.token,
  });
  assert.equal(refundByMember.status, 401);

  const cancelByOther = await api.request('POST', `/api/subscriptions/${subscription.id}/cancel`, {
    token: bob.body.token,
  });
  assert.equal(cancelByOther.status, 403);

  const refundAnonymous = await api.request('POST', `/api/admin/orders/${order.id}/refund`);
  assert.equal(refundAnonymous.status, 401);
});

test('待支付订单不能直接退款', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'pending-refund@example.com' });
  const created = await api.createOrder(member.body.member.id, member.body.token, 'plan_silver_monthly');

  const refunded = await api.request('POST', `/api/admin/orders/${created.body.order.id}/refund`, { admin: true });
  assert.equal(refunded.status, 409);
  assert.equal(refunded.body.error.code, 'ORDER_NOT_REFUNDABLE');
});
