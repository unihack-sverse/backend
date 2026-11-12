import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { env } from './config/env.js';
import { startScheduler } from './jobs/scheduler.js';
import { logger } from './lib/logger.js';

await bootstrap();
const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, chain: env.CHAIN_ADAPTER }, 'sverse_backend_listening');
});
const scheduler = env.RUN_JOBS ? startScheduler() : null;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
