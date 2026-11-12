export const SRV_DECIMALS = 6;

export const TOKENIZATION_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
export const INTEROP_TIERS = ['T0', 'T1', 'T2', 'T3'];
export const GENRES = ['action_rpg', 'puzzle', 'strategy', 'cozy', 'arcade', 'platformer'];
export const ITEM_KINDS = ['cosmetic', 'bundle', 'pass', 'consumable', 'unlock', 'content', 'living'];
export const STACKABLE_KINDS = ['consumable', 'bundle'];
export const ROLES = ['player', 'creator', 'curator', 'moderator', 'admin'];
export const API_KEY_SCOPES = ['game', 'publish', 'read'];

// Shares of the protocol fee, in basis points of the fee (07 §12.2). Treasury absorbs remainder.
export const FEE_SPLIT_BPS = {
  burn: 2500,
  creator_rewards: 2500,
  player_rewards: 2000,
  treasury: 2000,
  curator: 1000,
};

export const SYSTEM_ACCOUNT_PURPOSES = [
  'treasury',
  'burn',
  'creator_rewards',
  'player_rewards',
  'curator',
  'payable',
  'onramp',
];

export const REWARD_CHANNEL_SPLIT = {
  ladders: 35,
  tournaments: 25,
  achievement: 20,
  curation: 15,
  referral: 5,
};

export const PUBLISH_STEPS = [
  'scan_project',
  'propose_items',
  'map_to_schema',
  'create_item_pack',
  'install_sdk',
  'test_purchase',
  'publish',
];

/**
 * Manual mode skips the agent-driven steps but keeps `map_to_schema`: without it every hand-written
 * item would stay T0 and never interop, which is the one property the pipeline promises to make free.
 */
export const MANUAL_PUBLISH_STEPS = ['map_to_schema', 'create_item_pack', 'publish'];

export const WEBHOOK_EVENTS = [
  'purchase.completed',
  'purchase.refunded',
  'item.minted',
  'item.evolved',
  'item.imported',
  'item.listed',
  'item.sold',
  'game.submitted',
  'game.published',
  'game.rejected',
  'reward.distributed',
  'payout.settled',
  'studio.bond_slashed',
  'chain.confirmed',
];

export function levelIndex(level) {
  return TOKENIZATION_LEVELS.indexOf(level);
}

export function tierIndex(tier) {
  return INTEROP_TIERS.indexOf(tier);
}
