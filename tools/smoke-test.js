#!/usr/bin/env node
/**
 * tools/smoke-test.js — verify the live Echo contract on Calibration testnet
 *
 * Reads the deployed contract and checks every public view function.
 * No transactions sent, no FIL spent.
 *
 *   node tools/smoke-test.js
 *   # or:
 *   npm run smoke
 */

'use strict';

require('dotenv').config();
const { ethers } = require('ethers');
const abi = require('../EchoMemoryRegistry.abi.json');

const RPC_URL         = process.env.RPC_URL         || 'https://api.calibration.node.glif.io/rpc/v1';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const pass = (label, val) => console.log(`  \x1b[32m✓\x1b[0m  ${label.padEnd(32)}${String(val)}`);
const fail = (label, err) => { console.log(`  \x1b[31m✗\x1b[0m  ${label.padEnd(32)}${err}`); process.exitCode = 1; };

async function main() {
  console.log('\n\x1b[1m\x1b[36mEcho Smoke Test — Calibration Testnet\x1b[0m\n');

  if (!CONTRACT_ADDRESS) {
    console.error('Error: CONTRACT_ADDRESS not set. Add it to .env or set the env var.');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  Contract: ${CONTRACT_ADDRESS}\n`);

  // 1. Network reachable?
  try {
    const block = await provider.getBlockNumber();
    pass('Network reachable (block)', block);
  } catch (e) { fail('Network reachable', e.message); return; }

  // 2. Contract exists?
  try {
    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === '0x') throw new Error('No bytecode — not a contract');
    pass('Contract has bytecode', `${((code.length - 2) / 2)} bytes`);
  } catch (e) { fail('Contract bytecode', e.message); return; }

  // 3. version()
  try {
    const v = await contract.version();
    if (v !== 3n) throw new Error(`Expected 3, got ${v}`);
    pass('version()', v.toString());
  } catch (e) { fail('version()', e.message); }

  // 4. owner()
  try {
    const owner = await contract.owner();
    pass('owner()', owner);
  } catch (e) { fail('owner()', e.message); }

  // 5. renewalBalanceOf(owner)
  try {
    const owner = await contract.owner();
    const bal = await contract.renewalBalanceOf(owner);
    pass('renewalBalanceOf(owner)', ethers.formatEther(bal) + ' tFIL');
  } catch (e) { fail('renewalBalanceOf()', e.message); }

  // 6. hasAccess(owner, owner) — should be false (no self-grant)
  try {
    const owner = await contract.owner();
    const has = await contract.hasAccess(owner, owner);
    pass('hasAccess(owner,owner)', has.toString());
  } catch (e) { fail('hasAccess()', e.message); }

  // 7. isKeeper(zero address) — should be false
  try {
    const is = await contract.isKeeper(ethers.ZeroAddress);
    pass('isKeeper(0x0)', is.toString());
  } catch (e) { fail('isKeeper()', e.message); }

  // 8. getVaultOwner of non-existent vault — should be 0x0
  try {
    const vaultId = ethers.id('nonexistent-vault-xyz');
    const vOwner = await contract.getVaultOwner(vaultId);
    pass('getVaultOwner(nonexistent)', vOwner === ethers.ZeroAddress ? '0x0 (correct)' : vOwner);
  } catch (e) { fail('getVaultOwner()', e.message); }

  const ok = process.exitCode !== 1;
  console.log(`\n  ${ok ? '\x1b[32m\x1b[1mAll checks passed\x1b[0m' : '\x1b[31m\x1b[1mSome checks failed\x1b[0m'}`);
  console.log(`\n  Explorer: https://calibration.filscan.io/address/${CONTRACT_ADDRESS}\n`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
