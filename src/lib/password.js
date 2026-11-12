import argon2 from 'argon2';
import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password) {
  return argon2.hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(password, passwordHash) {
  if (!passwordHash) return false;
  if (passwordHash.startsWith('$argon2')) {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }
  return verifyLegacyScrypt(password, passwordHash);
}

export function needsRehash(passwordHash) {
  return !passwordHash?.startsWith('$argon2id$');
}

// Accounts created by the pre-v1 demo backend used scrypt; they are rehashed on next login.
async function verifyLegacyScrypt(password, passwordHash) {
  const [scheme, salt, storedHex] = passwordHash.split(':');
  if (scheme !== 'scrypt' || !salt || !storedHex) return false;
  const stored = Buffer.from(storedHex, 'hex');
  const derived = await scryptAsync(password, salt, stored.length);
  return timingSafeEqual(stored, Buffer.from(derived));
}
