/**
 * Creates a throwaway API key for the seeded `kai.solo` studio without touching the console.
 *
 * The console is the supported path for creators (`/studio/settings?tab=keys`); this helper exists
 * only so the smoke test and the negative checks can be run unattended. It is not shipped in dist.
 *
 * Usage: node scripts/mint-key.mjs <scope> [gamePid]
 *   scope    publish | game | read, comma-separated
 *   gamePid  optional game binding, e.g. gam_voidrunner
 * Prints the plaintext secret on stdout. It is recoverable only because this script creates it.
 */
import '../src/db/register-models.js';
import { randomBytes } from 'node:crypto';

import { hashWithPepper, seal } from '../src/lib/secret-box.js';
import { publicId } from '../src/lib/ids.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { ApiKeyModel, StudioModel } from '../src/modules/studios/models/index.js';
import { GameModel } from '../src/modules/games/models/index.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length) {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (const byte of bytes) {
    if (out.length >= length) break;
    // Rejection sampling keeps the distribution uniform without pulling in a dependency.
    if (byte >= 248) continue;
    out += ALPHABET[byte % 62];
  }
  return out;
}

async function main() {
  const scopes = (process.argv[2] ?? 'publish').split(',').filter(Boolean);
  const gamePid = process.argv[3];
  await connectDatabase();
  const studio = await StudioModel.findOne({ handle: 'kai.solo' }).lean();
  if (!studio) throw new Error('Seed the database first: cd backend-v2 && npm run seed:reset');
  const game = gamePid ? await GameModel.findOne({ pid: gamePid, studioId: studio._id }).lean() : null;
  if (gamePid && !game) throw new Error(`No game ${gamePid} for studio kai.solo`);

  const secret = `sk_live_${randomBase62(32)}`;
  const key = await ApiKeyModel.create({
    pid: publicId('key'),
    studioId: studio._id,
    gameId: game?._id ?? null,
    label: `mcp smoke ${scopes.join('+')}`,
    prefix: secret.slice(0, 12),
    keyHash: hashWithPepper(secret),
    attestationSecretEnc: seal(secret),
    scopes,
  });
  process.stdout.write(`${secret}\n`);
  process.stderr.write(`minted ${key.pid} scopes=${scopes.join(',')} game=${game?.pid ?? 'none'}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
