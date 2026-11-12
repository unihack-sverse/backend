import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';

import './db/register-models.js';
import { isCorsOriginAllowed } from './config/env.js';
import { databaseStatus } from './db/connection.js';
import { chainAdapter } from './adapters/chain/index.js';
import { ulid } from './lib/ids.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { originCheck } from './middleware/origin-check.js';
import { byIp, byUser, rateLimit } from './middleware/rate-limit.js';
import { attachSession, requireCreator } from './middleware/session-auth.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { chainRoutes } from './modules/chain/routes.js';
import { checkoutRoutes } from './modules/checkout/routes.js';
import { clubRoutes } from './modules/clubs/routes.js';
import { gameRoutes } from './modules/games/routes.js';
import { marketRoutes } from './modules/market/routes.js';
import { passportRoutes } from './modules/passport/routes.js';
import { publishRoutes } from './modules/publish/routes.js';
import { rewardsRoutes } from './modules/rewards/routes.js';
import { sdkRoutes } from './modules/sdk/routes.js';
import { studioRoutes } from './modules/studios/routes.js';
import { hookRoutes } from './modules/webhooks/routes.js';
import './modules/webhooks/services/webhooks.service.js';
import './modules/clubs/services/clubs.service.js';

export function createApp() {
  const app = express();
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{6,80}$/.test(incoming) ? incoming : `req_${ulid()}`;
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], imgSrc: ["'self'", 'data:'] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      frameguard: { action: 'deny' },
    }),
  );
  app.use(cors({ origin: (origin, callback) => callback(null, isCorsOriginAllowed(origin)), credentials: true, exposedHeaders: ['X-Request-Id', 'Retry-After'] }));
  app.use('/hooks', hookRoutes());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/assets', express.static(publicDir, { maxAge: '1d' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Sverse-Api-Version', 'v1');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'sverse-backend' }));
  app.get('/ready', async (_req, res) => {
    const db = databaseStatus();
    res.status(db.ready ? 200 : 503).json({ ok: db.ready, db, adapters: { chain: chainAdapter().name, chainId: chainAdapter().chainId } });
  });

  const api = express.Router();
  api.use(originCheck);
  api.use(attachSession);
  api.use(rateLimit({ name: 'global', limit: 600, windowMs: 60_000, key: (req) => byUser(req) ?? null }));
  api.use(rateLimit({ name: 'global-anon', limit: 120, windowMs: 60_000, key: (req) => (req.user ? null : byIp(req)) }));
  api.use('/auth', authRoutes());
  api.use(gameRoutes());
  api.use(passportRoutes());
  api.use(checkoutRoutes());
  api.use(marketRoutes());
  api.use(clubRoutes());
  api.use(studioRoutes());
  api.use(rewardsRoutes());
  api.use(chainRoutes());
  api.use(
    requireCreatorFor('/publish'),
    publishRoutes({ actorOf: (req) => ({ studio: req.user.studio, user: req.user }), humanOnly: (req) => Boolean(req.user) }),
  );
  app.use('/api/v1', api);
  app.use('/sdk/v1', sdkRoutes());

  const admin = express.Router();
  admin.use(originCheck);
  admin.use(attachSession);
  admin.use(adminRoutes());
  app.use('/admin/v1', admin);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function requireCreatorFor(prefix) {
  return (req, res, next) => (req.path.startsWith(prefix) ? requireCreator(req, res, next) : next());
}
