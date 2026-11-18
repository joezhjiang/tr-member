import { ConflictError, NotFoundError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import {
  oneOf,
  optionalBoolean,
  optionalInt,
  optionalString,
  requireArray,
  requireInt,
  requireObject,
  requireString,
} from '../core/validate.js';
import { sortByRankAsc } from '../domain/tierRules.js';

const PERIODS = ['monthly', 'lifetime'];

export function createCatalogService(ctx) {
  const { db, persist } = ctx;

  function listTiers() {
    return sortByRankAsc(db.tiers).map((tier) => ({
      ...tier,
      benefits: db.benefitRules
        .filter((rule) => rule.tierCode === tier.code)
        .map((rule) => {
          const def = db.benefitDefs.find((item) => item.code === rule.benefitCode);
          return {
            code: rule.benefitCode,
            name: def?.name ?? rule.benefitCode,
            unit: def?.unit ?? '次',
            quota: rule.quota,
            period: rule.period,
          };
        }),
    }));
  }

  function getTier(code) {
    const tier = db.tiers.find((item) => item.code === code);
    if (!tier) throw new NotFoundError('会员等级', code);
    return tier;
  }

  function tierRank(code) {
    return db.tiers.find((item) => item.code === code)?.rank ?? -1;
  }

  function listPlans({ activeOnly = true } = {}) {
    return db.plans
      .filter((plan) => (activeOnly ? plan.active : true))
      .map((plan) => ({ ...plan, tierName: db.tiers.find((t) => t.code === plan.tierCode)?.name ?? plan.tierCode }));
  }

  function getPlan(planId) {
    const plan = db.plans.find((item) => item.id === planId);
    if (!plan) throw new NotFoundError('套餐', planId);
    return plan;
  }

  function listBenefitDefs() {
    return [...db.benefitDefs];
  }

  function replaceTierBenefits(tierCode, body) {
    requireObject(body);
    getTier(tierCode);
    const items = requireArray(body, 'benefits', { min: 1, max: 50 });
    const next = items.map((raw, index) => {
      const item = requireObject(raw, `benefits[${index}]`);
      const benefitCode = requireString(item, 'benefitCode', { max: 64, pattern: /^[a-z][a-z0-9_]*$/, patternHint: '小写字母、数字与下划线' });
      if (!db.benefitDefs.some((def) => def.code === benefitCode)) {
        throw new NotFoundError('权益定义', benefitCode);
      }
      const quota = requireInt(item, 'quota', { min: 1, max: 999 });
      const period = oneOf(item, 'period', PERIODS);
      return { tierCode, benefitCode, quota, period };
    });
    db.benefitRules = db.benefitRules.filter((rule) => rule.tierCode !== tierCode).concat(next);
    persist();
    return listTiers().find((tier) => tier.code === tierCode);
  }

  function createPlan(body) {
    requireObject(body);
    const code = requireString(body, 'code', { max: 40, pattern: /^[a-z][a-z0-9_]*$/, patternHint: '小写字母、数字与下划线' });
    if (db.plans.some((plan) => plan.code === code)) {
      throw new ConflictError('PLAN_CODE_TAKEN', '套餐编码已存在', { code });
    }
    const tierCode = oneOf(body, 'tierCode', db.tiers.map((tier) => tier.code));
    const plan = {
      id: newId('plan'),
      code,
      name: requireString(body, 'name', { max: 80 }),
      tierCode,
      periodMonths: requireInt(body, 'periodMonths', { min: 1, max: 36 }),
      priceCents: requireInt(body, 'priceCents', { min: 0, max: 10_000_000 }),
      currency: optionalString(body, 'currency', { max: 8 }) ?? 'CNY',
      growth: optionalInt(body, 'growth', { min: 0, max: 1_000_000 }) ?? 0,
      bonusPoints: optionalInt(body, 'bonusPoints', { min: 0, max: 1_000_000 }) ?? 0,
      active: optionalBoolean(body, 'active', { fallback: true }),
    };
    db.plans.push(plan);
    persist();
    return plan;
  }

  function updatePlan(planId, body) {
    requireObject(body);
    const plan = getPlan(planId);
    if (body.name !== undefined) plan.name = requireString(body, 'name', { max: 80 });
    if (body.priceCents !== undefined) plan.priceCents = requireInt(body, 'priceCents', { min: 0, max: 10_000_000 });
    if (body.growth !== undefined) plan.growth = requireInt(body, 'growth', { min: 0, max: 1_000_000 });
    if (body.bonusPoints !== undefined) plan.bonusPoints = requireInt(body, 'bonusPoints', { min: 0, max: 1_000_000 });
    if (body.active !== undefined) plan.active = optionalBoolean(body, 'active', { fallback: plan.active });
    if (body.tierCode !== undefined) plan.tierCode = oneOf(body, 'tierCode', db.tiers.map((tier) => tier.code));
    if (body.periodMonths !== undefined) plan.periodMonths = requireInt(body, 'periodMonths', { min: 1, max: 36 });
    persist();
    return plan;
  }

  return {
    listTiers,
    getTier,
    tierRank,
    listPlans,
    getPlan,
    listBenefitDefs,
    replaceTierBenefits,
    createPlan,
    updatePlan,
  };
}
