# Sverse Platform API

Express 4 + MongoDB 7 (Mongoose 8) implementation of the Sverse web platform described in
[`spec/`](../../spec/README.md), with an Avalanche C-Chain adapter for on-chain settlement anchors.

- **Off-chain, authoritative:** SRV balances (double-entry ledger), orders, catalog, clubs, telemetry, rewards scoring.
- **On-chain (Avalanche), via an outbox:** item ownership (ERC-1155 `SverseItems`), Deed provenance
  (`SverseDeedRegistry`, EIP-712), reward epoch roots (`SverseRewards`), studio payouts (tSRV).
- No module outside `src/adapters/` imports `ethers` or knows whether a hash is real (spec 00 §2.2).

## Quick start (local, mock chain)

```bash
npm install
npm run dev:db                  # terminal 1 — single-node replica set on :27018, data in .data/mongo
cp .env.example .env            # defaults point at the dev DB and the mock chain
npm run seed:reset              # demo data (refuses to reset a non-local DB)
npm run dev                     # API on :4000, background jobs in-process
```

Demo logins (local seed only): `kai@example.com` / `correct-horse-9` (player, creator, moderator);
admin `ops@sverse.local` with `SEED_ADMIN_PASSWORD` (a random one is logged once if unset).

## SDK in 30 seconds

Create a game-scoped key in the studio console (or `POST /api/v1/studios/me/api-keys`), then let a
script play the game's part — Proof-of-Play session, heartbeats and an HMAC-attested deed:

```bash
SVERSE_API_KEY=sk_live_… node scripts/demo-game-client.js <passportId> <livingInventoryItemId>
```

Deed signature: `HMAC-SHA256(apiSecret, "${inventoryItemId}.${deedType}.${canonicalJson(detail)}.${nonce}")`
sent as `studioSignature: "sha256=<hex>"`. Purchases on behalf of a player need the player's
consent grant (`POST /api/v1/passport/me/game-grants`) in `X-Sverse-Passport-Token`.

## Tests

```bash
npm test             # unit + integration + the spec's invariant suite (in-memory replica set)
npm run test:chain   # end-to-end against a real EVM: starts `hardhat node`, deploys the contracts,
                     # drives purchases, deeds, sales, refunds, payouts and epochs through the
                     # Avalanche adapter and asserts on-chain state
```

`tests/invariants/` holds one file per hard invariant (00 §7): ledger balances, no negative
balances under 20 genuinely parallel debits, checkout atomicity with a forced failure at every
step, deeds append-only at model/service/router layers, monotonic tokenization, interop never
exceeding the host envelope, double-claim and oversell.

## Architecture

```text
src/
  app.js, server.js, worker.js, bootstrap.js
  config/        env (Zod, fails at boot), constants
  db/            connection, model registry, seeds (demo data = website/demo prototype)
  lib/           money (BigInt units), ids, errors, hmac, entitlement, epoch, merkle, reputation…
  middleware/    session (JWT cookies), API key, validate, rate limit, idempotency, errors
  adapters/
    chain/       mock + avalanche adapters, HD custody, contract ABIs (exported from ../smartcontract)
    onramp/, mailer/
  modules/<m>/   routes · controllers · services · models   (20 modules, spec 01 §2)
  jobs/          lease-locked scheduler (chain dispatch/reconcile/index, webhooks, review, …)
```

Surfaces: `/api/v1` (session), `/sdk/v1` (API keys `sk_live_…`), `/admin/v1` (staff, 404 to
others), `/hooks` (signed partner webhooks). Full list: [`docs/routes.md`](docs/routes.md).

### Chain outbox (why it is safe to retry)

Business transactions never wait for a receipt. They insert a `chainOps` row in the same Mongo
transaction; the dispatcher then:

1. `prepare` — checks whether the effect already exists on-chain (mint refs, definition refs, deed
   nonces, epoch roots); if not, signs the transaction with an explicit nonce.
2. persists the **signed raw transaction** (`submitted`) *before* broadcasting;
3. broadcasts; the reconciler (and the event indexer) confirm it after `AVALANCHE_CONFIRMATIONS`.

A crash at any point resolves by rebroadcasting the same raw tx (same nonce → executes at most
once); catalog and item ops are additionally idempotent on-chain (`SverseItems.mintWithRef`,
`createItemDefinitionWithRef`). Lifecycle: `created → submitted → chain_confirmed → completed`,
or `failed` after 8 attempts, which runs the owner's compensation (e.g. a failed payout reverses
the ledger posting). Failed ops are visible and retryable in the admin console.

### Custody

Passports and studios get BIP-44 custodial addresses from one HD root (`CUSTODY_MNEMONIC`):
users `m/44'/60'/0'/0/i`, studios `m/44'/60'/1'/0/i`. Studios' keys sign deed attestations
(EIP-712) after the game's HMAC is verified; the relayer co-signs as Sverse witness only when the
deed passed telemetry verification. Custodial wallets that must send (item transfers, burns) are
topped up with gas by the relayer. Production must keep the mnemonic and relayer key in a
secret manager/HSM.

### Tokenization ladder → chain

| Level | On-chain effect |
|---|---|
| L0–L1 | none (off-chain entitlement + signed receipt token) |
| L2 | ERC-1155 mint to the buyer's custodial address |
| L3+ | Living Items: unique token per mint + Deed anchoring |

## Switching to Avalanche

### Local EVM (Hardhat)

```bash
cd ../smartcontract && npm run node                                   # terminal A
RELAYER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 npm run deploy:local   # terminal B
```

Then in `.env`: `CHAIN_ADAPTER=avalanche`, `AVALANCHE_RPC_URL=http://127.0.0.1:8545`,
`AVALANCHE_CHAIN_ID=31337`, `AVALANCHE_DEPLOYMENT_FILE=../smartcontract/deployments/localhost.json`,
`RELAYER_PRIVATE_KEY=<hardhat account #1 key>`, and restart.

### Fuji testnet

1. Create two dedicated Fuji keys (never reuse a personal key, and **never** reuse the `ADMIN_ADDRESS`/`DEPLOYER_PRIVATE_KEY` wallet for `RELAYER_PRIVATE_KEY`): a **deployer/admin** and a
   **relayer**. Fund both with test AVAX from the Avalanche faucet.
2. `cd ../smartcontract && npm run export:abi` (keeps `src/adapters/chain/abi` in sync).
3. Deploy: `ADMIN_ADDRESS=<multisig or admin> TREASURY_ADDRESS=<treasury> npm run deploy:fuji`,
   then grant minimal operational roles to the separate relayer wallet:
   `RELAYER_ADDRESS=<relayer> npm run grant:relayer:fuji`
   (grants `SverseItems.{MINTER_ROLE,PLATFORM_ROLE}`, `SverseDeedRegistry.WITNESS_ROLE`, `SverseRewards.PUBLISHER_ROLE`, and `MockSRV.MINTER_ROLE` for Fuji `mint` settlement mode; pass `SKIP_MOCKSRV_MINTER=true` when using `transfer` mode),
   and `npm run verify:fuji`. The manifest `deployments/fuji.json` records addresses and the
   start block for the indexer.
4. Backend env: `CHAIN_ADAPTER=avalanche`, `AVALANCHE_CHAIN_ID=43113`,
   `AVALANCHE_RPC_URL=<dedicated RPC recommended>`, `AVALANCHE_DEPLOYMENT_FILE=…/fuji.json` (or the
   explicit `*_ADDRESS` vars), `RELAYER_PRIVATE_KEY` (must belong to `<relayer>`, separate from `ADMIN_ADDRESS`/`DEPLOYER_PRIVATE_KEY`), `CUSTODY_MNEMONIC`, `SRV_SETTLEMENT_MODE=mint`.
5. Check `GET /admin/v1/chain/health`: every role must be `true` and the relayer must hold AVAX.
6. Run exactly one worker (`npm run worker`, or the `worker` service in `docker-compose.yml`) and
   set `RUN_JOBS=false` on API replicas.

Mainnet: `SRV_SETTLEMENT_MODE=transfer`, the audited settlement asset instead of `MockSRV`,
multisig admin roles, and the contract README's mainnet checklist.

## Upgrading a database written by the pre-v1 demo backend

The earlier demo API stored balances as strings on users and had no ledger. Back up the database,
then:

```bash
node scripts/migrate-legacy.js            # dry run: lists users kept, demo users removed, collections dropped
node scripts/migrate-legacy.js --apply    # migrate real sign-ups (login + balance kept via the ledger), reseed demo data
```

Real users keep their password (legacy scrypt hashes verify and are upgraded to argon2id on next
login); their old balance is posted as a balanced ledger credit. Studios/games from the old demo
are replaced by the current seed.

## Operations runbook

### Health & readiness

- `GET /health` — liveness probe; returns `200 { ok: true, service: 'sverse-backend' }` whenever the Express process is up (does not check MongoDB).
- `GET /ready` — readiness probe; checks `databaseStatus()` and returns `200` when MongoDB is ready (`503` otherwise) with `{ ok, db, adapters: { chain, chainId } }`.

| Signal | Where | Action |
|---|---|---|
| `balanced: false` | `GET /admin/v1/ledger/trial-balance` (poll every 5 min) | Page on-call. Freeze withdrawals (pause payouts by stopping the worker), find `driftAccounts`, reconcile from `ledgerEntries` — never edit entries, post reversals. |
| Stuck/failed chain ops | `GET /admin/v1/chain/reconciliation` | Check relayer AVAX/role health, RPC status. `POST /admin/v1/chain/ops/:id/retry` after the cause is fixed. Ops are idempotent; retrying cannot double-mint. |
| Relayer key compromise | — | Revoke relayer roles from the admin multisig on every contract, rotate `RELAYER_PRIVATE_KEY`, re-grant roles to the new address, restart the worker. Outbox ops resume with the new key. |
| Emergency stop | contracts | `pause()` on SverseItems / SverseDeedRegistry / SverseRewards (PAUSER_ROLE). Ops fail and retry with backoff until unpaused. |
| Webhook endpoint failing | studio console / `webhookDeliveries` | Deliveries retry 5× (1→16 min) then dead-letter; 20 consecutive failures disable the endpoint. Studios replay from the console. |
| Job not running | `GET /admin/v1/jobs` | `lastRunAt` / `lastError` per job; leases expire automatically if a worker dies. |

Data policy: seeded studios, games, users and catalog are demo data. Games and passports seeded
with demo numbers carry `statsSource: 'seed'` / `reputationSource: 'seed'` until real telemetry
arrives, and the UI labels them — they are never traction.
