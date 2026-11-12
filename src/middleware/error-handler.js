import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError('route_not_found', 404, { message: `No route for ${req.method} ${req.path}` }));
}

export function errorHandler(error, req, res, _next) {
  const requestId = req.id;

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'malformed_json', message: 'Body is not valid JSON.', details: [], requestId } });
  }

  if (error?.name === 'ZodError') {
    return res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Request validation failed.',
        details: error.issues.map((issue) => ({ field: issue.path.join('.'), issue: issue.message })),
        requestId,
      },
    });
  }

  if (error instanceof AppError) {
    if (error.status >= 500) (req.log ?? logger).error({ err: error, code: error.code }, 'app_error');
    if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
  }

  if (error?.name === 'MongoServerError' && error.code === 11000) {
    return res.status(409).json({
      error: {
        code: 'duplicate_key',
        message: 'A unique resource already exists.',
        details: Object.keys(error.keyPattern ?? {}).map((field) => ({ field, issue: 'not_unique' })),
        requestId,
      },
    });
  }

  if (error?.name === 'ValidationError' && error.errors) {
    return res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Document validation failed.',
        details: Object.entries(error.errors).map(([field, value]) => ({ field, issue: value.message })),
        requestId,
      },
    });
  }

  (req.log ?? logger).error({ err: error }, 'unexpected_error');
  return res.status(500).json({
    error: { code: 'internal_error', message: 'Unexpected server error.', details: [], requestId },
  });
}
