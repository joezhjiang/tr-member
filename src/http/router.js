/** 极简路由：按 method + 路径段匹配，支持 :param 占位符，无第三方依赖。 */
import { ValidationError } from '../core/errors.js';

function splitPath(pathname) {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function decodeParam(name, raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    // 畸形百分号编码属于客户端错误，映射为 400 而不是 500（AC-10.2）
    throw new ValidationError('路径参数编码非法', { param: name });
  }
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler, options = {}) {
    routes.push({ method, segments: splitPath(pattern), handler, auth: options.auth ?? 'user' });
  }

  function match(method, pathname) {
    const parts = splitPath(pathname);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let matched = true;
      for (let index = 0; index < parts.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeParam(segment.slice(1), parts[index]);
        } else if (segment !== parts[index]) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  return {
    get: (pattern, handler, options) => add('GET', pattern, handler, options),
    post: (pattern, handler, options) => add('POST', pattern, handler, options),
    put: (pattern, handler, options) => add('PUT', pattern, handler, options),
    patch: (pattern, handler, options) => add('PATCH', pattern, handler, options),
    delete: (pattern, handler, options) => add('DELETE', pattern, handler, options),
    match,
    routes,
  };
}
