import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomBase62(length) {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Rejection sampling keeps the alphabet uniform.
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/** Webhook signature header: `t=<unix>,v1=<hex>` over "<t>.<rawBody>". */
export function signWebhook(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

export function verifyWebhookSignature(secret, rawBody, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((part) => part.split('=').map((s) => s.trim())),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  return safeEqual(parts.v1, hmacHex(secret, `${timestamp}.${rawBody}`));
}
