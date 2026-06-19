/**
 * keeper/index.js
 *
 * The auto-renewal keeper: scans the EchoMemoryRegistry for funded vaults,
 * checks each CID's Filecoin deal status, and re-pins any that are expiring
 * or have no active deal.
 *
 * Designed to run on a schedule (cron) or as a long-running process with
 * a configurable polling interval.
 */

const { ethers } = require('ethers');
const registryAbi = require('../EchoMemoryRegistry.abi.json');
const { scanFundedVaults } = require('./scanner');
const { checkDealStatus, repinCid } = require('./renewer');

/**
 * Run one sweep: scan for funded vaults, check deal status, re-pin as needed.
 *
 * @param {object} config
 * @param {string} config.rpcUrl FEVM RPC endpoint
 * @param {string} config.contractAddress Deployed EchoMemoryRegistry proxy address
 * @param {string} config.lighthouseApiKey Lighthouse API key for re-pinning
 * @param {number} [config.fromBlock=0] Block to start scanning from
 * @param {number} [config.expiryThresholdEpochs] Epochs before expiry to trigger renewal
 * @param {string} [config.gateway] IPFS gateway URL
 * @param {function} [config.log] Logger function (defaults to console.log)
 * @returns {Promise<{scanned: number, renewed: number, errors: number, results: Array}>}
 */
async function runSweep(config) {
  const log = config.log || console.log;
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const contract = new ethers.Contract(config.contractAddress, registryAbi, provider);

  log('[keeper] Starting sweep...');

  const vaults = await scanFundedVaults(contract, { fromBlock: config.fromBlock || 0 });
  log(`[keeper] Found ${vaults.length} funded vault(s)`);

  const results = [];
  let renewed = 0;
  let errors = 0;

  for (const vault of vaults) {
    const { user, cid, renewalBalance } = vault;
    log(`[keeper] Checking vault: user=${user} cid=${cid} balance=${ethers.formatEther(renewalBalance)} FIL`);

    const dealCheck = await checkDealStatus(cid, {
      expiryThresholdEpochs: config.expiryThresholdEpochs,
    });

    if (dealCheck.status === 'active') {
      log(`[keeper]   Deal is active — no action needed`);
      results.push({ user, cid, action: 'none', dealStatus: 'active' });
      continue;
    }

    log(`[keeper]   Deal status: ${dealCheck.status} — attempting re-pin`);
    const repin = await repinCid(cid, config.lighthouseApiKey, {
      gateway: config.gateway,
    });

    if (repin.success) {
      renewed++;
      log(`[keeper]   Re-pinned successfully (new CID: ${repin.newCid})`);
      results.push({ user, cid, action: 'renewed', newCid: repin.newCid, dealStatus: dealCheck.status });
    } else {
      errors++;
      log(`[keeper]   Re-pin failed: ${repin.error}`);
      results.push({ user, cid, action: 'error', error: repin.error, dealStatus: dealCheck.status });
    }
  }

  log(`[keeper] Sweep complete: ${vaults.length} scanned, ${renewed} renewed, ${errors} errors`);

  return { scanned: vaults.length, renewed, errors, results };
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

  async function sweep() {
    if (running) {
      log('[keeper] Previous sweep still running, skipping');
      return;
    }
    running = true;
    try {
      await runSweep(config);
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
