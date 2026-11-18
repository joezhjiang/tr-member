/**
 * 默认商品与权益配置。管理员可通过接口调整，但这些默认值是系统冷启动的唯一来源，
 * 也作为测试基线：等级门槛、套餐价格与权益配额都在这里集中定义。
 */

export const DEFAULT_TIERS = [
  { code: 'free', name: '普通会员', rank: 0, growthThreshold: 0, description: '注册即享有，长期有效' },
  { code: 'silver', name: '白银会员', rank: 1, growthThreshold: 500, description: '成长值达到 500 或订阅白银套餐' },
  { code: 'gold', name: '黄金会员', rank: 2, growthThreshold: 2000, description: '成长值达到 2000 或订阅黄金套餐' },
  { code: 'platinum', name: '铂金会员', rank: 3, growthThreshold: 8000, description: '成长值达到 8000 或订阅铂金套餐' },
];

export const DEFAULT_BENEFIT_DEFS = [
  { code: 'free_shipping', name: '免邮券', unit: '次', description: '下单免运费，按自然月发放' },
  { code: 'exclusive_coupon', name: '专属优惠券', unit: '张', description: '会员专享折扣券，按自然月发放' },
  { code: 'priority_support', name: '优先客服', unit: '次', description: '客服工单优先处理' },
  { code: 'birthday_gift', name: '生日礼包', unit: '份', description: '每个会员账号仅发放一次' },
  { code: 'vip_hotline', name: '专属热线', unit: '次', description: '铂金会员专属客服热线' },
];

export const DEFAULT_BENEFIT_RULES = [
  { tierCode: 'silver', benefitCode: 'free_shipping', quota: 4, period: 'monthly' },
  { tierCode: 'silver', benefitCode: 'exclusive_coupon', quota: 2, period: 'monthly' },
  { tierCode: 'silver', benefitCode: 'priority_support', quota: 1, period: 'monthly' },
  { tierCode: 'gold', benefitCode: 'free_shipping', quota: 10, period: 'monthly' },
  { tierCode: 'gold', benefitCode: 'exclusive_coupon', quota: 6, period: 'monthly' },
  { tierCode: 'gold', benefitCode: 'priority_support', quota: 4, period: 'monthly' },
  { tierCode: 'gold', benefitCode: 'birthday_gift', quota: 1, period: 'lifetime' },
  { tierCode: 'platinum', benefitCode: 'free_shipping', quota: 30, period: 'monthly' },
  { tierCode: 'platinum', benefitCode: 'exclusive_coupon', quota: 12, period: 'monthly' },
  { tierCode: 'platinum', benefitCode: 'priority_support', quota: 8, period: 'monthly' },
  { tierCode: 'platinum', benefitCode: 'birthday_gift', quota: 1, period: 'lifetime' },
  { tierCode: 'platinum', benefitCode: 'vip_hotline', quota: 5, period: 'monthly' },
];

export const DEFAULT_PLANS = [
  {
    id: 'plan_silver_monthly',
    code: 'silver_monthly',
    name: '白银会员 · 月卡',
    tierCode: 'silver',
    periodMonths: 1,
    priceCents: 1900,
    currency: 'CNY',
    growth: 200,
    bonusPoints: 100,
    active: true,
  },
  {
    id: 'plan_silver_yearly',
    code: 'silver_yearly',
    name: '白银会员 · 年卡',
    tierCode: 'silver',
    periodMonths: 12,
    priceCents: 19900,
    currency: 'CNY',
    growth: 2600,
    bonusPoints: 800,
    active: true,
  },
  {
    id: 'plan_gold_monthly',
    code: 'gold_monthly',
    name: '黄金会员 · 月卡',
    tierCode: 'gold',
    periodMonths: 1,
    priceCents: 4900,
    currency: 'CNY',
    growth: 500,
    bonusPoints: 300,
    active: true,
  },
  {
    id: 'plan_gold_yearly',
    code: 'gold_yearly',
    name: '黄金会员 · 年卡',
    tierCode: 'gold',
    periodMonths: 12,
    priceCents: 49900,
    currency: 'CNY',
    growth: 6500,
    bonusPoints: 2500,
    active: true,
  },
  {
    id: 'plan_platinum_monthly',
    code: 'platinum_monthly',
    name: '铂金会员 · 月卡',
    tierCode: 'platinum',
    periodMonths: 1,
    priceCents: 9900,
    currency: 'CNY',
    growth: 1000,
    bonusPoints: 800,
    active: true,
  },
  {
    id: 'plan_platinum_yearly',
    code: 'platinum_yearly',
    name: '铂金会员 · 年卡',
    tierCode: 'platinum',
    periodMonths: 12,
    priceCents: 99900,
    currency: 'CNY',
    growth: 13000,
    bonusPoints: 6000,
    active: true,
  },
];
