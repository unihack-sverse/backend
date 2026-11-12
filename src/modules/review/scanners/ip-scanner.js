import { GameModel } from '../../games/models/index.js';
import { isOfflineTarget, safeFetch } from './safe-fetch.js';

const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COMPARABLE_STATUSES = ['in_review', 'live', 'delisted'];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isExternal = (url) => /^https?:\/\//i.test(String(url ?? ''));

/**
 * IP fingerprint scan: hashes the build stream and cover art, then looks for the same content,
 * cover URL or live title in another studio's games. Persists the fingerprints on the game.
 * `build` is the shared result of `fetchBuild(game)`.
 */
export async function ipFingerprint(game, build = { offline: true }) {
  const name = 'ip_fingerprint';
  const now = new Date();
  const other = { _id: { $ne: game._id }, studioId: { $ne: game.studioId } };
  const checked = [];
  const fingerprints = {};
  const evidence = { checked };

  // Cover art: fetch for real and hash it.
  const coverUrl = game.coverArt?.url;
  if (coverUrl && isExternal(coverUrl) && !isOfflineTarget(coverUrl)) {
    const cover = await safeFetch(coverUrl, { maxBytes: MAX_COVER_BYTES, accept: 'image/*' });
    if (!cover.ok) {
      return { name, status: 'flagged', evidence: { reason: cover.status ? `cover art URL returned HTTP ${cover.status}` : `cover art could not be fetched: ${cover.message}`, coverUrl, httpStatus: cover.status || null } };
    }
    if (!cover.contentType.startsWith('image/')) {
      return { name, status: 'flagged', evidence: { reason: `cover art is not an image (${cover.contentType || 'no content type'})`, coverUrl, httpStatus: cover.status, contentType: cover.contentType } };
    }
    if (cover.truncated) return { name, status: 'flagged', evidence: { reason: 'cover art is too large', coverUrl, sizeBytes: cover.bytesRead } };
    fingerprints.cover = { sha256: cover.sha256, sizeBytes: cover.bytesRead, contentType: cover.contentType, scannedAt: now };
    evidence.cover = { sha256: cover.sha256, sizeBytes: cover.bytesRead, contentType: cover.contentType, httpStatus: cover.status };
    checked.push('cover_hash');
  }

  if (build.ok && build.sha256 && !build.truncated) {
    fingerprints.build = { sha256: build.sha256, sizeBytes: build.bytesRead, contentType: build.contentType, scannedAt: now };
    evidence.build = { sha256: build.sha256, sizeBytes: build.bytesRead, contentType: build.contentType, httpStatus: build.status };
    checked.push('build_hash');
  }

  const set = {};
  if (fingerprints.cover) set['fingerprints.cover'] = fingerprints.cover;
  if (fingerprints.build) set['fingerprints.build'] = fingerprints.build;
  if (Object.keys(set).length) await GameModel.updateOne({ _id: game._id }, { $set: set });

  const flag = (reason, match, code) => ({ name, status: 'flagged', evidence: { ...evidence, reason, code, match: match.pid } });
  const status = { $in: COMPARABLE_STATUSES };

  if (coverUrl) {
    const duplicate = await GameModel.findOne({ ...other, status, 'coverArt.url': coverUrl }).select('pid').lean();
    if (duplicate) return flag('cover art matches another studio', duplicate, 'cover_url_match');
    checked.push('cover_url');
  }
  if (fingerprints.cover) {
    const duplicate = await GameModel.findOne({ ...other, status, 'fingerprints.cover.sha256': fingerprints.cover.sha256 }).select('pid').lean();
    if (duplicate) return flag('cover art image content matches another studio', duplicate, 'cover_hash_match');
  }
  if (fingerprints.build) {
    const duplicate = await GameModel.findOne({ ...other, status, 'fingerprints.build.sha256': fingerprints.build.sha256 }).select('pid').lean();
    if (duplicate) return flag('build content matches another studio', duplicate, 'build_hash_match');
  }
  const titleClash = await GameModel.findOne({ ...other, status: 'live', title: new RegExp(`^${escapeRegExp(game.title)}$`, 'i') }).select('pid').lean();
  if (titleClash) return flag('title matches a live game from another studio', titleClash, 'title_match');
  checked.push('title');

  if (!coverUrl) evidence.note = 'no cover art';
  return { name, status: 'passed', evidence };
}
