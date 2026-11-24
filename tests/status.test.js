import assert from 'node:assert/strict';
import test from 'node:test';
import { startApi } from './helpers.js';

for (const status of ['frozen', 'cancelled']) {
  const expectedCode = status === 'frozen' ? 'MEMBER_FROZEN' : 'MEMBER_CANCELLED';

  test(`${status} 会员禁止写入型业务操作，但管理员读取不受影响`, async (t) => {
    const api = await startApi();
    t.after(() => api.close());

    const member = await api.registerMember({ email: `status-${status}@example.com` });
    const memberId = member.body.member.id;
    const token = member.body.token;
    const paid = await api.buyPlan(memberId, token, 'plan_silver_monthly');
    const pending = await api.createOrder(memberId, token, 'plan_silver_monthly');
    await api.request('POST', `/api/members/${memberId}/points/earn`, { body: { amount: 100 }, token });

    const changed = await api.request('PATCH', `/api/admin/members/${memberId}`, {
      body: { status },
      admin: true,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.member.status, status);

    const writes = [
      ['下单', await api.createOrder(memberId, token, 'plan_silver_monthly')],
      ['支付待支付订单', await api.request('POST', `/api/orders/${pending.body.order.id}/pay`, { token })],
      ['已支付订单重放支付', await api.request('POST', `/api/orders/${paid.order.id}/pay`, { token })],
      ['取消待支付订单', await api.request('POST', `/api/orders/${pending.body.order.id}/cancel`, { token })],
      ['退订订阅', await api.request('POST', `/api/subscriptions/${paid.subscription.id}/cancel`, { token })],
      ['轮换访问令牌', await api.request('POST', `/api/members/${memberId}/token/rotate`, { token })],
      ['权益核销', await api.request('POST', `/api/members/${memberId}/benefits/free_shipping/consume`, { body: {}, token })],
      ['积分获取', await api.request('POST', `/api/members/${memberId}/points/earn`, { body: { amount: 10 }, token })],
      ['积分消耗', await api.request('POST', `/api/members/${memberId}/points/spend`, { body: { amount: 10 }, token })],
    ];
    for (const [name, response] of writes) {
      assert.equal(response.status, 403, `${name} 应被状态闸门拦截`);
      assert.equal(response.body.error.code, expectedCode, name);
    }

    const reads = [
      ['档案', await api.request('GET', `/api/members/${memberId}`, { admin: true })],
      ['权益', await api.request('GET', `/api/members/${memberId}/benefits`, { admin: true })],
      ['积分', await api.request('GET', `/api/members/${memberId}/points`, { admin: true })],
      ['订阅', await api.request('GET', `/api/members/${memberId}/subscriptions`, { admin: true })],
      ['订单', await api.request('GET', `/api/members/${memberId}/orders`, { admin: true })],
    ];
    for (const [name, response] of reads) {
      assert.equal(response.status, 200, `${name} 读取不应受会员状态影响`);
    }
  });
}

test('冻结期间拦截支付重放，恢复 active 后重放仍幂等且不重复发放', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'status-replay@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  const paid = await api.buyPlan(memberId, token, 'plan_gold_monthly');
  const grantCountBefore = api.app.ctx.db.benefitGrants.length;

  await api.request('PATCH', `/api/admin/members/${memberId}`, { body: { status: 'frozen' }, admin: true });
  const blocked = await api.request('POST', `/api/orders/${paid.order.id}/pay`, { token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'MEMBER_FROZEN');

  await api.request('PATCH', `/api/admin/members/${memberId}`, { body: { status: 'active' }, admin: true });
  const replay = await api.request('POST', `/api/orders/${paid.order.id}/pay`, { token });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.order.status, 'paid');

  const profile = await api.request('GET', `/api/members/${memberId}`, { token });
  assert.equal(profile.body.member.growth, 500);
  assert.equal(profile.body.member.pointsBalance, 300);
  const subscriptions = await api.request('GET', `/api/members/${memberId}/subscriptions`, { token });
  assert.equal(subscriptions.body.total, 1);
  assert.equal(api.app.ctx.db.benefitGrants.length, grantCountBefore);
});
