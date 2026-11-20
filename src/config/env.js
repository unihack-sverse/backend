import { z } from 'zod';
import 'dotenv/config';

const booleanFlag = z
  .union([z.boolean(), z.string()])
  .transform((value) => value === true || value === 'true' || value === '1');

const secret = (name) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .default(`dev-${name.toLowerCase()}-change-me-dev-${name.toLowerCase()}`);

const optionalAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .optional()
  .or(z.literal('').transform(() => undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/sverse'),
  PUBLIC_ASSET_BASE: z.string().default(''),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  STUDIO_BASE_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:3000,http://localhost:5173,http://localhost:5174,http://127.0.0.1:3000,http://127.0.0.1:5173,http://127.0.0.1:5174',
    ),
  COOKIE_DOMAIN: z.string().optional().transform((value) => value || undefined),
  COOKIE_SECURE: booleanFlag.optional(),
  // 'none' is needed only when the web app and API live on different sites (e.g. *.pages.dev).
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  ENTITLEMENT_SECRET: secret('ENTITLEMENT_SECRET'),
  WEBHOOK_SIGNING_PEPPER: secret('WEBHOOK_SIGNING_PEPPER'),
  ONRAMP_ADAPTER: z.enum(['mock']).default('mock'),
  MAILER_ADAPTER: z.enum(['console']).default('console'),
  SRV_USD_RATE: z.coerce.number().positive().default(0.042),
  MIN_LISTING_BOND_UNITS: z.coerce.bigint().default(250000000n),
  KYC_THRESHOLD_UNITS: z.coerce.bigint().default(50000000000n),
  DISPUTE_WINDOW_DAYS: z.coerce.number().int().min(0).default(30),
  PROTOCOL_FEE_BPS_STANDARD: z.coerce.number().int().min(0).max(10000).default(1000),
  PROTOCOL_FEE_BPS_STAKED: z.coerce.number().int().min(0).max(10000).default(700),
  PROTOCOL_FEE_BPS_PREMIUM: z.coerce.number().int().min(0).max(10000).default(500),
  MARKET_PROTOCOL_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(250),
  BOOTSTRAP_EMISSION_UNITS: z.coerce.bigint().default(0n),
  REWARDS_GENESIS_DATE: z.string().default('2026-01-05T00:00:00.000Z'),
  FAUCET_ENABLED: booleanFlag.default(true),
  FAUCET_AMOUNT_UNITS: z.coerce.bigint().default(1000000000n),
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  RUN_JOBS: booleanFlag.default(true),
  SEED_ON_BOOT: booleanFlag.default(false),
  GEMINI_API_KEY: z.string().optional(),
  // UC-20 build/cover URL fetch & scan. 'offline' skips all network fetches (legacy static URL checks only).
  REVIEW_SCAN_MODE: z.enum(['live', 'offline']).default('live'),
  REVIEW_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  REVIEW_MAX_BUILD_BYTES: z.coerce.number().int().positive().default(52_428_800),
  // Defaults to false in production and true elsewhere (so local servers can be scanned in dev).
  REVIEW_ALLOW_PRIVATE_NET: booleanFlag.optional(),
  // Block private/loopback/link-local/metadata webhook targets by default even outside production.
  WEBHOOK_ALLOW_PRIVATE_NET: booleanFlag.default(false),
  VIRUSTOTAL_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  SEED_ADMIN_EMAIL: z.string().email().default('ops@sverse.local'),
  SEED_ADMIN_PASSWORD: z.string().optional().transform((value) => value || undefined),
  SEED_ALLOW_RESET: booleanFlag.default(false),
  SEED_IMAGE_MODEL: z.string().default('gemini-2.5-flash-image'),

  // Chain
  CHAIN_ADAPTER: z.enum(['mock', 'avalanche']).default('mock'),
  MOCK_CHAIN_LATENCY_MS: z.coerce.number().int().min(0).default(40),
  CUSTODY_MNEMONIC: z.string().optional().transform((value) => value?.trim() || undefined),
  AVALANCHE_RPC_URL: z.string().default('https://api.avax-test.network/ext/bc/C/rpc'),
  AVALANCHE_CHAIN_ID: z.coerce.number().int().positive().default(43113),
  AVALANCHE_EXPLORER_URL: z.string().default('https://subnets-test.avax.network/c-chain'),
  AVALANCHE_DEPLOYMENT_FILE: z.string().optional().transform((value) => value || undefined),
  AVALANCHE_CONFIRMATIONS: z.coerce.number().int().min(0).default(1),
  AVALANCHE_START_BLOCK: z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(0).optional()),
  AVALANCHE_LOG_CHUNK: z.coerce.number().int().positive().default(2000),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  SRV_TOKEN_ADDRESS: optionalAddress,
  SVERSE_ITEMS_ADDRESS: optionalAddress,
  SVERSE_DEED_REGISTRY_ADDRESS: optionalAddress,
  SVERSE_STORE_ADDRESS: optionalAddress,
  SVERSE_MARKETPLACE_ADDRESS: optionalAddress,
  SVERSE_REWARDS_ADDRESS: optionalAddress,
  SRV_SETTLEMENT_MODE: z.enum(['mint', 'transfer']).default('mint'),
  CUSTODIAL_GAS_TOPUP_WEI: z.coerce.bigint().default(20000000000000000n),
  CUSTODIAL_GAS_MIN_WEI: z.coerce.bigint().default(5000000000000000n),
  REWARD_CLAIM_WINDOW_DAYS: z.coerce.number().int().positive().default(90),
  // How long a submitted tx may be absent from node and mempool before it is rebroadcast.
  CHAIN_DROPPED_GRACE_MS: z.coerce.number().int().min(0).default(90_000),
});

// BIP-39 test vector, deliberately different from Hardhat's default accounts so a dev custodial
// address can never coincide with a funded relayer or deployer key.
const DEV_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

export const env = loadEnv();
export const corsOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export function isCorsOriginAllowed(origin) {
  if (!origin) return true;
  return corsOrigins.some((pattern) => originMatchesPattern(origin, pattern));
}

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    // Boot must fail loudly on bad configuration rather than at request time.
    throw new Error(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
  }

  const value = parsed.data;
  if (value.NODE_ENV === 'production') {
    const defaults = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENTITLEMENT_SECRET', 'WEBHOOK_SIGNING_PEPPER'].filter(
      (key) => value[key].startsWith('dev-'),
    );
    if (defaults.length) throw new Error(`Production requires explicit secrets: ${defaults.join(', ')}`);
    if (!value.CUSTODY_MNEMONIC) throw new Error('Production requires CUSTODY_MNEMONIC.');
    if (corsOrigins_(value).includes('*')) throw new Error('Wildcard CORS is not allowed with credentials.');
  }
  if (value.CHAIN_ADAPTER === 'avalanche') {
    if (!value.RELAYER_PRIVATE_KEY) throw new Error('CHAIN_ADAPTER=avalanche requires RELAYER_PRIVATE_KEY.');
    if (!value.CUSTODY_MNEMONIC && value.NODE_ENV !== 'test' && value.AVALANCHE_CHAIN_ID !== 31337) {
      throw new Error('CHAIN_ADAPTER=avalanche requires CUSTODY_MNEMONIC outside local chains.');
    }
  }

  return {
    ...value,
    CUSTODY_MNEMONIC: value.CUSTODY_MNEMONIC ?? DEV_MNEMONIC,
    REVIEW_ALLOW_PRIVATE_NET: value.REVIEW_ALLOW_PRIVATE_NET ?? value.NODE_ENV !== 'production',
    COOKIE_SECURE: value.COOKIE_SAMESITE === 'none' ? true : value.COOKIE_SECURE ?? value.NODE_ENV === 'production',
  };
}

function corsOrigins_(value) {
  return value.CORS_ORIGINS.split(',').map((origin) => origin.trim());
}

function originMatchesPattern(origin, pattern) {
  if (pattern === '*') return true;
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]+');
  return new RegExp(`^${expression}$`, 'i').test(origin);
}
