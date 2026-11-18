import assert from 'node:assert/strict';
import test from 'node:test';
import { startApi } from './helpers.js';

test('管理端可新建套餐，重复编码被拒绝', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const created = await api.request('POST', '/api/admin/plans', {
    body: {
      code: 'trial_monthly',
      name: '体验月卡',
      tierCode: 'silver',
      periodMonths: 1,
      priceCents: 100,
      growth: 0,
      bonusPoints: 50,
    },
    admin: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.plan.code, 'trial_monthly');
  assert.equal(created.body.plan.active, true);

  const plans = await api.request('GET', '/api/plans');
  assert.ok(plans.body.items.some((plan) => plan.code === 'trial_monthly'));

  const duplicate = await api.request('POST', '/api/admin/plans', {
    body: { code: 'trial_monthly', name: '重复', tierCode: 'silver', periodMonths: 1, priceCents: 100 },
    admin: true,
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'PLAN_CODE_TAKEN');

  const badTier = await api.request('POST', '/api/admin/plans', {
    body: { code: 'bad_tier', name: '错误等级', tierCode: 'diamond', periodMonths: 1, priceCents: 100 },
    admin: true,
  });
  assert.equal(badTier.status, 400);

  const nonAdmin = await api.request('POST', '/api/admin/plans', {
    body: { code: 'no_auth', name: '无权限', tierCode: 'silver', periodMonths: 1, priceCents: 100 },
  });
  assert.equal(nonAdmin.status, 401);
});

test('下架套餐不可下单，价格调整对后续订单生效', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'plan-admin@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const updated = await api.request('PATCH', '/api/admin/plans/plan_silver_monthly', {
    body: { priceCents: 2500 },
    admin: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.plan.priceCents, 2500);

  const order = await api.createOrder(memberId, token, 'plan_silver_monthly');
  assert.equal(order.body.order.amountCents, 2500);

  const deactivated = await api.request('PATCH', '/api/admin/plans/plan_gold_monthly', {
    body: { active: false },
    admin: true,
  });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.plan.active, false);

  const blocked = await api.createOrder(memberId, token, 'plan_gold_monthly');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PLAN_INACTIVE');

  const publicPlans = await api.request('GET', '/api/plans');
  assert.ok(!publicPlans.body.items.some((plan) => plan.id === 'plan_gold_monthly'));

  const allPlans = await api.request('GET', '/api/plans?includeInactive=true');
  assert.ok(allPlans.body.items.some((plan) => plan.id === 'plan_gold_monthly'));
});
