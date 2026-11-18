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
