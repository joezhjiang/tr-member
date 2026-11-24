import assert from 'node:assert/strict';
import test from 'node:test';
import { startApi } from './helpers.js';

test('订阅后按等级发放月度与终身权益', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'benefit@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly');

  const benefits = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(benefits.status, 200);
  assert.equal(benefits.body.tier.code, 'silver');
  const shipping = benefits.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 4);
  assert.equal(shipping.remaining, 4);
  assert.equal(shipping.used, 0);
  assert.equal(shipping.period, 'monthly');
  assert.ok(shipping.validUntil > '2026-03-31');

  const coupon = benefits.body.items.find((item) => item.code === 'exclusive_coupon');
  assert.equal(coupon.remaining, 2);
});

test('消耗权益后余额减少，超量返回 BENEFIT_EXHAUSTED', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'consume@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly');

  const used = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, {
    body: { quantity: 3 },
    token,
  });
  assert.equal(used.status, 200);
  assert.equal(used.body.consumed, 3);
  assert.equal(used.body.remaining, 1);

  const last = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: {}, token });
  assert.equal(last.status, 200);
  assert.equal(last.body.remaining, 0);

  const exhausted = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: {}, token });
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.body.error.code, 'BENEFIT_EXHAUSTED');
  assert.equal(exhausted.body.error.details.remaining, 0);

  const invalidQuantity = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, {
    body: { quantity: 0 },
    token,
  });
  assert.equal(invalidQuantity.status, 400);
});

test('当前等级不包含的权益不可使用', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'nofree@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const unavailable = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, {
    body: {},
    token,
  });
  assert.equal(unavailable.status, 403);
  assert.equal(unavailable.body.error.code, 'BENEFIT_NOT_AVAILABLE');

  const list = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.deepEqual(list.body.items, []);
  assert.equal(list.body.tier.code, 'free');
});

test('同月内升级只补配额差额，不重复发放', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'upgrade@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  await api.buyPlan(memberId, token, 'plan_silver_monthly');
  await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: { quantity: 4 }, token });

  await api.buyPlan(memberId, token, 'plan_gold_monthly');
  const benefits = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(benefits.body.tier.code, 'gold');
  const shipping = benefits.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 10);
  assert.equal(shipping.used, 4);
  assert.equal(shipping.remaining, 6);

  const lifetime = benefits.body.items.find((item) => item.code === 'birthday_gift');
  assert.equal(lifetime.period, 'lifetime');
  assert.equal(lifetime.remaining, 1);
});

test('跨月由维护任务补发月度权益，旧月额度失效', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'monthly@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly');
  await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: { quantity: 4 }, token });

  // 4 月 1 日，订阅仍在有效期内，但已进入新的自然月
  api.setTime('2026-04-01T10:00:00.000Z');
  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.status, 200);
  assert.ok(run.body.expiredBenefitGrants >= 1);
  assert.ok(run.body.grantedBenefitGrants >= 1);

  const benefits = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  const shipping = benefits.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.periodKey, '2026-04');
  assert.equal(shipping.remaining, 4);
});

test('同月配额下调不回收已发额度，次月按新配额发放', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'downgrade@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_gold_yearly');
  await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, {
    body: { quantity: 3 },
    token,
  });

  const lowered = await api.request('PUT', '/api/admin/tiers/gold/benefits', {
    body: { benefits: [{ benefitCode: 'free_shipping', quota: 4, period: 'monthly' }] },
    admin: true,
  });
  assert.equal(lowered.status, 200);

  const sameMonth = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  const shippingBefore = sameMonth.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shippingBefore.periodKey, '2026-03');
  assert.equal(shippingBefore.quota, 10);
  assert.equal(shippingBefore.remaining, 7, '同月降级不应回收已发额度');

  api.advanceMonths(1);
  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.status, 200);
  assert.ok(run.body.grantedBenefitGrants >= 1);

  const nextMonth = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  const shippingAfter = nextMonth.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shippingAfter.periodKey, '2026-04');
  assert.equal(shippingAfter.quota, 4);
  assert.equal(shippingAfter.remaining, 4, '次月应按新配额重新发放');
});

test('退款回收来源权益后，下一次查询按剩余等级重算且不返还已消耗额度', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'revoke-recompute@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  // 成长值 2600（黄金）+ 铂金月卡（付费等级更高）→ 生效等级铂金，权益归属该订阅
  const silver = await api.buyPlan(memberId, token, 'plan_silver_yearly');
  const platinum = await api.buyPlan(memberId, token, 'plan_platinum_monthly');

  const before = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(before.body.tier.code, 'platinum');
  assert.equal(before.body.tier.source, 'subscription');
  const platinumGrant = api.app.ctx.db.benefitGrants.find(
    (grant) => grant.benefitCode === 'free_shipping' && grant.status === 'active',
  );
  assert.equal(platinumGrant.quota, 30);
  assert.equal(platinumGrant.sourceSubscriptionId, platinum.subscription.id);

  await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: { quantity: 3 }, token });

  const refunded = await api.request('POST', `/api/admin/orders/${platinum.order.id}/refund`, { admin: true });
  assert.equal(refunded.status, 200);
  assert.ok(refunded.body.revokedGrants > 0);
  assert.equal(refunded.body.cancelledSubscription.id, platinum.subscription.id);

  const afterRefund = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(afterRefund.body.tier.code, 'gold', '成长值 2600 仍满足黄金等级');
  assert.equal(afterRefund.body.tier.source, 'growth');
  const shipping = afterRefund.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 10);
  assert.equal(shipping.used, 3, '已消耗的 3 次必须在重算后保留');
  assert.equal(shipping.remaining, 7, '重算按「当前配额 - 当月已核销量」，不得重发满额');

  const activeGrants = api.app.ctx.db.benefitGrants.filter(
    (grant) => grant.benefitCode === 'free_shipping' && grant.status === 'active',
  );
  assert.equal(activeGrants.length, 1);
  assert.equal(activeGrants[0].source, 'tier', '成长值来源的权益不得挂在订阅上');
  assert.equal(activeGrants[0].sourceSubscriptionId, null);
  assert.notEqual(activeGrants[0].id, platinumGrant.id);

  // 防护：当月合计只能核销 10 次（3 + 7），第 11 次必须被拒
  const seven = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, {
    body: { quantity: 7 },
    token,
  });
  assert.equal(seven.status, 200);
  assert.equal(seven.body.remaining, 0);

  const extra = await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: {}, token });
  assert.equal(extra.status, 409);
  assert.equal(extra.body.error.code, 'BENEFIT_EXHAUSTED');
});

test('退款回收后维护任务重算同样保留已消耗额度', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'revoke-maintenance@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_yearly');
  const platinum = await api.buyPlan(memberId, token, 'plan_platinum_monthly');
  await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: { quantity: 2 }, token });

  const refunded = await api.request('POST', `/api/admin/orders/${platinum.order.id}/refund`, { admin: true });
  assert.equal(refunded.status, 200);
  assert.ok(refunded.body.revokedGrants > 0);

  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.status, 200);
  assert.ok(run.body.grantedBenefitGrants >= 1);

  const benefits = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(benefits.body.tier.code, 'gold');
  const shipping = benefits.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 10);
  assert.equal(shipping.used, 2);
  assert.equal(shipping.remaining, 8, '维护任务重算同样不得返还已消耗额度');
  assert.ok(benefits.body.items.every((item) => item.remaining >= 0));
});

test('成长值等级生效时，退订低等级订阅不会回收权益', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'growth-source@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  // 白银年卡成长值 2600 → 成长值等级黄金（rank 2）高于白银订阅（rank 1），权益来源为成长值
  const silver = await api.buyPlan(memberId, token, 'plan_silver_yearly');

  const before = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(before.body.tier.code, 'gold');
  assert.equal(before.body.tier.source, 'growth');
  assert.equal(before.body.items.find((item) => item.code === 'free_shipping').quota, 10);

  const cancelled = await api.request('POST', `/api/subscriptions/${silver.subscription.id}/cancel`, { token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.revokedGrants, 0, '权益来自成长值等级，退订订阅不得回收');

  const after = await api.request('GET', `/api/members/${memberId}/benefits`, { token });
  assert.equal(after.body.tier.code, 'gold');
  assert.equal(after.body.tier.source, 'growth');
  const shipping = after.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 10);
  assert.equal(shipping.remaining, 10);
  assert.equal(shipping.used, 0);
});

test('等级目录可被管理员调整，权益变更立即生效', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const updated = await api.request('PUT', '/api/admin/tiers/silver/benefits', {
    body: {
      benefits: [
        { benefitCode: 'free_shipping', quota: 8, period: 'monthly' },
        { benefitCode: 'priority_support', quota: 2, period: 'monthly' },
      ],
    },
    admin: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.tier.benefits.length, 2);

  const member = await api.registerMember({ email: 'catalog@example.com' });
  await api.buyPlan(member.body.member.id, member.body.token, 'plan_silver_monthly');
  const benefits = await api.request('GET', `/api/members/${member.body.member.id}/benefits`, { token: member.body.token });
  const shipping = benefits.body.items.find((item) => item.code === 'free_shipping');
  assert.equal(shipping.quota, 8);

  const badBenefit = await api.request('PUT', '/api/admin/tiers/silver/benefits', {
    body: { benefits: [{ benefitCode: 'not_exists', quota: 1, period: 'monthly' }] },
    admin: true,
  });
  assert.equal(badBenefit.status, 404);

  const nonAdmin = await api.request('PUT', '/api/admin/tiers/silver/benefits', {
    body: { benefits: [{ benefitCode: 'free_shipping', quota: 1, period: 'monthly' }] },
    token: member.body.token,
  });
  assert.equal(nonAdmin.status, 401);
});
