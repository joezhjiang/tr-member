import { ForbiddenError } from '../core/errors.js';
import { requireInt } from '../core/validate.js';
import { createRouter } from './router.js';

function paginationOf(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const rawLimit = query.get('limit');
  const rawOffset = query.get('offset');
  const limit = rawLimit === null ? defaultLimit : requireInt({ limit: Number(rawLimit) }, 'limit', { min: 1, max: maxLimit });
  const offset = rawOffset === null ? 0 : requireInt({ offset: Number(rawOffset) }, 'offset', { min: 0, max: 1_000_000 });
  return { limit, offset };
}

export function buildRouter(ctx) {
  const router = createRouter();
  const s = () => ctx.services;

  /** 会员态接口：本人或管理员可访问 */
  function assertOwner(actor, memberId) {
    if (actor?.type === 'admin') return;
    if (actor?.type === 'member' && actor.member.id === memberId) return;
    throw new ForbiddenError('FORBIDDEN', '无权访问其他会员的数据');
  }

  function loadOwnedOrder(orderId, actor) {
    const order = s().orders.get(orderId);
    assertOwner(actor, order.memberId);
    return order;
  }

  // ---------- 公开：元数据 ----------
  router.get('/health', () => ({ status: 200, body: { status: 'ok', now: ctx.now() } }), { auth: 'public' });

  router.get('/api/tiers', () => ({ body: { items: s().catalog.listTiers() } }), { auth: 'public' });

  router.get(
    '/api/plans',
    ({ query }) => ({
      body: { items: s().catalog.listPlans({ activeOnly: query.get('includeInactive') !== 'true' }) },
    }),
    { auth: 'public' },
  );

  router.get('/api/benefits', () => ({ body: { items: s().catalog.listBenefitDefs() } }), { auth: 'public' });

  // ---------- 会员 ----------
  router.post(
    '/api/members',
    ({ body }) => {
      const { member, token } = s().members.register(body);
      return { status: 201, body: { member: s().members.view(member), token } };
    },
    { auth: 'public' },
  );

  router.get(
    '/api/members/:id',
    ({ params, actor }) => {
      assertOwner(actor, params.id);
      return { body: { member: s().members.view(s().members.get(params.id)) } };
    },
  );

  router.post(
    '/api/members/:id/token/rotate',
    ({ params, actor }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      return { body: { memberId: member.id, token: s().members.rotateToken(member) } };
    },
  );

  router.get(
    '/api/members/:id/subscriptions',
    ({ params, actor }) => {
      assertOwner(actor, params.id);
      s().members.get(params.id);
      const items = s().subscriptions.listByMember(params.id).map((sub) => s().subscriptions.view(sub));
      return { body: { items, total: items.length } };
    },
  );

  router.get(
    '/api/members/:id/benefits',
    ({ params, actor }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      return { body: s().benefits.listForMember(member) };
    },
  );

  router.post(
    '/api/members/:id/benefits/:code/consume',
    ({ params, actor, body }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      s().members.requireActive(member);
      return { body: s().benefits.consume(member, params.code, body) };
    },
  );

  // ---------- 积分 ----------
  router.get(
    '/api/members/:id/points',
    ({ params, actor, query }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      const { limit } = paginationOf(query, { defaultLimit: 20, maxLimit: 100 });
      return { body: { balance: member.pointsBalance, ...s().points.list(member.id, { limit }) } };
    },
  );

  router.post(
    '/api/members/:id/points/earn',
    ({ params, actor, body }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      s().members.requireActive(member);
      return { status: 201, body: s().points.earn(member, body) };
    },
  );

  router.post(
    '/api/members/:id/points/spend',
    ({ params, actor, body }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      s().members.requireActive(member);
      return { status: 201, body: s().points.spend(member, body) };
    },
  );

  // ---------- 订单与支付 ----------
  router.get(
    '/api/members/:id/orders',
    ({ params, actor }) => {
      assertOwner(actor, params.id);
      const items = s().orders.listByMember(params.id).map((order) => s().orders.view(order));
      return { body: { items, total: items.length } };
    },
  );

  router.post(
    '/api/members/:id/orders',
    ({ params, actor, body }) => {
      assertOwner(actor, params.id);
      const member = s().members.get(params.id);
      const order = s().orders.create(member, body);
      return { status: 201, body: { order: s().orders.view(order) } };
    },
  );

  router.get('/api/orders/:id', ({ params, actor }) => ({ body: { order: s().orders.view(loadOwnedOrder(params.id, actor)) } }));

  router.post('/api/orders/:id/pay', ({ params, actor }) => {
    const order = loadOwnedOrder(params.id, actor);
    const result = s().orders.pay(order, { source: 'api' });
    return {
      body: {
        order: s().orders.view(result.order),
        subscription: result.subscription ? s().subscriptions.view(result.subscription) : null,
        action: result.action,
        idempotent: result.idempotent,
      },
    };
  });

  router.post('/api/orders/:id/cancel', ({ params, actor }) => {
    const order = loadOwnedOrder(params.id, actor);
    return { body: { order: s().orders.view(s().orders.cancel(order)) } };
  });

  router.post('/api/subscriptions/:id/cancel', ({ params, actor, body }) => {
    const subscription = s().subscriptions.get(params.id);
    assertOwner(actor, subscription.memberId);
    const cancelled = s().subscriptions.cancel(subscription, { reason: body?.reason ?? null });
    const revokedGrants = s().benefits.revokeBySubscription(cancelled.id);
    return { body: { subscription: s().subscriptions.view(cancelled), revokedGrants } };
  });

  // ---------- 管理端 ----------
  router.get(
    '/api/admin/members',
    ({ query }) => {
      const status = query.get('status') ?? undefined;
      return { body: s().members.list({ status, ...paginationOf(query) }) };
    },
    { auth: 'admin' },
  );

  router.patch(
    '/api/admin/members/:id',
    ({ params, body }) => {
      const member = s().members.setStatus(params.id, body);
      return { body: { member: s().members.view(member) } };
    },
    { auth: 'admin' },
  );

  router.post(
    '/api/admin/orders/:id/refund',
    ({ params, body }) => {
      const order = s().orders.get(params.id);
      const result = s().orders.refund(order, body);
      return {
        body: {
          order: s().orders.view(result.order),
          cancelledSubscription: result.cancelledSubscription
            ? s().subscriptions.view(result.cancelledSubscription)
            : null,
          revokedGrants: result.revokedGrants,
          clawedBackPoints: result.clawedBackPoints,
        },
      };
    },
    { auth: 'admin' },
  );

  router.put(
    '/api/admin/tiers/:code/benefits',
    ({ params, body }) => ({ body: { tier: s().catalog.replaceTierBenefits(params.code, body) } }),
    { auth: 'admin' },
  );

  router.post(
    '/api/admin/plans',
    ({ body }) => ({ status: 201, body: { plan: s().catalog.createPlan(body) } }),
    { auth: 'admin' },
  );

  router.patch(
    '/api/admin/plans/:id',
    ({ params, body }) => ({ body: { plan: s().catalog.updatePlan(params.id, body) } }),
    { auth: 'admin' },
  );

  router.post('/api/admin/maintenance/run', () => ({ body: s().maintenance.run() }), { auth: 'admin' });

  return router;
}
