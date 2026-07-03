/**
 * keeper/index.js
 *
 * The auto-renewal keeper: scans the EchoMemoryRegistry for funded vaults,
 * checks each CID's storage status via Synapse, and re-pins any that are
 * degraded or not found.
 *
 * After a successful re-pin the keeper calls keeperDeductRenewal() to pull
 * the re-pinning cost from the user's on-chain renewalBalance. This makes
 * the Keeper self-sustaining: users pre-fund their vault, any authorized
 * Keeper services it and gets reimbursed on-chain, no subscription needed.
 *
 * Designed to run on a schedule (cron) or as a long-running process with
 * a configurable polling interval.
 */

const { ethers } = require('ethers');
const registryAbi = require('../EchoMemoryRegistry.abi.json');
const { scanFundedVaults } = require('./scanner');
const { checkStorageStatus, repinData, createKeeperSynapse } = require('./renewer');

/**
 * Run one sweep: scan for funded vaults, check storage status, re-pin as
 * needed, and deduct the keeper fee from the user's on-chain balance.
 *
 * @param {object} config
 * @param {string} config.rpcUrl FEVM RPC endpoint
 * @param {string} config.contractAddress Deployed EchoMemoryRegistry proxy address
 * @param {string} config.synapsePrivateKey Private key for Synapse storage operations
 * @param {string} [config.keeperPrivateKey] Keeper's private key for signing
 *        keeperDeductRenewal transactions. If omitted, the keeper runs in
 *        read-only/observation mode and logs what it would do without deducting.
 * @param {bigint|string} [config.keeperFeeWei='10000000000000000'] Fee per
 *        successful re-pin in wei (default 0.01 FIL). Must be <= user's
 *        renewalBalance or the deduction is skipped.
 * @param {number} [config.fromBlock=0] Block to start scanning from
 * @param {string} [config.chain] 'mainnet' or 'calibration' (default: 'calibration')
 * @param {function} [config.log] Logger function (defaults to console.log)
 * @returns {Promise<{scanned: number, renewed: number, errors: number, lastBlock: number, results: Array}>}
 */
async function runSweep(config) {
  const log = config.log || console.log;
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });

  let contract;
  let keeperSigner = null;
  if (config.keeperPrivateKey) {
    keeperSigner = new ethers.Wallet(config.keeperPrivateKey, provider);
    contract = new ethers.Contract(config.contractAddress, registryAbi, keeperSigner);
  } else {
    contract = new ethers.Contract(config.contractAddress, registryAbi, provider);
    log('[keeper] No KEEPER_PRIVATE_KEY — running in observation mode (no deductions)');
  }

  const keeperFeeWei = config.keeperFeeWei
    ? BigInt(config.keeperFeeWei)
    : ethers.parseEther('0.01');

  const MAX_REASONABLE_FEE = ethers.parseEther('1');
  if (keeperFeeWei > MAX_REASONABLE_FEE) {
    throw new Error(
      `keeperFeeWei (${keeperFeeWei}) exceeds 1 FIL — this looks like a misconfiguration. ` +
      `Set config.keeperFeeWei explicitly or check your environment variables.`
    );
  }

  log('[keeper] Starting sweep...');

  const synapse = await createKeeperSynapse(config.synapsePrivateKey, {
    chain: config.chain,
  });

  const { vaults, lastBlock } = await scanFundedVaults(contract, { fromBlock: config.fromBlock || 0 });
  log(`[keeper] Found ${vaults.length} funded vault(s) (scanned to block ${lastBlock})`);

  const results = [];
  let renewed = 0;
  let errors = 0;

  for (const vault of vaults) {
    const { user, cid, renewalBalance } = vault;
    log(`[keeper] Checking vault: user=${user} cid=${cid} balance=${ethers.formatEther(renewalBalance)} FIL`);

    const storageCheck = await checkStorageStatus(cid, synapse);

    if (storageCheck.status === 'active') {
      log(`[keeper]   Storage is healthy — no action needed`);
      results.push({ user, cid, action: 'none', storageStatus: 'active' });
      continue;
    }

    if (storageCheck.status === 'error') {
      errors++;
      log(`[keeper]   Storage status check failed: ${storageCheck.error || 'unknown error'} — skipping`);
      results.push({ user, cid, action: 'error', error: storageCheck.error || 'status check failed', storageStatus: 'error' });
      continue;
    }

    if (storageCheck.status === 'not-found' && !storageCheck.data) {
      errors++;
      log(`[keeper]   Data not found in Synapse — cannot re-pin (data is not recoverable from same source)`);
      results.push({ user, cid, action: 'error', error: 'Data not found — cannot re-pin from same storage source', storageStatus: 'not-found' });
      continue;
    }

    log(`[keeper]   Storage status: ${storageCheck.status} — attempting re-pin`);
    const repin = await repinData(cid, synapse, storageCheck.data);

    if (!repin.success) {
      errors++;
      log(`[keeper]   Re-pin failed: ${repin.error}`);
      results.push({ user, cid, action: 'error', error: repin.error, storageStatus: storageCheck.status });
      continue;
    }

    renewed++;
    log(`[keeper]   Re-pinned successfully (new pieceCid: ${repin.newPieceCid})`);

    let deducted = false;
    if (keeperSigner && renewalBalance >= keeperFeeWei) {
      try {
        const tx = await contract.keeperDeductRenewal(user, keeperFeeWei);
        await tx.wait();
        deducted = true;
        log(`[keeper]   Deducted ${ethers.formatEther(keeperFeeWei)} FIL from ${user}`);
      } catch (deductErr) {
        log(`[keeper]   Deduction failed (non-fatal): ${deductErr.message}`);
      }
    } else if (keeperSigner) {
      log(`[keeper]   Balance too low to deduct fee — re-pin done gratis`);
    }

    results.push({
      user,
      cid,
      action: 'renewed',
      newPieceCid: repin.newPieceCid,
      storageStatus: storageCheck.status,
      feeDeducted: deducted ? keeperFeeWei.toString() : '0',
    });
  }

  log(`[keeper] Sweep complete: ${vaults.length} scanned, ${renewed} renewed, ${errors} errors`);

  return { scanned: vaults.length, renewed, errors, lastBlock, results };
}

/**
 * Start the keeper as a long-running process with periodic sweeps.
 *
 * @param {object} config Same as runSweep config, plus:
 * @param {number} [config.intervalMs=3600000] Milliseconds between sweeps (default: 1 hour)
 * @returns {{ stop: function }} Call stop() to halt the keeper
 */
function startKeeper(config) {
  const intervalMs = config.intervalMs || 3600000;
  const log = config.log || console.log;
  let timer = null;
  let running = false;
  let nextFromBlock = config.fromBlock || 0;

  async function sweep() {
    if (running) {
      log('[keeper] Previous sweep still running, skipping');
      return;
    }
    running = true;
    try {
      const result = await runSweep({ ...config, fromBlock: nextFromBlock });
      if (result.lastBlock > nextFromBlock) {
        nextFromBlock = result.lastBlock;
      }
    } catch (err) {
      log(`[keeper] Sweep error: ${err.message}`);
    }
    running = false;
  }

  sweep();
  timer = setInterval(sweep, intervalMs);

  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      log('[keeper] Stopped');
    },
  };
}

module.exports = { runSweep, startKeeper };
