import assert from 'node:assert/strict';
import test from 'node:test';
import { addMonthsIso } from '../src/domain/time.js';
import { START_TIME, startApi } from './helpers.js';

test('开启自动续费的订阅到期后自动扣款顺延', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'autorenew@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const first = await api.buyPlan(memberId, token, 'plan_silver_monthly', { autoRenew: true });
  assert.equal(first.subscription.autoRenew, true);
  assert.equal(first.subscription.endAt, addMonthsIso(START_TIME.toISOString(), 1));

  api.advanceMonths(1);
  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.status, 200);
  assert.equal(run.body.renewedSubscriptions, 1);
  assert.equal(run.body.expiredSubscriptions, 0);
  assert.equal(run.body.renewalOrderIds.length, 1);

  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.total, 1);
  const [subscription] = subscriptions.body.items;
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.renewalCount, 1);
  assert.equal(subscription.endAt, addMonthsIso(START_TIME.toISOString(), 2));

  const orders = await api.request('GET', `/api/members/${memberId}/orders`, { token });
  const renewal = orders.body.items.find((order) => order.kind === 'renewal');
  assert.equal(renewal.status, 'paid');
  assert.equal(renewal.amountCents, 1900);

  // 续费同样发放成长值与积分
  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.growth, 400);
  assert.equal(profile.body.member.pointsBalance, 200);
});

test('同一时间点连续执行维护任务不会重复扣款或重复补发权益', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'maint-idempotent@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly', { autoRenew: true });
  api.advanceMonths(1);

  const first = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.renewedSubscriptions, 1);
  assert.equal(first.body.renewalOrderIds.length, 1);
  assert.ok(first.body.expiredBenefitGrants >= 1, '跨月时旧月授权应在首次 run 中过期');

  const orderCountAfterFirst = api.app.ctx.db.orders.length;
  const grantCountAfterFirst = api.app.ctx.db.benefitGrants.length;

  const second = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(second.status, 200);
  assert.equal(second.body.renewedSubscriptions, 0);
  assert.deepEqual(second.body.renewalOrderIds, []);
  assert.equal(second.body.skippedAutoRenew, 0);
  assert.equal(second.body.expiredSubscriptions, 0);
  assert.equal(second.body.expiredBenefitGrants, 0);
  assert.equal(second.body.grantedBenefitGrants, 0);
  assert.equal(api.app.ctx.db.orders.length, orderCountAfterFirst);
  assert.equal(api.app.ctx.db.benefitGrants.length, grantCountAfterFirst);

  const orders = await api.request('GET', `/api/members/${memberId}/orders`, { token });
  assert.equal(orders.body.items.filter((order) => order.kind === 'renewal').length, 1);
  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.items[0].renewalCount, 1);
});

test('未开启自动续费的订阅到期后置为过期并回落等级', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'expire@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly');

  api.advanceMonths(2);
  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.body.expiredSubscriptions, 1);
  assert.equal(run.body.renewedSubscriptions, 0);

  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.items[0].status, 'expired');

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.subscription, null);
  assert.equal(profile.body.member.tier.code, 'free');
});

test('自动续费遇套餐下架或会员冻结则改为过期', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'autorenew-frozen@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly', { autoRenew: true });

  await api.request('PATCH', `/api/admin/members/${memberId}`, { body: { status: 'frozen' }, admin: true });
  api.advanceMonths(1);

  const run = await api.request('POST', '/api/admin/maintenance/run', { admin: true });
  assert.equal(run.body.renewedSubscriptions, 0);
  assert.equal(run.body.expiredSubscriptions, 1);
  assert.equal(run.body.skippedAutoRenew, 1);

  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { admin: true });
  assert.equal(subscriptions.status, 200);
  assert.equal(subscriptions.body.items[0].status, 'expired');
  assert.equal(subscriptions.body.items[0].autoRenew, false);
});

test('维护任务需要管理员令牌', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const anonymous = await api.request('POST', '/api/admin/maintenance/run');
  assert.equal(anonymous.status, 401);

  const member = await api.registerMember({ email: 'maint-perm@example.com' });
  const asMember = await api.request('POST', '/api/admin/maintenance/run', { token: member.body.token });
  assert.equal(asMember.status, 401);
});

test('健康检查公开可访问', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const health = await api.request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const missing = await api.request('GET', '/api/not-exists');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});
