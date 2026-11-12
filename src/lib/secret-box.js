import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';

// AES-256-GCM for secrets the platform must read back (webhook signing secrets, HMAC
// attestation secrets). Plaintext API keys themselves are only ever stored as hashes.
const key = createHash('sha256').update(`sverse.secret-box:${env.WEBHOOK_SIGNING_PEPPER}`).digest();

export function seal(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed) {
  const [version, iv, tag, body] = String(sealed).split('.');
  if (version !== 'v1') throw new Error('Unsupported sealed secret version.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export function hashWithPepper(value) {
  return `sha256:${createHash('sha256').update(`${value}${env.WEBHOOK_SIGNING_PEPPER}`).digest('hex')}`;
}
