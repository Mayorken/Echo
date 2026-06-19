/**
 * keeper/scanner.js
 *
 * Scans the EchoMemoryRegistry contract for active vaults that have both
 * a stored CID and a non-zero renewal balance. These are the vaults the
 * keeper should monitor for deal expiry.
 */

const { ethers } = require('ethers');

/**
 * Scan the contract for vaults that need renewal monitoring.
 * Finds all users who have emitted MemoryUpdated events, then checks
 * which ones have a non-zero renewal balance.
 *
 * Returns a `lastBlock` field so the caller can pass it as `fromBlock`
 * on the next sweep, avoiding redundant re-scans of old blocks.
 *
 * @param {ethers.Contract} contract EchoMemoryRegistry contract instance
 * @param {object} [options]
 * @param {number} [options.fromBlock=0] Block to start scanning from
 * @returns {Promise<{vaults: Array<{user: string, cid: string, integrityHash: string, renewalBalance: bigint}>, lastBlock: number}>}
 */
async function scanFundedVaults(contract, options) {
  const fromBlock = (options && options.fromBlock) || 0;

  const memoryFilter = contract.filters.MemoryUpdated();
  const memoryEvents = await contract.queryFilter(memoryFilter, fromBlock);

  let lastBlock = fromBlock;
  const latestCidByUser = new Map();
  for (const event of memoryEvents) {
    const user = event.args[0];
    const cid = event.args[1];
    const integrityHash = event.args[2];
    latestCidByUser.set(user, { cid, integrityHash });
    if (event.blockNumber > lastBlock) lastBlock = event.blockNumber;
  }

  const fundedVaults = [];
  for (const [user, { cid, integrityHash }] of latestCidByUser) {
    if (!cid) continue;
    const balance = await contract.renewalBalanceOf(user);
    if (balance > 0n) {
      fundedVaults.push({ user, cid, integrityHash, renewalBalance: balance });
    }
  }

  return { vaults: fundedVaults, lastBlock };
}

module.exports = { scanFundedVaults };
