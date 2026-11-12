import { AbiCoder, Contract, JsonRpcProvider, Wallet, keccak256 } from 'ethers';

import { env } from '../../config/env.js';
import { CONTRACT_NAMES, loadAbi, resolveDeployment } from './contracts.js';
import { custodyAddress, custodyWallet } from './custody.js';
import { UNLIMITED_SUPPLY, chainRef } from './refs.js';

const coder = AbiCoder.defaultAbiCoder();

const DEED_TYPES = {
  Deed: [
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'deedType', type: 'bytes32' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'uriHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/**
 * Avalanche C-Chain adapter (Fuji 43113 / mainnet 43114 / local Hardhat 31337).
 *
 * Every op is split into prepare (sign, return raw tx) and broadcast so the dispatcher can
 * persist the signed transaction before it reaches the network. A crash at any point therefore
 * resolves by rebroadcasting the same raw transaction — same nonce, so it can execute at most
 * once. Ops that touch catalog or items are additionally idempotent on-chain through refs
 * (`definitionRefs`, `mintRefs`, deed nonces, epoch numbers).
 */
export class AvalancheChainAdapter {
  constructor({
    rpcUrl = env.AVALANCHE_RPC_URL,
    chainId = env.AVALANCHE_CHAIN_ID,
    relayerKey = env.RELAYER_PRIVATE_KEY,
    deployment = resolveDeployment(),
    confirmations = env.AVALANCHE_CONFIRMATIONS,
    settlementMode = env.SRV_SETTLEMENT_MODE,
    nonceFloor = async () => 0,
  } = {}) {
    this.chainIdValue = Number(chainId);
    this.provider = new JsonRpcProvider(rpcUrl, this.chainIdValue, { staticNetwork: true, batchMaxCount: 20 });
    // Local chains mine instantly; public RPCs get a gentler polling cadence.
    this.provider.pollingInterval = this.chainIdValue === 31337 ? 200 : 1000;
    this.relayer = new Wallet(relayerKey, this.provider);
    this.deployment = deployment;
    this.confirmations = Math.max(1, confirmations);
    this.settlementMode = settlementMode;
    this.nonceFloor = nonceFloor;
    this.localNonces = new Map();
    this.contracts = Object.fromEntries(
      CONTRACT_NAMES.filter((name) => deployment.contracts[name]).map((name) => [
        name,
        new Contract(deployment.contracts[name], loadAbi(name), this.relayer),
      ]),
    );
  }

  get name() {
    return 'avalanche';
  }

  get chainId() {
    return this.chainIdValue;
  }

  get relayerAddress() {
    return this.relayer.address;
  }

  explorerTxUrl(txHash) {
    if (!txHash || this.chainIdValue === 31337) return null;
    return `${env.AVALANCHE_EXPLORER_URL.replace(/\/$/, '')}/tx/${txHash}`;
  }

  async createAccount({ kind, index }) {
    return { address: custodyAddress(kind, index) };
  }

  /** Returns `{ alreadyDone, result }` when the effect exists on-chain, else a signed tx. */
  async prepare(op) {
    switch (op.kind) {
      case 'mint_item':
        return this.#prepareMint(op);
      case 'record_deed':
        return this.#prepareDeed(op);
      case 'transfer_item':
        return this.#prepareItemTransfer(op);
      case 'burn_item':
        return this.#prepareBurn(op);
      case 'publish_epoch':
        return this.#preparePublishEpoch(op);
      case 'payout':
        return this.#preparePayout(op);
      default:
        throw new Error(`Unsupported chain op kind: ${op.kind}`);
    }
  }

  async broadcast(rawTx) {
    try {
      const response = await this.provider.broadcastTransaction(rawTx);
      return { txHash: response.hash };
    } catch (error) {
      // A rebroadcast of an already-known or already-mined transaction is not a failure.
      const message = String(error?.message ?? '').toLowerCase();
      if (message.includes('already known')) return { txHash: keccak256(rawTx), duplicate: true };
      if (message.includes('nonce too low') || error?.code === 'NONCE_EXPIRED') {
        this.localNonces.clear();
        return { txHash: keccak256(rawTx), duplicate: true, nonceConsumed: true };
      }
      throw error;
    }
  }

  async checkReceipt(op) {
    const receipt = await this.provider.getTransactionReceipt(op.txHash);
    if (!receipt) {
      const pending = await this.provider.getTransaction(op.txHash);
      if (pending) return { state: 'pending' };
      const existing = await this.lookupExisting(op);
      if (existing) return { state: 'confirmed', result: existing, blockNumber: null };
      return { state: 'dropped' };
    }

    const latest = await this.provider.getBlockNumber();
    if (latest - receipt.blockNumber + 1 < this.confirmations) return { state: 'pending', blockNumber: receipt.blockNumber };

    if (receipt.status === 1) {
      return { state: 'confirmed', blockNumber: receipt.blockNumber, result: this.#resultFromReceipt(op, receipt) };
    }
    const existing = await this.lookupExisting(op);
    if (existing) return { state: 'confirmed', blockNumber: receipt.blockNumber, result: existing };
    return { state: 'reverted', blockNumber: receipt.blockNumber };
  }

  /** The op's effect if it already exists on-chain (e.g. a replaced tx that still landed). */
  async lookupExisting(op) {
    const { SverseItems: items, SverseDeedRegistry: deeds, SverseRewards: rewards } = this.contracts;
    switch (op.kind) {
      case 'mint_item': {
        const tokenId = await items.mintRefs(chainRef(op.ref));
        if (tokenId === 0n) return null;
        const definitionId = await items.definitionRefs(chainRef(op.payload.definition.ref));
        return { tokenId: tokenId.toString(), chainDefinitionId: definitionId.toString() };
      }
      case 'record_deed': {
        const tokenId = BigInt(op.payload.tokenId);
        const nonce = deedNonce(op.ref);
        const used = await deeds.usedNonces(await items.getAddress(), tokenId, nonce);
        return used ? { chainDeedId: await this.#deedId(tokenId, nonce) } : null;
      }
      case 'publish_epoch': {
        const epoch = await rewards.epochs(op.payload.epochNumber);
        return epoch.merkleRoot === op.payload.root ? {} : null;
      }
      default:
        return null;
    }
  }

  async health() {
    const { SverseItems: items, SverseDeedRegistry: deeds, SverseRewards: rewards, MockSRV: token } = this.contracts;
    const [blockNumber, avax, srv, minter, platform, witness, publisher] = await Promise.all([
      this.provider.getBlockNumber(),
      this.provider.getBalance(this.relayer.address),
      token.balanceOf(this.relayer.address),
      items.hasRole(await items.MINTER_ROLE(), this.relayer.address),
      items.hasRole(await items.PLATFORM_ROLE(), this.relayer.address),
      deeds.hasRole(await deeds.WITNESS_ROLE(), this.relayer.address),
      rewards.hasRole(await rewards.PUBLISHER_ROLE(), this.relayer.address),
    ]);
    const roles = { minter, platform, witness, publisher };
    return {
      ok: Object.values(roles).every(Boolean),
      adapter: 'avalanche',
      chainId: this.chainIdValue,
      blockNumber,
      relayer: this.relayer.address,
      relayerAvaxWei: avax.toString(),
      relayerSrvUnits: srv.toString(),
      roles,
      contracts: this.deployment.contracts,
    };
  }

  async latestSafeBlock() {
    const latest = await this.provider.getBlockNumber();
    return Math.max(0, latest - (this.confirmations - 1));
  }

  /** Parsed logs of every Sverse contract in [fromBlock, toBlock]. */
  async fetchLogs(fromBlock, toBlock) {
    const byAddress = new Map(
      Object.entries(this.contracts).map(([name, contract]) => [String(contract.target).toLowerCase(), { name, contract }]),
    );
    const logs = await this.provider.getLogs({ address: [...byAddress.keys()], fromBlock, toBlock });
    const events = [];
    for (const log of logs) {
      const entry = byAddress.get(log.address.toLowerCase());
      const parsed = entry?.contract.interface.parseLog(log);
      if (!parsed) continue;
      events.push({
        contract: entry.name,
        address: log.address,
        event: parsed.name,
        args: Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name, serialize(parsed.args[i])])),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.index,
      });
    }
    return events;
  }

  // ---------------------------------------------------------------- op builders

  async #prepareMint(op) {
    const existing = await this.lookupExisting(op);
    if (existing) return { alreadyDone: true, result: existing };

    const { SverseItems: items } = this.contracts;
    const definitionId = await this.#ensureDefinition(op.payload.definition);
    const tx = await items.mintWithRef.populateTransaction(
      op.payload.to,
      definitionId,
      BigInt(op.payload.amount ?? 1),
      chainRef(op.ref),
    );
    return { ...(await this.#sign(this.relayer, tx)), partial: { chainDefinitionId: definitionId.toString() } };
  }

  async #prepareDeed(op) {
    const existing = await this.lookupExisting(op);
    if (existing) return { alreadyDone: true, result: existing };

    const { SverseItems: items, SverseDeedRegistry: deeds } = this.contracts;
    const collection = await items.getAddress();
    const tokenId = BigInt(op.payload.tokenId);
    const nonce = deedNonce(op.ref);
    const deedType = chainRef(op.payload.deedType);
    const payloadHash = `0x${op.payload.payloadHash.replace(/^sha256:/, '')}`;
    const uriHash = keccak256(Buffer.from(op.payload.payloadUri, 'utf8'));
    const message = { collection, tokenId, deedType, payloadHash, uriHash, nonce, deadline: 0n };
    const domain = {
      name: 'SverseDeedRegistry',
      version: '1',
      chainId: this.chainIdValue,
      verifyingContract: await deeds.getAddress(),
    };

    const studioSigner = custodyWallet('studio', op.payload.studioCustodyIndex);
    const studioSignature = await studioSigner.signTypedData(domain, DEED_TYPES, message);
    // The Sverse witness co-signs only deeds that passed telemetry verification.
    const witnessSignature = op.payload.witness ? await this.relayer.signTypedData(domain, DEED_TYPES, message) : '0x';

    const tx = await deeds.recordDeed.populateTransaction(
      collection,
      tokenId,
      deedType,
      payloadHash,
      op.payload.payloadUri,
      nonce,
      0n,
      studioSignature,
      witnessSignature,
    );
    return this.#sign(this.relayer, tx);
  }

  async #prepareItemTransfer(op) {
    const { SverseItems: items } = this.contracts;
    const owner = custodyWallet(op.payload.fromKind ?? 'user', op.payload.fromCustodyIndex).connect(this.provider);
    await this.#ensureGas(owner.address);
    const tx = await items
      .connect(owner)
      .safeTransferFrom.populateTransaction(owner.address, op.payload.to, BigInt(op.payload.tokenId), BigInt(op.payload.amount ?? 1), '0x');
    return this.#sign(owner, tx);
  }

  async #prepareBurn(op) {
    const { SverseItems: items } = this.contracts;
    const owner = custodyWallet(op.payload.ownerKind ?? 'user', op.payload.ownerCustodyIndex).connect(this.provider);
    const balance = await items.balanceOf(owner.address, BigInt(op.payload.tokenId));
    if (balance < BigInt(op.payload.amount ?? 1)) return { alreadyDone: true, result: { note: 'nothing_to_burn' } };
    await this.#ensureGas(owner.address);
    const tx = await items
      .connect(owner)
      .burn.populateTransaction(owner.address, BigInt(op.payload.tokenId), BigInt(op.payload.amount ?? 1));
    return this.#sign(owner, tx);
  }

  async #preparePublishEpoch(op) {
    const total = BigInt(op.payload.totalUnits);
    if (total === 0n || !op.payload.root) return { alreadyDone: true, result: { skipped: 'empty_epoch' } };
    const existing = await this.lookupExisting(op);
    if (existing) return { alreadyDone: true, result: existing };

    const { SverseRewards: rewards, MockSRV: token } = this.contracts;
    const rewardsAddress = await rewards.getAddress();
    const balance = await token.balanceOf(this.relayer.address);
    if (balance < total) {
      if (this.settlementMode !== 'mint') throw new Error('relayer_insufficient_srv');
      await this.#sendAndWait(this.relayer, await token.mint.populateTransaction(this.relayer.address, total - balance));
    }
    const allowance = await token.allowance(this.relayer.address, rewardsAddress);
    if (allowance < total) {
      await this.#sendAndWait(this.relayer, await token.approve.populateTransaction(rewardsAddress, total));
    }
    const tx = await rewards.publishEpoch.populateTransaction(
      BigInt(op.payload.epochNumber),
      op.payload.root,
      total,
      BigInt(Math.floor(new Date(op.payload.claimDeadline).getTime() / 1000)),
    );
    return this.#sign(this.relayer, tx);
  }

  async #preparePayout(op) {
    const { MockSRV: token } = this.contracts;
    const amount = BigInt(op.payload.amountUnits);
    // Testnet settles payouts by minting tSRV; mainnet transfers from the reserve wallet.
    const tx =
      this.settlementMode === 'mint'
        ? await token.mint.populateTransaction(op.payload.to, amount)
        : await token.transfer.populateTransaction(op.payload.to, amount);
    return this.#sign(this.relayer, tx);
  }

  // ---------------------------------------------------------------- catalog provisioning

  async #ensureDefinition(definition) {
    const { SverseItems: items } = this.contracts;
    const definitionRef = chainRef(definition.ref);
    const existing = await items.definitionRefs(definitionRef);
    if (existing !== 0n) return existing;

    const studioRef = chainRef(definition.studioRef);
    const gameRef = chainRef(definition.gameRef);
    const registeredWallet = await items.studioWallets(studioRef);
    if (registeredWallet === '0x0000000000000000000000000000000000000000') {
      await this.#sendAndWait(this.relayer, await items.registerStudio.populateTransaction(studioRef, definition.studioWallet));
    } else if (registeredWallet.toLowerCase() !== definition.studioWallet.toLowerCase()) {
      throw new Error('studio_wallet_mismatch');
    }
    if ((await items.gameStudios(gameRef)) === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      await this.#sendAndWait(this.relayer, await items.registerGame.populateTransaction(gameRef, studioRef));
    }

    const maxSupply = definition.maxSupply ? BigInt(definition.maxSupply) : UNLIMITED_SUPPLY;
    await this.#sendAndWait(
      this.relayer,
      await items.createItemDefinitionWithRef.populateTransaction(
        definitionRef,
        gameRef,
        maxSupply,
        BigInt(definition.royaltyBps ?? 0),
        Boolean(definition.transferable),
        Boolean(definition.living),
        definition.uri ?? '',
      ),
    );
    return items.definitionRefs(definitionRef);
  }

  async #ensureGas(address) {
    const balance = await this.provider.getBalance(address);
    if (balance >= env.CUSTODIAL_GAS_MIN_WEI) return;
    await this.#sendAndWait(this.relayer, { to: address, value: env.CUSTODIAL_GAS_TOPUP_WEI });
  }

  // ---------------------------------------------------------------- signing

  async #sign(wallet, tx) {
    const sender = wallet.address;
    const nonce = await this.#nextNonce(sender);
    const fee = await this.provider.getFeeData();
    const request = {
      ...tx,
      from: sender,
      nonce,
      chainId: this.chainIdValue,
      type: 2,
      maxFeePerGas: (fee.maxFeePerGas ?? fee.gasPrice) * 2n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 1n,
    };
    try {
      request.gasLimit = ((await this.provider.estimateGas(request)) * 12n) / 10n;
    } catch (error) {
      this.localNonces.delete(sender);
      throw error;
    }
    const rawTx = await wallet.signTransaction(request);
    return { rawTx, txHash: keccak256(rawTx), sender, nonce };
  }

  async #sendAndWait(wallet, tx) {
    const signed = await this.#sign(wallet, tx);
    await this.broadcast(signed.rawTx);
    const receipt = await this.provider.waitForTransaction(signed.txHash, 1, 120_000);
    if (!receipt || receipt.status !== 1) throw new Error(`prerequisite_tx_failed:${signed.txHash}`);
    return receipt;
  }

  async #nextNonce(address) {
    const [pending, floor] = await Promise.all([
      this.provider.getTransactionCount(address, 'pending'),
      this.nonceFloor(address),
    ]);
    const nonce = Math.max(pending, floor, this.localNonces.get(address) ?? 0);
    this.localNonces.set(address, nonce + 1);
    return nonce;
  }

  #resultFromReceipt(op, receipt) {
    const { SverseItems: items, SverseDeedRegistry: deeds } = this.contracts;
    if (op.kind === 'mint_item') {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== String(items.target).toLowerCase()) continue;
        const parsed = items.interface.parseLog(log);
        if (parsed?.name === 'ItemMintedWithRef') {
          return { tokenId: parsed.args.tokenId.toString(), chainDefinitionId: parsed.args.definitionId.toString() };
        }
      }
    }
    if (op.kind === 'record_deed') {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== String(deeds.target).toLowerCase()) continue;
        const parsed = deeds.interface.parseLog(log);
        if (parsed?.name === 'DeedRecorded') return { chainDeedId: parsed.args.deedId };
      }
    }
    return {};
  }

  async #deedId(tokenId, nonce) {
    const { SverseItems: items, SverseDeedRegistry: deeds } = this.contracts;
    return keccak256(
      coder.encode(
        ['uint256', 'address', 'address', 'uint256', 'uint256'],
        [this.chainIdValue, await deeds.getAddress(), await items.getAddress(), tokenId, nonce],
      ),
    );
  }
}

export function deedNonce(ref) {
  return BigInt(chainRef(ref));
}

function serialize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  return value;
}
