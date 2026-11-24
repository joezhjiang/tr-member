import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/core/errors.js';
import { startApi } from './helpers.js';

async function rawRequest(api, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${api.baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  return {
    status: response.status,
    requestIdHeader: response.headers.get('x-request-id'),
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

test('成功响应与错误响应都带一致的 x-request-id', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const health = await rawRequest(api, '/health');
  assert.equal(health.status, 200);
  assert.match(health.requestIdHeader, /^req_/);

  const passed = await rawRequest(api, '/api/not-found', { headers: { 'x-request-id': 'req_fixed_123' } });
  assert.equal(passed.status, 404);
  assert.equal(passed.requestIdHeader, 'req_fixed_123');
  assert.equal(passed.body.error.requestId, 'req_fixed_123');
  assert.equal(passed.body.error.code, 'NOT_FOUND');
  assert.equal(passed.body.error.details, null);

  const generated = await rawRequest(api, '/api/not-found');
  assert.match(generated.requestIdHeader, /^req_/);
  assert.equal(generated.body.error.requestId, generated.requestIdHeader);
});

test('请求体超过 1MB 时稳定返回 413 而不是连接重置', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const response = await rawRequest(api, '/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filler: 'x'.repeat(1_048_576) }),
  });

  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(response.body.error.details, null);
  assert.equal(response.body.error.requestId, response.requestIdHeader);
});

test('非法 JSON 返回 400 VALIDATION_ERROR', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const response = await rawRequest(api, '/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.equal(response.body.error.details, null);
  assert.equal(response.body.error.requestId, response.requestIdHeader);
});

test('AppError 无细节时 details 为 null，有细节时原样保留', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const notFound = await api.request('GET', '/api/not-found');
  assert.equal(notFound.status, 404);
  assert.ok('details' in notFound.body.error);
  assert.equal(notFound.body.error.details, null);

  const duplicate = await api.registerMember({ email: 'error-details@example.com' });
  const conflict = await api.request('POST', '/api/members', {
    body: { email: duplicate.body.member.email, name: '重复注册' },
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.error.details, { email: 'error-details@example.com' });

  api.app.ctx.services.members.register = () => {
    throw new AppError(409, 'TEST_CONFLICT', '无细节的业务冲突');
  };
  const injected = await api.request('POST', '/api/members', { body: { email: 'x@example.com', name: '测试' } });
  assert.equal(injected.status, 409);
  assert.equal(injected.body.error.code, 'TEST_CONFLICT');
  assert.equal(injected.body.error.details, null);
});

test('畸形路径编码返回 400 VALIDATION_ERROR 而不是 500', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'bad-uri@example.com' });
  const response = await rawRequest(api, '/api/members/%E0%A4%A', {
    headers: { authorization: `Bearer ${member.body.token}` },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.equal(response.body.error.requestId, response.requestIdHeader);
});

test('列表接口分页：limit 生效、越界返回 400', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const member = await api.registerMember({ email: 'paging@example.com' });
  const memberId = member.body.member.id;
  const token = member.body.token;
  await api.buyPlan(memberId, token, 'plan_silver_monthly');
  await api.buyPlan(memberId, token, 'plan_gold_monthly');

  const subs = await api.request('GET', `/api/members/${memberId}/subscriptions?limit=1`, { token });
  assert.equal(subs.status, 200);
  assert.equal(subs.body.items.length, 1);
  assert.equal(subs.body.total, 2);
  assert.equal(subs.body.limit, 1);

  const orders = await api.request('GET', `/api/members/${memberId}/orders?limit=1&offset=1`, { token });
  assert.equal(orders.status, 200);
  assert.equal(orders.body.items.length, 1);
  assert.equal(orders.body.total, 2);
  assert.equal(orders.body.offset, 1);

  const tooLarge = await api.request('GET', `/api/members/${memberId}/subscriptions?limit=101`, { token });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.body.error.code, 'VALIDATION_ERROR');

  const tiers = await api.request('GET', '/api/tiers?limit=2');
  assert.equal(tiers.status, 200);
  assert.equal(tiers.body.items.length, 2);
  assert.equal(tiers.body.total, 4);
});

test('未处理异常映射为 500 INTERNAL_ERROR 且 details 为 null', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });

  const member = await api.registerMember({ email: 'internal-error@example.com' });
  api.app.ctx.services.members.view = () => {
    throw new Error('未处理异常');
  };

  const response = await rawRequest(api, `/api/members/${member.body.member.id}`, {
    headers: { authorization: `Bearer ${member.body.token}`, 'x-request-id': 'req_500_case' },
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  assert.equal(response.body.error.details, null);
  assert.equal(response.body.error.requestId, 'req_500_case');
  assert.equal(response.requestIdHeader, 'req_500_case');
});
