import assert from 'node:assert/strict';
import test from 'node:test';
import { startApi } from './helpers.js';

test('注册会员返回访问令牌与初始等级', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const response = await api.registerMember({ email: 'Alice@Example.com', name: '爱丽丝' });
  assert.equal(response.status, 201);
  assert.ok(response.body.token);
  assert.equal(response.body.member.email, 'alice@example.com');
  assert.equal(response.body.member.tier.code, 'free');
  assert.equal(response.body.member.growth, 0);
  assert.equal(response.body.member.pointsBalance, 0);
  assert.equal(response.body.member.status, 'active');
});

test('注册参数校验与邮箱唯一', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const badEmail = await api.request('POST', '/api/members', { body: { email: 'not-an-email', name: '张三' } });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.body.error.code, 'VALIDATION_ERROR');

  const missingName = await api.request('POST', '/api/members', { body: { email: 'bob@example.com' } });
  assert.equal(missingName.status, 400);

  await api.registerMember({ email: 'dup@example.com' });
  const duplicate = await api.request('POST', '/api/members', { body: { email: 'dup@example.com', name: '重复' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'MEMBER_EMAIL_TAKEN');
});

test('会员接口需要令牌，且不能读取他人档案', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const alice = await api.registerMember({ email: 'alice@example.com' });
  const bob = await api.registerMember({ email: 'bob@example.com' });
  const aliceId = alice.body.member.id;

  const anonymous = await api.request('GET', `/api/members/${aliceId}`);
  assert.equal(anonymous.status, 401);

  const wrongToken = await api.request('GET', `/api/members/${aliceId}`, { token: 'invalid-token' });
  assert.equal(wrongToken.status, 401);

  const owner = await api.request('GET', `/api/members/${aliceId}`, { token: alice.body.token });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.member.id, aliceId);

  const crossAccess = await api.request('GET', `/api/members/${aliceId}`, { token: bob.body.token });
  assert.equal(crossAccess.status, 403);
  assert.equal(crossAccess.body.error.code, 'FORBIDDEN');

  const admin = await api.request('GET', `/api/members/${aliceId}`, { admin: true });
  assert.equal(admin.status, 200);

  const missing = await api.request('GET', '/api/members/mem_not_exists', { admin: true });
  assert.equal(missing.status, 404);
});

test('管理端可冻结会员，冻结后不能下单', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const alice = await api.registerMember({ email: 'freeze@example.com' });
  const memberId = alice.body.member.id;

  const frozen = await api.request('PATCH', `/api/admin/members/${memberId}`, {
    body: { status: 'frozen' },
    admin: true,
  });
  assert.equal(frozen.status, 200);
  assert.equal(frozen.body.member.status, 'frozen');

  const order = await api.createOrder(memberId, alice.body.token, 'plan_silver_monthly');
  assert.equal(order.status, 403);
  assert.equal(order.body.error.code, 'MEMBER_FROZEN');

  const invalidStatus = await api.request('PATCH', `/api/admin/members/${memberId}`, {
    body: { status: 'unknown' },
    admin: true,
  });
  assert.equal(invalidStatus.status, 400);
});

test('管理端会员列表支持分页与状态过滤', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const first = await api.registerMember({ email: 'list1@example.com' });
  await api.registerMember({ email: 'list2@example.com' });
  await api.request('PATCH', `/api/admin/members/${first.body.member.id}`, {
    body: { status: 'frozen' },
    admin: true,
  });

  const all = await api.request('GET', '/api/admin/members?limit=1', { admin: true });
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2);
  assert.equal(all.body.items.length, 1);

  const frozen = await api.request('GET', '/api/admin/members?status=frozen', { admin: true });
  assert.equal(frozen.body.total, 1);

  const unauthorized = await api.request('GET', '/api/admin/members');
  assert.equal(unauthorized.status, 401);

  const badLimit = await api.request('GET', '/api/admin/members?limit=abc', { admin: true });
  assert.equal(badLimit.status, 400);
});

test('会员可轮换访问令牌，旧令牌立即失效', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const alice = await api.registerMember({ email: 'rotate@example.com' });
  const memberId = alice.body.member.id;

  const rotated = await api.request('POST', `/api/members/${memberId}/token/rotate`, { token: alice.body.token });
  assert.equal(rotated.status, 200);
  const newToken = rotated.body.token;
  assert.ok(newToken && newToken !== alice.body.token);

  const withOld = await api.request('GET', `/api/members/${memberId}`, { token: alice.body.token });
  assert.equal(withOld.status, 401);

  const withNew = await api.request('GET', `/api/members/${memberId}`, { token: newToken });
  assert.equal(withNew.status, 200);
});
