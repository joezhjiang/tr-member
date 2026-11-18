import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { addDaysIso, addMonthsIso } from '../src/domain/time.js';

export const ADMIN_TOKEN = 'test-admin-token';
export const START_TIME = new Date('2026-03-02T10:00:00.000Z');

export async function startApi({ now = START_TIME } = {}) {
  const clock = { current: new Date(now) };
  const app = createApp({ adminToken: ADMIN_TOKEN, now: () => clock.current.toISOString() });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, path, { body, token, admin = false, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    if (body !== undefined) finalHeaders['content-type'] = 'application/json';
    if (token) finalHeaders.authorization = `Bearer ${token}`;
    if (admin) finalHeaders['x-admin-token'] = ADMIN_TOKEN;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  }

  let memberSeq = 0;
  async function registerMember(overrides = {}) {
    memberSeq += 1;
    const response = await request('POST', '/api/members', {
      body: { email: `member${memberSeq}@example.com`, name: `测试会员${memberSeq}`, ...overrides },
    });
    return response;
  }

  async function createOrder(memberId, token, planId, extra = {}) {
    return request('POST', `/api/members/${memberId}/orders`, {
      body: { planId, ...extra },
      token,
    });
  }

  async function buyPlan(memberId, token, planId, extra = {}) {
    const created = await createOrder(memberId, token, planId, extra);
    if (created.status !== 201) return { create: created, pay: null };
    const paid = await request('POST', `/api/orders/${created.body.order.id}/pay`, { token });
    return { create: created, pay: paid, order: paid.body?.order, subscription: paid.body?.subscription };
  }

  function setTime(value) {
    clock.current = new Date(value);
  }

  function advanceDays(days) {
    clock.current = new Date(addDaysIso(clock.current.toISOString(), days));
  }

  function advanceMonths(months) {
    clock.current = new Date(addMonthsIso(clock.current.toISOString(), months));
  }

  return {
    app,
    request,
    registerMember,
    createOrder,
    buyPlan,
    clock,
    setTime,
    advanceDays,
    advanceMonths,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
