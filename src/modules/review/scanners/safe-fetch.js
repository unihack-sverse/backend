import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { env } from '../../../config/env.js';

const MAX_REDIRECTS = 3;
const HEAD_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024; // large enough to hold the ZIP end-of-central-directory + directory for typical builds
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Stable error codes so scanners can report a precise reason. */
export class FetchError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

function parseIPv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function expandIPv6(address) {
  let value = address.split('%')[0].toLowerCase();
  const tail = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    value = value.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = parseIPv4(address);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const g = expandIPv6(address);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // v4-mapped
    if (g.slice(0, 6).every((x) => x === 0)) return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // v4-compatible
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

/** True when the scan must not touch the network (offline mode, or placeholder `.example.com` hosts under test). */
export function isOfflineTarget(url, mode = env.REVIEW_SCAN_MODE) {
  if (mode === 'offline') return true;
  if (env.NODE_ENV !== 'test') return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'example.com' || host.endsWith('.example.com');
  } catch {
    return false;
  }
}

async function resolveTarget(url, allowPrivate) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('unsupported_protocol', `unsupported protocol ${url.protocol}`);
  if (url.username || url.password) throw new FetchError('credentials_in_url', 'URL must not embed credentials');
  if (url.protocol === 'http:' && !(allowPrivate && LOCAL_HOSTS.has(url.hostname.toLowerCase()))) {
    throw new FetchError('https_required', 'URL must be served over HTTPS');
  }
  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
  else {
    try {
      addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new FetchError('dns_failed', `DNS lookup failed for ${hostname} (${error.code ?? error.message})`);
    }
  }
  if (!addresses.length) throw new FetchError('dns_failed', `no DNS records for ${hostname}`);
  if (!allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new FetchError('ssrf_blocked', `${hostname} resolves to a private or reserved address`);
  }
  return addresses[0];
}

function requestOnce(url, target, { signal, accept }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': 'SverseReviewBot/1.0', accept: accept ?? '*/*', 'accept-encoding': 'identity' },
        // Pin the connection to the address we already validated (defeats DNS rebinding).
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
        signal,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetches a URL with SSRF protection, a hard timeout and a byte cap, hashing the whole stream.
 * Never throws: returns `{ ok: false, error, message }` on transport failure.
 */
export async function safeFetch(rawUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? env.REVIEW_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? env.REVIEW_MAX_BUILD_BYTES;
  const allowPrivate = options.allowPrivate ?? env.REVIEW_ALLOW_PRIVATE_NET;
  const headLimit = options.headBytes ?? HEAD_BYTES;
  const tailLimit = options.tailBytes ?? TAIL_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current;
    try {
      current = new URL(String(rawUrl));
    } catch {
      throw new FetchError('invalid_url', 'not a valid URL');
    }
    for (let hop = 0; ; hop += 1) {
      const target = await resolveTarget(current, allowPrivate);
      const res = await requestOnce(current, target, { signal: controller.signal, accept: options.accept });
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.destroy();
        if (hop >= MAX_REDIRECTS) throw new FetchError('too_many_redirects', `more than ${MAX_REDIRECTS} redirects`);
        try {
          current = new URL(location, current);
        } catch {
          throw new FetchError('invalid_redirect', 'redirect target is not a valid URL');
        }
        continue;
      }
      const base = {
        status,
        contentType: String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
        contentLength: res.headers['content-length'] === undefined ? null : Number(res.headers['content-length']),
        finalUrl: current.toString(),
        redirects: hop,
      };
      if (status < 200 || status >= 300) {
        res.destroy();
        return { ...base, ok: false, error: `http_status_${status}`, message: `HTTP ${status}`, bytesRead: 0, truncated: false, sha256: null, headBuffer: Buffer.alloc(0), tailBuffer: Buffer.alloc(0) };
      }
      return { ...base, ...(await consume(res, { maxBytes, headLimit, tailLimit })), ok: true };
    }
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    const code = aborted ? 'timeout' : error instanceof FetchError ? error.code : 'network_error';
    return {
      ok: false,
      status: 0,
      error: code,
      message: aborted ? `timed out after ${timeoutMs}ms` : error.message,
      finalUrl: String(rawUrl),
      bytesRead: 0,
      truncated: false,
      sha256: null,
      contentType: '',
      contentLength: null,
      headBuffer: Buffer.alloc(0),
      tailBuffer: Buffer.alloc(0),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function consume(res, { maxBytes, headLimit, tailLimit }) {
  const hash = createHash('sha256');
  const headChunks = [];
  let headLength = 0;
  let tail = Buffer.alloc(0);
  let bytesRead = 0;
  let truncated = false;
  for await (const chunk of res) {
    let piece = chunk;
    if (bytesRead + piece.length > maxBytes) {
      piece = piece.subarray(0, maxBytes - bytesRead);
      truncated = true;
    }
    if (piece.length) {
      hash.update(piece);
      bytesRead += piece.length;
      if (headLength < headLimit) {
        const slice = piece.subarray(0, headLimit - headLength);
        headChunks.push(slice);
        headLength += slice.length;
      }
      tail = Buffer.concat([tail, piece]);
      if (tail.length > tailLimit * 2) tail = tail.subarray(tail.length - tailLimit);
    }
    if (truncated) {
      res.destroy();
      break;
    }
  }
  return {
    bytesRead,
    truncated,
    sha256: hash.digest('hex'),
    headBuffer: Buffer.concat(headChunks),
    tailBuffer: tail.length > tailLimit ? Buffer.from(tail.subarray(tail.length - tailLimit)) : tail,
  };
}

/**
 * Fetches the game's build URL once so every scanner shares the same evidence.
 * Returns `{ offline: true }` when scanning must not hit the network.
 */
export async function fetchBuild(game) {
  const url = String(game.buildUrl ?? '');
  if (isOfflineTarget(url)) return { offline: true, url };
  const result = await safeFetch(url, { accept: 'text/html,application/zip,application/octet-stream,*/*' });
  return { offline: false, url, ...result };
}
