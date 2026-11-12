import { bootstrap } from './bootstrap.js';
import { startScheduler } from './jobs/scheduler.js';
import { logger } from './lib/logger.js';

// Dedicated job runner for deployments that keep API processes free of background work.
await bootstrap();
const scheduler = startScheduler();
logger.info({ owner: scheduler.owner }, 'sverse_worker_started');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler.stop();
    setTimeout(() => process.exit(0), 500);
  });
}
