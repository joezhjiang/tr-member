import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { endOfMonthIso } from '../src/domain/time.js';

test('数据可落盘并在重启后恢复（会员、令牌、订阅、订单、积分流水、权益授权）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-member-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataFile = join(dir, 'db.json');
  const now = () => '2026-05-10T09:00:00.000Z';

  const first = createApp({ dataFile, adminToken: 'admin', now });
  const { member, token } = first.ctx.services.members.register({ email: 'persist@example.com', name: '持久化' });
  const order = first.ctx.services.orders.create(member, { planId: 'plan_silver_monthly' });
  first.ctx.services.orders.pay(order);
  first.ctx.services.points.earn(member, { amount: 500, reason: '测试 earns', idempotencyKey: 'persist-earn-1' });
  first.ctx.services.points.spend(member, { amount: 200, reason: '测试 spends', idempotencyKey: 'persist-spend-1' });
  first.ctx.services.benefits.consume(member, 'free_shipping', { quantity: 2 });

  const snapshot = readFileSync(dataFile, 'utf8');
  assert.ok(!snapshot.includes(token), '快照不得包含明文令牌');
  assert.ok(!existsSync(`${dataFile}.${process.pid}.tmp`), '原子写入后不应残留临时文件');

  const second = createApp({ dataFile, adminToken: 'admin', now });
  const loaded = second.ctx.db.members.find((item) => item.id === member.id);
  assert.ok(loaded, '会员应被恢复');
  assert.equal(loaded.email, 'persist@example.com');
  assert.equal(loaded.growth, 200);
  assert.equal(loaded.pointsBalance, 400);
  assert.ok(loaded.tokenHash, '令牌哈希应被恢复');
  assert.equal(second.ctx.services.members.findByToken(token)?.id, member.id, '令牌哈希仍可用于鉴权');

  const view = second.ctx.services.members.view(loaded);
  assert.equal(view.tier.code, 'silver');
  assert.equal(view.subscription.endAt, '2026-06-10T09:00:00.000Z');

  const subscriptions = second.ctx.db.subscriptions.filter((sub) => sub.memberId === member.id);
  assert.equal(subscriptions.length, 1);
  const subscription = subscriptions[0];

  const restoredOrder = second.ctx.db.orders.find((item) => item.id === order.id);
  assert.ok(restoredOrder, '订单应被恢复');
  assert.equal(restoredOrder.status, 'paid');
  assert.equal(restoredOrder.amountCents, 1900);
  assert.equal(restoredOrder.growthAwarded, 200);
  assert.equal(restoredOrder.pointsAwarded, 100);
  assert.ok(restoredOrder.paidAt);

  const earnEntry = second.ctx.db.pointEntries.find((entry) => entry.idempotencyKey === 'persist-earn-1');
  const spendEntry = second.ctx.db.pointEntries.find((entry) => entry.idempotencyKey === 'persist-spend-1');
  assert.ok(earnEntry && spendEntry, '积分流水应被恢复');
  assert.equal(earnEntry.type, 'earn');
  assert.equal(earnEntry.delta, 500);
  assert.equal(earnEntry.balanceAfter, 600);
  assert.equal(spendEntry.type, 'spend');
  assert.equal(spendEntry.delta, -200);
  assert.equal(spendEntry.balanceAfter, 400);

  const grant = second.ctx.db.benefitGrants.find(
    (item) => item.memberId === member.id && item.benefitCode === 'free_shipping' && item.status === 'active',
  );
  assert.ok(grant, '权益授权应被恢复');
  assert.equal(grant.period, 'monthly');
  assert.equal(grant.periodKey, '2026-05');
  assert.equal(grant.quota, 4);
  assert.equal(grant.remaining, 2);
  assert.equal(grant.validUntil, endOfMonthIso(now()));
  assert.equal(grant.sourceSubscriptionId, subscription.id);

  const replayed = second.ctx.services.points.earn(loaded, {
    amount: 500,
    reason: '重启后重复 earn',
    idempotencyKey: 'persist-earn-1',
  });
  assert.equal(replayed.idempotent, true);
  assert.equal(replayed.entry.id, earnEntry.id);
  assert.equal(loaded.pointsBalance, 400, '幂等重放不应再次改变余额');
});
