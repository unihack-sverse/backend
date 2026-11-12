export class AppError extends Error {
  constructor(code, status = 400, { message, details, retryAfter } = {}) {
    super(message ?? code.replaceAll('_', ' '));
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details ?? [];
    this.retryAfter = retryAfter;
  }
}

export const BadRequest = (code = 'bad_request', options) => new AppError(code, 400, options);
export const Unauthorized = (code = 'unauthorized', options) => new AppError(code, 401, options);
export const PaymentRequired = (code = 'insufficient_funds', options) => new AppError(code, 402, options);
export const Forbidden = (code = 'forbidden', options) => new AppError(code, 403, options);
export const NotFound = (code = 'not_found', options) => new AppError(code, 404, options);
export const Conflict = (code, options) => new AppError(code, 409, options);
export const Unprocessable = (code, options) => new AppError(code, 422, options);
export const RateLimited = (code = 'rate_limited', options) => new AppError(code, 429, options);
export const ServiceUnavailable = (code = 'service_unavailable', options) => new AppError(code, 503, options);
