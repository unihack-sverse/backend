import { BadRequest } from './errors.js';

export function parseLimit(limit, { fallback = 24, max = 100 } = {}) {
  const value = Number(limit ?? fallback);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') throw new Error('bad cursor');
    return decoded;
  } catch {
    throw BadRequest('invalid_cursor');
  }
}

/** Fetches limit+1 to know whether another page exists. */
export function pageMeta(rows, limit, cursorOf) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    page,
    meta: {
      nextCursor: hasMore ? encodeCursor(cursorOf(page[page.length - 1])) : null,
      hasMore,
      count: page.length,
    },
  };
}
