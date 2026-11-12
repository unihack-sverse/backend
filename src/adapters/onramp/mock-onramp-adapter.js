import { hmacHex, safeEqual } from '../../lib/hmac.js';
import { publicId } from '../../lib/ids.js';
import { env } from '../../config/env.js';

/** Stand-in for a licensed fiat on-ramp partner. Sessions complete via a signed webhook. */
export class MockOnrampAdapter {
  constructor() {
    this.sessions = new Map();
  }

  get name() {
    return 'mock';
  }

  async createSession({ userId, usdAmount, srvUnits, returnUrl }) {
    const sessionId = publicId('ons');
    this.sessions.set(sessionId, { userId, usdAmount, srvUnits, status: 'pending' });
    return { sessionId, redirectUrl: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}onramp_session=${sessionId}` };
  }

  signWebhook(rawBody) {
    return hmacHex(env.WEBHOOK_SIGNING_PEPPER, rawBody);
  }

  verifyWebhook({ rawBody, signature }) {
    return safeEqual(signature, this.signWebhook(rawBody));
  }
}

let instance;
export function onrampAdapter() {
  instance ??= new MockOnrampAdapter();
  return instance;
}
