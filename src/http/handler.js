import { AppError, UnauthorizedError, ValidationError } from '../core/errors.js';
import { newId, safeEqual } from '../core/ids.js';

const MAX_BODY_BYTES = 1_048_576;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 1MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (!raw || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function createHandler({ router, ctx }) {
  const { config, services } = ctx;

  function resolveActor(req) {
    const adminToken = req.headers['x-admin-token'];
    if (typeof adminToken === 'string' && adminToken.length > 0) {
      return safeEqual(adminToken, config.adminToken) ? { type: 'admin' } : null;
    }
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : null;
    const token = bearer ?? (typeof req.headers['x-member-token'] === 'string' ? req.headers['x-member-token'] : null);
    if (!token) return null;
    const member = services.members.findByToken(token);
    return member ? { type: 'member', member } : null;
  }

  return async function handler(req, res) {
    const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : newId('req');
    res.setHeader('x-request-id', requestId);

    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) {
        throw new AppError(404, 'NOT_FOUND', `接口不存在：${req.method} ${url.pathname}`);
      }

      const actor = resolveActor(req);
      if (matched.route.auth === 'admin' && actor?.type !== 'admin') {
        throw new UnauthorizedError('该接口需要管理员令牌');
      }
      if (matched.route.auth === 'user' && actor === null) {
        throw new UnauthorizedError();
      }

      const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
        ? parseJsonBody(await readRawBody(req))
        : {};

      const result = await matched.route.handler({
        req,
        res,
        url,
        params: matched.params,
        query: url.searchParams,
        body,
        actor,
        ctx,
        requestId,
      });

      const payload = result?.body ?? result ?? {};
      sendJson(res, result?.status ?? 200, payload);
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(res, error.status, {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
            requestId,
          },
        });
        return;
      }
      console.error(`[${requestId}] 未处理异常`, error);
      sendJson(res, 500, {
        error: { code: 'INTERNAL_ERROR', message: '服务内部错误', requestId },
      });
    }
  };
}
