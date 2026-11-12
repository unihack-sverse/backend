import { logger } from '../../lib/logger.js';

const outbox = [];

/** Development mailer. Messages are logged (without secrets) and kept for tests. */
export const mailer = {
  async send({ to, template, vars = {} }) {
    outbox.push({ to, template, vars, sentAt: new Date() });
    if (outbox.length > 200) outbox.shift();
    logger.info({ template, toDomain: String(to).split('@')[1] }, 'mail_sent');
  },
  outbox,
};
