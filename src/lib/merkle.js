import { AbiCoder, concat, keccak256 } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

/** Leaf matching SverseRewards: keccak256(bytes.concat(keccak256(abi.encode(epoch, index, account, amount)))). */
export function rewardLeaf({ epochNumber, index, account, amountUnits }) {
  const inner = keccak256(
    coder.encode(['uint256', 'uint256', 'address', 'uint128'], [epochNumber, index, account, BigInt(amountUnits)]),
  );
  return keccak256(concat([inner]));
}

/** OpenZeppelin-compatible tree (sorted-pair hashing). Returns the root and a proof per leaf. */
export function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: null, proofs: [] };
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const level = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    layers.push(next);
  }

  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof = [];
    let index = leafIndex;
    for (let depth = 0; depth < layers.length - 1; depth += 1) {
      const level = layers[depth];
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < level.length) proof.push(level[sibling]);
      index = Math.floor(index / 2);
    }
    return proof;
  });

  return { root: layers[layers.length - 1][0], proofs };
}

export function verifyMerkleProof(leaf, proof, root) {
  return proof.reduce((hash, sibling) => hashPair(hash, sibling), leaf) === root;
}

function hashPair(a, b) {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}
