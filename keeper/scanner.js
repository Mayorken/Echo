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
 * @param {ethers.Contract} contract EchoMemoryRegistry contract instance
 * @param {object} [options]
 * @param {number} [options.fromBlock=0] Block to start scanning from
 * @returns {Promise<Array<{user: string, cid: string, integrityHash: string, renewalBalance: bigint}>>}
 */
async function scanFundedVaults(contract, options) {
  const fromBlock = (options && options.fromBlock) || 0;

  const memoryFilter = contract.filters.MemoryUpdated();
  const memoryEvents = await contract.queryFilter(memoryFilter, fromBlock);

  const latestCidByUser = new Map();
  for (const event of memoryEvents) {
    const user = event.args[0];
    const cid = event.args[1];
    const integrityHash = event.args[2];
    latestCidByUser.set(user, { cid, integrityHash });
  }

  const fundedVaults = [];
  for (const [user, { cid, integrityHash }] of latestCidByUser) {
    if (!cid) continue;
    const balance = await contract.renewalBalanceOf(user);
    if (balance > 0n) {
      fundedVaults.push({ user, cid, integrityHash, renewalBalance: balance });
    }
  }

  return fundedVaults;
}

module.exports = { scanFundedVaults };
