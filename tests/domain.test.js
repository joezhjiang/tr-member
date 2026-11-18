import assert from 'node:assert/strict';
import test from 'node:test';
import { addMonthsIso, endOfMonthIso, monthKeyOf } from '../src/domain/time.js';
import { growthTierOf, resolveMembership } from '../src/domain/tierRules.js';
import { DEFAULT_TIERS } from '../src/domain/catalog.js';

test('addMonthsIso 处理月末收敛', () => {
  assert.equal(addMonthsIso('2026-01-31T00:00:00.000Z', 1), '2026-02-28T00:00:00.000Z');
  assert.equal(addMonthsIso('2026-03-15T08:30:00.000Z', 12), '2027-03-15T08:30:00.000Z');
  assert.equal(addMonthsIso('2024-02-29T00:00:00.000Z', 12), '2025-02-28T00:00:00.000Z');
});

test('endOfMonthIso / monthKeyOf 按 UTC 自然月计算', () => {
  assert.equal(endOfMonthIso('2026-02-10T00:00:00.000Z'), '2026-02-28T23:59:59.999Z');
  assert.equal(endOfMonthIso('2026-12-01T00:00:00.000Z'), '2026-12-31T23:59:59.999Z');
  assert.equal(monthKeyOf('2026-07-04T12:00:00.000Z'), '2026-07');
});

test('growthTierOf 取门槛内最高等级', () => {
  assert.equal(growthTierOf(DEFAULT_TIERS, 0).code, 'free');
  assert.equal(growthTierOf(DEFAULT_TIERS, 499).code, 'free');
  assert.equal(growthTierOf(DEFAULT_TIERS, 500).code, 'silver');
  assert.equal(growthTierOf(DEFAULT_TIERS, 2500).code, 'gold');
  assert.equal(growthTierOf(DEFAULT_TIERS, 99_999).code, 'platinum');
});

test('resolveMembership 付费等级高于成长值等级时以付费为准', () => {
  const member = { id: 'mem_1', growth: 0 };
  const subscriptions = [
    {
      id: 'sub_1',
      memberId: 'mem_1',
      tierCode: 'gold',
      status: 'active',
      endAt: '2026-04-01T00:00:00.000Z',
    },
  ];
  const result = resolveMembership({
    tiers: DEFAULT_TIERS,
    member,
    subscriptions,
    nowIso: '2026-03-02T00:00:00.000Z',
  });
  assert.equal(result.tier.code, 'gold');
  assert.equal(result.source, 'subscription');
  assert.equal(result.growthTier.code, 'free');
});

test('resolveMembership 订阅过期后回落到成长值等级', () => {
  const member = { id: 'mem_2', growth: 800 };
  const subscriptions = [
    {
      id: 'sub_2',
      memberId: 'mem_2',
      tierCode: 'platinum',
      status: 'active',
      endAt: '2026-03-01T00:00:00.000Z',
    },
  ];
  const result = resolveMembership({
    tiers: DEFAULT_TIERS,
    member,
    subscriptions,
    nowIso: '2026-03-02T00:00:00.000Z',
  });
  assert.equal(result.tier.code, 'silver');
  assert.equal(result.source, 'growth');
  assert.equal(result.subscription, null);
});

test('resolveMembership 成长值等级更高时忽略付费等级', () => {
  const member = { id: 'mem_3', growth: 9000 };
  const subscriptions = [
    { id: 'sub_3', memberId: 'mem_3', tierCode: 'silver', status: 'active', endAt: '2026-04-01T00:00:00.000Z' },
  ];
  const result = resolveMembership({
    tiers: DEFAULT_TIERS,
    member,
    subscriptions,
    nowIso: '2026-03-02T00:00:00.000Z',
  });
  assert.equal(result.tier.code, 'platinum');
  assert.equal(result.source, 'growth');
});
