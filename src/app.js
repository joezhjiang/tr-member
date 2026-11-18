import { createStore } from './store/memoryStore.js';
import { createCatalogService } from './services/catalogService.js';
import { createMemberService } from './services/memberService.js';
import { createPointsService } from './services/pointsService.js';
import { createBenefitService } from './services/benefitService.js';
import { createSubscriptionService } from './services/subscriptionService.js';
import { createOrderService } from './services/orderService.js';
import { createMaintenanceService } from './services/maintenanceService.js';
import { buildRouter } from './http/routes.js';
import { createHandler } from './http/handler.js';

/**
 * 组装应用：存储 → 领域服务 → 路由 → HTTP handler。
 * now 可注入，便于测试中推进时间；dataFile 为空时纯内存运行。
 */
export function createApp({
  dataFile = null,
  adminToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  now = () => new Date().toISOString(),
} = {}) {
  const { db, persist } = createStore({ snapshotPath: dataFile });
  const ctx = { db, persist, now, config: { adminToken }, services: {} };

  ctx.services.catalog = createCatalogService(ctx);
  ctx.services.members = createMemberService(ctx);
  ctx.services.points = createPointsService(ctx);
  ctx.services.benefits = createBenefitService(ctx);
  ctx.services.subscriptions = createSubscriptionService(ctx);
  ctx.services.orders = createOrderService(ctx);
  ctx.services.maintenance = createMaintenanceService(ctx);

  const router = buildRouter(ctx);
  const handler = createHandler({ router, ctx });

  return { handler, ctx, db };
}
