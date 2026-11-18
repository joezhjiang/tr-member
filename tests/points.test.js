import assert from 'node:assert/strict';
import test from 'node:test';
import { startApi } from './helpers.js';

test('积分获取与消耗维护余额与流水', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'points@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;

  const earned = await api.request('POST', `/api/members/${memberId}/points/earn`, {
    body: { amount: 120, reason: '签到奖励' },
    token,
  });
  assert.equal(earned.status, 201);
  assert.equal(earned.body.balance, 120);
  assert.equal(earned.body.entry.delta, 120);

  const spent = await api.request('POST', `/api/members/${memberId}/points/spend`, {
    body: { amount: 50, reason: '兑换运费券' },
    token,
  });
  assert.equal(spent.status, 201);
  assert.equal(spent.body.balance, 70);
  assert.equal(spent.body.entry.delta, -50);

  const ledger = await api.request('GET', `/api/members/${memberId}/points`, { token });
  assert.equal(ledger.body.balance, 70);
  assert.equal(ledger.body.total, 2);
  assert.equal(ledger.body.items[0].type, 'spend');

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.pointsBalance, 70);
});

test('积分不足与非法参数被拒绝', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'points-low@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.request('POST', `/api/members/${memberId}/points/earn`, { body: { amount: 10 }, token });

  const insufficient = await api.request('POST', `/api/members/${memberId}/points/spend`, {
    body: { amount: 100 },
    token,
  });
  assert.equal(insufficient.status, 409);
  assert.equal(insufficient.body.error.code, 'INSUFFICIENT_POINTS');
  assert.equal(insufficient.body.error.details.balance, 10);

  const negative = await api.request('POST', `/api/members/${memberId}/points/earn`, {
    body: { amount: -5 },
    token,
  });
  assert.equal(negative.status, 400);

  const float = await api.request('POST', `/api/members/${memberId}/points/earn`, {
    body: { amount: 1.5 },
    token,
  });
  assert.equal(float.status, 400);

  const balance = await api.request('GET', `/api/members/${memberId}/points`, { token });
  assert.equal(balance.body.balance, 10);
});

test('积分操作支持幂等键，冲突参数会被拒绝', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'points-idem@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const body = { amount: 30, reason: '活动奖励', idempotencyKey: 'activity-2026-03-bonus' };

  const first = await api.request('POST', `/api/members/${memberId}/points/earn`, { body, token });
  assert.equal(first.status, 201);
  assert.equal(first.body.idempotent, false);

  const second = await api.request('POST', `/api/members/${memberId}/points/earn`, { body, token });
  assert.equal(second.status, 201);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.balance, 30);

  const conflicting = await api.request('POST', `/api/members/${memberId}/points/earn`, {
    body: { ...body, amount: 90 },
    token,
  });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const ledger = await api.request('GET', `/api/members/${memberId}/points`, { token });
  assert.equal(ledger.body.total, 1);
});

test('积分接口不能跨会员调用', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const alice = await api.registerMember({ email: 'points-owner@example.com' });
  const bob = await api.registerMember({ email: 'points-thief@example.com' });

  const stolen = await api.request('POST', `/api/members/${alice.body.member.id}/points/earn`, {
    body: { amount: 999 },
    token: bob.body.token,
  });
  assert.equal(stolen.status, 403);
});
