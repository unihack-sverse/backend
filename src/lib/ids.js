import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Prefixed, time-sortable public id: `usr_01HQ8Z…` (ULID body). */
export function publicId(prefix) {
  return `${prefix}_${ulid()}`;
}

export const makePid = publicId;

export function parsePublicId(value, prefix) {
  if (typeof value !== 'string') return null;
  const [head, ...rest] = value.split('_');
  if (head !== prefix || rest.length === 0) return null;
  return value;
}

export function ulid(now = Date.now()) {
  let time = '';
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[bytes[i] % 32];
  return time + random;
}

export function toObjectId(value) {
  if (!value || !mongoose.isValidObjectId(value)) return null;
  return new mongoose.Types.ObjectId(String(value));
}
