import { createHmac, randomUUID } from 'node:crypto';

import { canonicalJson } from '../src/lib/canonical-json.js';

/**
 * Plays the role of a shipped game talking to `/sdk/v1`: opens a Proof-of-Play session, sends
 * heartbeats, then attests a deed on a Living Item with the studio's API secret.
 *
 *   SVERSE_API_KEY=sk_live_… node scripts/demo-game-client.js <passportId> <inventoryItemId> [minutes]
 */
const base = process.env.SVERSE_API_BASE ?? 'http://127.0.0.1:4000';
const apiKey = process.env.SVERSE_API_KEY;
const [passportId, inventoryItemId, minutesArg] = process.argv.slice(2);
if (!apiKey || !passportId || !inventoryItemId) {
  console.error('usage: SVERSE_API_KEY=sk_live_… node scripts/demo-game-client.js <passportId> <inventoryItemId> [heartbeats]');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${base}/sdk/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error)}`);
  return json.data;
}

const me = await call('GET', '/me');
console.log(`key ${me.keyId} · studio ${me.studio.handle} · game ${me.game?.slug ?? '(unbound)'}`);

const session = await call('POST', '/sessions', { passportId, clientVersion: 'demo-1.0' });
console.log(`session ${session.id} opened`);
const beats = Number(minutesArg ?? 3);
for (let i = 0; i < beats; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const beat = await call('POST', `/sessions/${session.id}/heartbeat`, {});
  console.log(`heartbeat ${beat.heartbeatCount} · ${beat.minutes} min credited`);
}

const deed = { deedType: 'boss_defeated', detail: { boss: 'Ashmaw', difficulty: 'mythic', partySize: 1 }, nonce: randomUUID() };
const studioSignature = `sha256=${createHmac('sha256', apiKey)
  .update(`${inventoryItemId}.${deed.deedType}.${canonicalJson(deed.detail)}.${deed.nonce}`)
  .digest('hex')}`;
const recorded = await call('POST', `/items/${inventoryItemId}/deeds`, { ...deed, studioSignature });
console.log(`deed ${recorded.id} · traits ${JSON.stringify(recorded.traitsBefore)} → ${JSON.stringify(recorded.traitsAfter)}`);
console.log('verification and on-chain anchoring run in the background (deed-verify job); check the Passport deeds tab.');

await call('POST', `/sessions/${session.id}/close`, {});
console.log('session closed');
