import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ContractFactory, JsonRpcProvider } from 'ethers';

const CONTRACTS_DIR = path.resolve('../smartcontract');
const PORT = 8547;
const RELAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
let node;

/** Starts `hardhat node`, deploys the six contracts and grants the relayer its roles. */
export async function setup() {
  node = spawn('npx', ['hardhat', 'node', '--port', String(PORT)], { cwd: CONTRACTS_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForRpc(`http://127.0.0.1:${PORT}`);

  const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, 31337, { staticNetwork: true });
  // Hardhat node account #0 is unlocked; it deploys and administers, the relayer only operates.
  const deployer = await provider.getSigner(0);
  const deploy = async (name, args) => {
    const artifact = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const startBlock = await provider.getBlockNumber();
  const srv = await deploy('MockSRV', [deployer.address]);
  const items = await deploy('SverseItems', [deployer.address]);
  const deeds = await deploy('SverseDeedRegistry', [deployer.address]);
  const store = await deploy('SverseStore', [deployer.address, await srv.getAddress(), await items.getAddress(), deployer.address, 250]);
  const market = await deploy('SverseMarketplace', [deployer.address, await srv.getAddress(), await items.getAddress(), deployer.address, 250]);
  const rewards = await deploy('SverseRewards', [deployer.address, await srv.getAddress(), deployer.address]);

  await (await deeds.setTrustedCollection(await items.getAddress(), true)).wait();
  await (await items.grantRole(await items.PLATFORM_ROLE(), RELAYER)).wait();
  await (await items.grantRole(await items.MINTER_ROLE(), RELAYER)).wait();
  await (await deeds.grantRole(await deeds.WITNESS_ROLE(), RELAYER)).wait();
  await (await rewards.grantRole(await rewards.PUBLISHER_ROLE(), RELAYER)).wait();
  await (await srv.grantRole(await srv.MINTER_ROLE(), RELAYER)).wait();

  mkdirSync(path.resolve('tests/.chain'), { recursive: true });
  writeFileSync(
    path.resolve('tests/.chain/deployment.json'),
    JSON.stringify(
      {
        network: 'hardhat-test',
        chainId: 31337,
        startBlock,
        relayer: RELAYER,
        contracts: {
          MockSRV: await srv.getAddress(),
          SverseItems: await items.getAddress(),
          SverseDeedRegistry: await deeds.getAddress(),
          SverseStore: await store.getAddress(),
          SverseMarketplace: await market.getAddress(),
          SverseRewards: await rewards.getAddress(),
        },
      },
      null,
      2,
    ),
  );
}

export async function teardown() {
  node?.kill('SIGTERM');
}

async function waitForRpc(url) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('hardhat node did not start');
}
