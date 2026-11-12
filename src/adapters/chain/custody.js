import { HDNodeWallet, Mnemonic } from 'ethers';

import { env } from '../../config/env.js';

/**
 * Custodial key derivation (concept §4 custody path: email login → embedded account → optional
 * export). Users and studios get BIP-44 accounts from one HD root held by the platform:
 *   users   m/44'/60'/0'/0/{index}
 *   studios m/44'/60'/1'/0/{index}
 * In production the mnemonic belongs in a KMS/HSM; only this module ever touches it.
 */
const ACCOUNT = { user: 0, studio: 1 };
const cache = new Map();
let root;

export function custodyWallet(kind, index) {
  if (!(kind in ACCOUNT)) throw new Error(`Unknown custody kind: ${kind}`);
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid custody index: ${index}`);
  const key = `${kind}:${index}`;
  if (!cache.has(key)) {
    root ??= HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(env.CUSTODY_MNEMONIC), "m/44'/60'");
    cache.set(key, root.derivePath(`${ACCOUNT[kind]}'/0/${index}`));
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

export function custodyAddress(kind, index) {
  return custodyWallet(kind, index).address;
}
