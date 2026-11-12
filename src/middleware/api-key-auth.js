import { Forbidden, Unauthorized } from '../lib/errors.js';
import { hashWithPepper } from '../lib/secret-box.js';
import { ApiKeyModel, StudioModel } from '../modules/studios/models/index.js';
import { GameModel } from '../modules/games/models/index.js';

/** `/sdk/v1` auth: `Authorization: Bearer sk_live_…`. Attaches `req.apiKey`, `req.studio`, `req.game`. */
export async function apiKeyAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!/^sk_(live|test)_[0-9A-Za-z]{32}$/.test(secret)) throw Unauthorized('invalid_api_key');

    const key = await ApiKeyModel.findOne({ keyHash: hashWithPepper(secret), revokedAt: null }).lean();
    if (!key) throw Unauthorized('invalid_api_key');
    const studio = await StudioModel.findById(key.studioId).lean();
    if (!studio || studio.status !== 'active') throw Forbidden('studio_suspended');

    req.apiKey = key;
    req.studio = studio;
    req.game = key.gameId ? await GameModel.findById(key.gameId).lean() : null;
    ApiKeyModel.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() }, $inc: { requestCount: 1 } }).catch(() => {});
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireScope(scope) {
  return (req, _res, next) => {
    if (!req.apiKey?.scopes?.includes(scope)) return next(Forbidden('insufficient_scope'));
    return next();
  };
}
