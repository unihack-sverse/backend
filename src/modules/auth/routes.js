import { Router } from 'express';

import { asyncHandler } from '../../lib/async-handler.js';
import { byIp, rateLimit } from '../../middleware/rate-limit.js';
import { requireSession } from '../../middleware/session-auth.js';
import { validate } from '../../middleware/validate.js';
import { authController } from './controllers/auth.controller.js';
import { forgotSchema, loginSchema, registerSchema, resetSchema, verifyEmailSchema } from './schemas/auth.schema.js';

export function authRoutes() {
  const router = Router();
  const loginLimit = rateLimit({
    name: 'login',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    durable: true,
    key: (req) => `${String(req.body?.email ?? '').toLowerCase()}:${req.ip}`,
  });

  router.post(
    '/register',
    rateLimit({ name: 'register', limit: 10, windowMs: 60 * 60 * 1000, key: byIp, durable: true }),
    validate(registerSchema),
    asyncHandler(authController.register),
  );
  router.post('/login', loginLimit, validate(loginSchema), asyncHandler(authController.login));
  router.post('/refresh', asyncHandler(authController.refresh));
  router.post('/logout', asyncHandler(authController.logout));
  router.get('/me', requireSession, asyncHandler(authController.me));
  router.post(
    '/password/forgot',
    rateLimit({ name: 'forgot', limit: 5, windowMs: 60 * 60 * 1000, key: byIp, durable: true }),
    validate(forgotSchema),
    asyncHandler(authController.forgotPassword),
  );
  router.post('/password/reset', validate(resetSchema), asyncHandler(authController.resetPassword));
  router.post('/email/verify', validate(verifyEmailSchema), asyncHandler(authController.verifyEmail));
  router.post('/email/resend', requireSession, asyncHandler(authController.resendVerification));

  return router;
}
