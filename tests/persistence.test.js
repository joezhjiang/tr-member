import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';

test('数据可落盘并在重启后恢复（会员、令牌、订阅）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-member-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataFile = join(dir, 'db.json');
  const now = () => '2026-05-10T09:00:00.000Z';

  const first = createApp({ dataFile, adminToken: 'admin', now });
  const { member, token } = first.ctx.services.members.register({ email: 'persist@example.com', name: '持久化' });
  const order = first.ctx.services.orders.create(member, { planId: 'plan_silver_monthly' });
  first.ctx.services.orders.pay(order);

  const second = createApp({ dataFile, adminToken: 'admin', now });
  const loaded = second.ctx.db.members.find((item) => item.id === member.id);
  assert.ok(loaded, '会员应被恢复');
  assert.equal(loaded.email, 'persist@example.com');
  assert.equal(loaded.growth, 200);
  assert.equal(loaded.pointsBalance, 100);
  assert.equal(second.ctx.services.members.findByToken(token)?.id, member.id, '令牌哈希应被恢复');

  const view = second.ctx.services.members.view(loaded);
  assert.equal(view.tier.code, 'silver');
  assert.equal(view.subscription.endAt, '2026-06-10T09:00:00.000Z');

  const subscriptions = second.ctx.db.subscriptions.filter((sub) => sub.memberId === member.id);
  assert.equal(subscriptions.length, 1);
});
