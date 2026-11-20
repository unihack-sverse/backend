import { EventEmitter } from 'node:events';

import { logger } from './logger.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/**
 * In-process domain events (01 §7). Handlers run after the response path and must never
 * throw into the emitter; durable work is persisted by the handler (webhook deliveries, posts).
 *
 * Note on durability: replacing this fire-and-forget bus with a transactional outbox would
 * require every emitter call site to pass an active Mongo session and alter post-response
 * handler timing/behaviour. Intentionally kept in-process here; full durable outbox is
 * deferred to the roadmap.
 */
export const eventBus = {
  on(event, handler) {
    emitter.on(event, (payload) => {
      Promise.resolve()
        .then(() => handler(payload, event))
        .catch((error) => logger.error({ err: error, event }, 'event_handler_failed'));
    });
  },
  onAny(handler) {
    anyHandlers.push(handler);
  },
  emit(event, payload) {
    emitter.emit(event, payload);
    for (const handler of anyHandlers) {
      Promise.resolve()
        .then(() => handler(payload, event))
        .catch((error) => logger.error({ err: error, event }, 'event_handler_failed'));
    }
  },
  reset() {
    emitter.removeAllListeners();
    anyHandlers.length = 0;
  },
};

const anyHandlers = [];
