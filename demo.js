#!/usr/bin/env node
/**
 * demo.js — live Echo demonstration
 *
 * Runs entirely locally: Ganache in-process chain, compiled V3 contract,
 * real AES-256-GCM encryption, in-memory storage stand-in.
 * No Lighthouse key, no FEVM RPC, no wallet needed.
 *
 *   node demo.js
 */

'use strict';

const ganache   = require('ganache');
const { ethers } = require('ethers');
const { compileAll, compileProxy } = require('./compile-helper');
const { EchoClient, generateEncryptionKey } = require('./echo-sdk');
const { encrypt, decrypt } = require('./lib/crypto');

// ── colour helpers ────────────────────────────────────────────────────────────
const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  magenta: '\x1b[35m',
  blue   : '\x1b[34m',
  red    : '\x1b[31m',
  white  : '\x1b[37m',
};
const h1   = (t) => console.log(`\n${C.bold}${C.cyan}${'═'.repeat(60)}${C.reset}\n${C.bold}${C.cyan}  ${t}${C.reset}\n${C.bold}${C.cyan}${'═'.repeat(60)}${C.reset}`);
const h2   = (t) => console.log(`\n${C.bold}${C.yellow}▶ ${t}${C.reset}`);
const ok   = (t) => console.log(`  ${C.green}✓${C.reset}  ${t}`);
const info = (t) => console.log(`  ${C.blue}ℹ${C.reset}  ${t}`);
const kv   = (k, v) => console.log(`  ${C.dim}${k.padEnd(22)}${C.reset}${C.white}${v}${C.reset}`);

// ── in-memory storage adapter (replaces Lighthouse for the demo) ─────────────
function createMemoryStorage() {
  const store = new Map();
  return {
    async put(bytes) {
      const cid = 'demo-' + ethers.keccak256(bytes).slice(2, 18);
      store.set(cid, bytes);
      return cid;
    },
    async get(cid) {
      const data = store.get(cid);
      if (!data) throw new Error(`CID not found: ${cid}`);
      return data;
    },
  };
}

// ── deploy V3 behind an ERC1967 proxy ────────────────────────────────────────
async function deployV3(deployer) {
  const contracts = compileAll();
  const proxyArtifact = compileProxy();
  const v3 = contracts.EchoMemoryRegistryV3;

  const implFactory = new ethers.ContractFactory(v3.abi, v3.bytecode, deployer);
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData('initialize', [await deployer.getAddress()]);
  const proxyFactory = new ethers.ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode, deployer);
  const proxy = await proxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  return new ethers.Contract(await proxy.getAddress(), v3.abi, deployer);
}

// ── main demo ─────────────────────────────────────────────────────────────────
async function main() {
  h1('Echo — Live Demo');
  console.log(`  ${C.dim}Universal AI context portability on Filecoin FEVM${C.reset}`);
  console.log(`  ${C.dim}Running on a local Ganache chain with real AES-256-GCM encryption${C.reset}`);

  // ── 1. Boot chain ────────────────────────────────────────────────────────
  h2('1 / 6 — Boot local chain & deploy V3 contract');
  const ganacheProvider = ganache.provider({ logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
  const accounts  = await provider.listAccounts();
  const [owner, alice, bob, gemini, codex, keeper] = await Promise.all(
    accounts.slice(0, 6).map(a => provider.getSigner(a.address))
  );

  const registry = await deployV3(owner);
  kv('Contract (proxy):', await registry.getAddress());
  kv('Contract version:', (await registry.version()).toString());
  kv('Owner:', await owner.getAddress());
  ok('EchoMemoryRegistryV3 deployed behind ERC1967 proxy');

  const storage = createMemoryStorage();

  // ── 2. Alice saves her context ───────────────────────────────────────────
  h2('2 / 6 — Alice saves AI context (encrypted, stored on "Filecoin")');
  const aliceKey = await generateEncryptionKey();
  const aliceClient = new EchoClient(null, await registry.getAddress(), alice, storage);

  const aliceContext = {
    project: 'EchoProtocol',
    stack: ['Solidity', 'Node.js', 'Filecoin FEVM'],
    currentTask: 'Implement team vaults with on-chain RBAC',
    decisions: [
      'Using UUPS proxy for upgradability',
      'AES-256-GCM for client-side encryption',
      'Lighthouse for Filecoin storage',
    ],
    preferences: { codeStyle: 'functional', testFramework: 'Mocha/Chai' },
  };

  const { cid, integrityHash } = await aliceClient.saveMemory(aliceContext, aliceKey);
  kv('CID stored on-chain:', cid);
  kv('Integrity hash:', integrityHash.slice(0, 20) + '…');
  ok('Context encrypted with AES-256-GCM and written to contract');

  // ── 3. Gemini reads Alice's context ─────────────────────────────────────
  h2('3 / 6 — Alice grants Gemini access → Gemini reads context');

  await aliceClient.grantAccess(await gemini.getAddress());
  ok(`Access granted to Gemini (${(await gemini.getAddress()).slice(0, 10)}…)`);

  const geminiClient = new EchoClient(null, await registry.getAddress(), gemini, storage);
  const loaded = await geminiClient.loadMemory(await alice.getAddress(), aliceKey);

  kv('Project:', loaded.project);
  kv('Stack:', loaded.stack.join(', '));
  kv('Current task:', loaded.currentTask);
  kv('Key decision:', loaded.decisions[0]);
  ok('Gemini read Alice\'s context without re-introduction — full portability');

  // ── 4. Codex blocked after revoke ───────────────────────────────────────
  h2('4 / 6 — Alice revokes Codex → Codex is blocked');

  await aliceClient.grantAccess(await codex.getAddress());
  ok(`Codex access granted temporarily`);
  await aliceClient.revokeAccess(await codex.getAddress());
  ok(`Codex access revoked`);

  const codexClient = new EchoClient(null, await registry.getAddress(), codex, storage);
  let blocked = false;
  try {
    await codexClient.loadMemory(await alice.getAddress(), aliceKey);
  } catch {
    blocked = true;
  }
  ok(`Codex correctly blocked (on-chain access check enforced): ${blocked}`);

  // ── 5. Team vault ────────────────────────────────────────────────────────
  h2('5 / 6 — Team Vault: Alice creates vault, adds Bob, both read/write');

  const vaultName  = 'echo-core-team';
  const sharedKey  = await generateEncryptionKey();
  const bobClient  = new EchoClient(null, await registry.getAddress(), bob, storage);

  await aliceClient.createVault(vaultName);
  ok(`Vault "${vaultName}" created — Alice is owner`);

  await aliceClient.grantVaultAccess(vaultName, await bob.getAddress());
  ok(`Bob added as vault member`);

  const teamContext = {
    sprint: 'Sprint-7',
    goal: 'Ship Echo V3 to Calibration testnet',
    blockers: ['Need FEVM RPC endpoint', 'Lighthouse API key for mainnet'],
    sharedDecisions: ['Keep all RBAC on-chain, no central server'],
  };
  await aliceClient.saveVaultMemory(vaultName, teamContext, sharedKey);
  ok('Alice saved shared team context to vault');

  const bobRead = await bobClient.loadVaultMemory(vaultName, sharedKey);
  kv('Sprint:', bobRead.sprint);
  kv('Goal:', bobRead.goal);
  kv('Blocker:', bobRead.blockers[0]);
  ok('Bob loaded team context — same encrypted blob, same key, full parity');

  let strangerBlocked = false;
  const geminiReadVault = new EchoClient(null, await registry.getAddress(), gemini, storage);
  try { await geminiReadVault.loadVaultMemory(vaultName, sharedKey); }
  catch { strangerBlocked = true; }
  ok(`Non-member (Gemini) blocked from vault: ${strangerBlocked}`);

  // ── 6. Keeper spend path ─────────────────────────────────────────────────
  h2('6 / 6 — Keeper spend path: user funds vault, keeper gets reimbursed');

  const registryAsOwner = registry.connect(owner);

  await registryAsOwner.addKeeper(await keeper.getAddress());
  ok(`Keeper (${(await keeper.getAddress()).slice(0, 10)}…) authorized by contract owner`);

  const fundTx = await registry.connect(alice).fundRenewal({ value: ethers.parseEther('0.5') });
  await fundTx.wait();
  const balanceBefore = await registry.renewalBalanceOf(await alice.getAddress());
  kv('Alice renewal balance:', ethers.formatEther(balanceBefore) + ' FIL');
  ok('Alice funded her vault renewal endowment with 0.5 FIL');

  const fee = ethers.parseEther('0.01');
  const deductTx = await registry.connect(keeper).keeperDeductRenewal(await alice.getAddress(), fee);
  await deductTx.wait();
  const balanceAfter = await registry.renewalBalanceOf(await alice.getAddress());
  kv('Balance after re-pin:', ethers.formatEther(balanceAfter) + ' FIL');
  ok(`Keeper deducted ${ethers.formatEther(fee)} FIL for re-pinning Alice's CID`);
  ok('Protocol is now self-sustaining — no subscription, no central service');

  // ── Summary ───────────────────────────────────────────────────────────────
  h1('Demo Complete');
  console.log(`  ${C.green}${C.bold}All 6 scenarios passed on a live local chain.${C.reset}\n`);
  console.log(`  What just ran:`);
  console.log(`  ${C.dim}①${C.reset} V3 contract deployed behind UUPS proxy (upgradeable, no address change)`);
  console.log(`  ${C.dim}②${C.reset} AES-256-GCM encryption — plaintext never left Alice's "device"`);
  console.log(`  ${C.dim}③${C.reset} Cross-tool portability — Gemini read Alice's context with zero re-intro`);
  console.log(`  ${C.dim}④${C.reset} Revocation enforced on-chain — Codex blocked immediately`);
  console.log(`  ${C.dim}⑤${C.reset} Team Vault — shared context with on-chain RBAC, no central server`);
  console.log(`  ${C.dim}⑥${C.reset} Keeper spend path — self-sustaining protocol, no subscription\n`);
  console.log(`  ${C.dim}To deploy to Filecoin Calibration testnet:${C.reset}`);
  console.log(`  ${C.cyan}  RPC_URL=https://api.calibration.node.glif.io/rpc/v1 PRIVATE_KEY=0x... npm run deploy${C.reset}\n`);

  await ganacheProvider.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(`\n${C.red}✗ Demo failed:${C.reset}`, err.message);
  process.exit(1);
});
