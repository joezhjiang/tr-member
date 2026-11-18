/**
 * 统一的业务异常。HTTP 层据此映射状态码与错误码，
 * 服务层只关心语义，不关心 HTTP。
 */
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '缺少或无效的访问令牌') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = 'FORBIDDEN', message = '无权访问该资源', details = undefined) {
    super(403, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource, id) {
    super(404, 'NOT_FOUND', `${resource}不存在`, id === undefined ? undefined : { id });
  }
}

export class ConflictError extends AppError {
  constructor(code, message, details = undefined) {
    super(409, code, message, details);
  }
}
