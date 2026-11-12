import { keccak256, toUtf8Bytes } from 'ethers';

/** Off-chain public ids → bytes32 on-chain refs (studio/game/definition/mint/epoch). */
export function chainRef(value) {
  return keccak256(toUtf8Bytes(String(value)));
}

export const UNLIMITED_SUPPLY = (1n << 128n) - 1n;
