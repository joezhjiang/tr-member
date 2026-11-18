import assert from 'node:assert/strict';
import test from 'node:test';
import { addMonthsIso } from '../src/domain/time.js';
import { START_TIME, startApi } from './helpers.js';

test('套餐与等级目录可公开读取', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const plans = await api.request('GET', '/api/plans');
  assert.equal(plans.status, 200);
  assert.ok(plans.body.items.length >= 6);
  const platinum = plans.body.items.find((plan) => plan.id === 'plan_platinum_monthly');
  assert.equal(platinum.priceCents, 9900);
  assert.equal(platinum.tierCode, 'platinum');

  const tiers = await api.request('GET', '/api/tiers');
  assert.equal(tiers.status, 200);
  const gold = tiers.body.items.find((tier) => tier.code === 'gold');
  assert.equal(gold.growthThreshold, 2000);
  assert.ok(gold.benefits.some((benefit) => benefit.code === 'birthday_gift'));
  const free = tiers.body.items.find((tier) => tier.code === 'free');
  assert.deepEqual(free.benefits, []);
});

test('下单 → 支付后开通订阅、发放成长值与赠送积分', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'buyer@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const created = await api.createOrder(memberId, token, 'plan_platinum_monthly');
  assert.equal(created.status, 201);
  assert.equal(created.body.order.status, 'pending');
  assert.equal(created.body.order.amountCents, 9900);
  assert.equal(created.body.order.kind, 'purchase');

  const paid = await api.request('POST', `/api/orders/${created.body.order.id}/pay`, { token });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.order.status, 'paid');
  assert.equal(paid.body.action, 'created');
  assert.ok(paid.body.order.paidAt);
  assert.equal(paid.body.subscription.tierCode, 'platinum');
  assert.equal(paid.body.subscription.status, 'active');
  assert.equal(paid.body.subscription.endAt, addMonthsIso(START_TIME.toISOString(), 1));

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.tier.code, 'platinum');
  assert.equal(profile.body.member.tier.source, 'subscription');
  assert.equal(profile.body.member.growth, 1000);
  assert.equal(profile.body.member.pointsBalance, 800);
  assert.equal(profile.body.member.subscription.id, paid.body.subscription.id);
});

test('重复支付同一订单是幂等的，不会重复发放权益', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'idem@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const { order } = await api.buyPlan(memberId, token, 'plan_gold_monthly');

  const again = await api.request('POST', `/api/orders/${order.id}/pay`, { token });
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.order.status, 'paid');

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.growth, 500);
  assert.equal(profile.body.member.pointsBalance, 300);

  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.total, 1);
});

test('同套餐再次购买顺延到期时间而非新建订阅', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'renew@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const first = await api.buyPlan(memberId, token, 'plan_silver_monthly');
  const second = await api.buyPlan(memberId, token, 'plan_silver_monthly');
  assert.equal(second.pay.body.action, 'extended');
  assert.equal(second.subscription.id, first.subscription.id);
  assert.equal(second.subscription.endAt, addMonthsIso(START_TIME.toISOString(), 2));
  assert.equal(second.subscription.renewalCount, 1);

  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.total, 1);
});

test('不同套餐可并存，会员等级取最高', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'stack@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  await api.buyPlan(memberId, token, 'plan_silver_monthly');
  await api.buyPlan(memberId, token, 'plan_gold_monthly');

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.tier.code, 'gold');
  assert.equal(profile.body.member.growth, 700);

  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.total, 2);
});

test('无效套餐与非法订单状态被拒绝', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'invalid@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const badPlan = await api.createOrder(memberId, token, 'plan_not_exists');
  assert.equal(badPlan.status, 404);

  const missingPlan = await api.request('POST', `/api/members/${memberId}/orders`, { body: {}, token });
  assert.equal(missingPlan.status, 400);
  assert.equal(missingPlan.body.error.code, 'VALIDATION_ERROR');

  const created = await api.createOrder(memberId, token, 'plan_silver_monthly');
  const orderId = created.body.order.id;
  const cancelled = await api.request('POST', `/api/orders/${orderId}/cancel`, { token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, 'cancelled');

  const payCancelled = await api.request('POST', `/api/orders/${orderId}/pay`, { token });
  assert.equal(payCancelled.status, 409);
  assert.equal(payCancelled.body.error.code, 'ORDER_NOT_PAYABLE');
});

test('订单不能跨会员访问', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const alice = await api.registerMember({ email: 'order-owner@example.com' });
  const bob = await api.registerMember({ email: 'order-other@example.com' });
  const { order } = await api.buyPlan(alice.body.member.id, alice.body.token, 'plan_silver_monthly');

  const stolen = await api.request('GET', `/api/orders/${order.id}`, { token: bob.body.token });
  assert.equal(stolen.status, 403);

  const adminView = await api.request('GET', `/api/orders/${order.id}`, { admin: true });
  assert.equal(adminView.status, 200);
});
