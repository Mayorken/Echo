#!/usr/bin/env node

/**
 * keeper.js — CLI entry point for the auto-renewal keeper bot.
 *
 * Environment variables:
 *   RPC_URL              — FEVM RPC endpoint (e.g. Calibration testnet)
 *   CONTRACT_ADDRESS     — Deployed EchoMemoryRegistry proxy address
 *   SYNAPSE_PRIVATE_KEY  — Private key for Synapse storage operations (re-pinning)
 *   KEEPER_INTERVAL_MS   — Milliseconds between sweeps (default: 3600000 = 1 hour)
 *   KEEPER_FROM_BLOCK    — Block number to start scanning from (default: 0)
 *   SYNAPSE_CHAIN        — 'mainnet' or 'calibration' (default: 'calibration')
 *
 * Usage:
 *   # One-time sweep:
 *   node keeper.js --once
 *
 *   # Long-running daemon:
 *   node keeper.js
 */

require('dotenv').config();
const { runSweep, startKeeper } = require('./keeper/index');

const config = {
  rpcUrl: process.env.RPC_URL,
  contractAddress: process.env.CONTRACT_ADDRESS,
  synapsePrivateKey: process.env.SYNAPSE_PRIVATE_KEY,
  intervalMs: Number(process.env.KEEPER_INTERVAL_MS) || 3600000,
  fromBlock: Number(process.env.KEEPER_FROM_BLOCK) || 0,
  chain: process.env.SYNAPSE_CHAIN || 'calibration',
};

if (!config.rpcUrl) {
  console.error('Error: RPC_URL environment variable is required');
  process.exit(1);
}
if (!config.contractAddress) {
  console.error('Error: CONTRACT_ADDRESS environment variable is required');
  process.exit(1);
}
if (!config.synapsePrivateKey) {
  console.error('Error: SYNAPSE_PRIVATE_KEY environment variable is required');
  process.exit(1);
}

const isOnce = process.argv.includes('--once');

if (isOnce) {
  runSweep(config)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal error:', err.message);
      process.exit(1);
    });
} else {
  console.log(`Starting keeper daemon (interval: ${config.intervalMs}ms)`);
  const keeper = startKeeper(config);

  process.on('SIGINT', () => {
    keeper.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    keeper.stop();
    process.exit(0);
  });
}
