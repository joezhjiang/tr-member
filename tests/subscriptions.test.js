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

test('升级订单退款后按剩余订阅重新发放本月权益', async (t) => {
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
  assert.equal(shipping.remaining, 4);
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
