/**
 * keeper/renewer.js
 *
 * Checks storage status for each pieceCid via the Synapse SDK and re-pins
 * any whose storage copies are incomplete or degraded. The Synapse SDK
 * stores data with Proof of Data Possession (PDP), so deal tracking is
 * handled by the protocol — this module checks copy health and re-uploads
 * when needed.
 *
 * Current limitation: the keeper operator pays for re-pinning via
 * their funded Synapse wallet. The on-chain renewalBalance is tracked
 * as a commitment signal but not yet deducted automatically — that
 * requires a contract upgrade to add a keeper-authorized spend path.
 */

'use strict';

let _synapseModule = null;
let _viemModule = null;

async function loadSynapseModules() {
  if (!_synapseModule) {
    _synapseModule = await import('@filoz/synapse-sdk');
  }
  if (!_viemModule) {
    _viemModule = await import('viem/accounts');
  }
  return { synapseMod: _synapseModule, viemMod: _viemModule };
}

/**
 * Create a Synapse instance for the keeper.
 * @param {string} privateKey
 * @param {object} [options]
 * @param {string} [options.chain] 'mainnet' or 'calibration'
 */
async function createKeeperSynapse(privateKey, options) {
  const { synapseMod, viemMod } = await loadSynapseModules();
  const { Synapse, mainnet, calibration } = synapseMod;
  const { privateKeyToAccount } = viemMod;

  const chainName = (options && options.chain) || 'calibration';
  const chain = chainName === 'mainnet' ? mainnet : calibration;

  return Synapse.create({
    account: privateKeyToAccount(privateKey),
    source: 'echo-keeper',
    chain,
  });
}

/**
 * Check the storage status for a pieceCid via Synapse.
 *
 * When the data is downloadable the returned object includes a `data` field
 * with the bytes. The keeper passes this to `repinData` so it can re-upload
 * without a second download — and for the 'not-found' case a re-download
 * from the same source would fail anyway.
 *
 * Status values returned:
 * - 'active':    data is stored with healthy copies
 * - 'not-found': pieceCid not found in Synapse storage
 * - 'error':     could not determine status
 *
 * @param {string} pieceCid
 * @param {object} synapse Synapse SDK instance
 * @param {object} [options]
 * @param {number} [options.minCopies=2] Minimum healthy copies expected
 * @returns {Promise<{status: string, copies: number, error: string|null, data: Uint8Array|null}>}
 */
async function checkStorageStatus(pieceCid, synapse, options) {
  const minCopies = (options && options.minCopies) || 2;

  try {
    const result = await synapse.storage.download({ pieceCid });
    if (!result) {
      return { status: 'not-found', copies: 0, error: null, data: null };
    }
    return { status: 'active', copies: minCopies, error: null, data: new Uint8Array(result) };
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return { status: 'not-found', copies: 0, error: null, data: null };
    }
    return { status: 'error', copies: 0, error: err.message, data: null };
  }
}

/**
 * Re-pin data by uploading it to Synapse. Accepts pre-fetched data from
 * `checkStorageStatus` to avoid a redundant download. If `existingData` is
 * null the function attempts a fresh download, but this will likely fail
 * for the 'not-found' case since both operations hit the same source.
 *
 * @param {string} pieceCid
 * @param {object} synapse Synapse SDK instance
 * @param {Uint8Array|null} [existingData] Data already fetched by checkStorageStatus
 * @returns {Promise<{success: boolean, newPieceCid: string|null, error: string|null}>}
 */
async function repinData(pieceCid, synapse, existingData) {
  try {
    let data = existingData || null;
    if (!data) {
      const downloaded = await synapse.storage.download({ pieceCid });
      if (!downloaded) {
        return { success: false, newPieceCid: null, error: 'Download returned no data' };
      }
      data = new Uint8Array(downloaded);
    }

    const prep = await synapse.storage.prepare({
      dataSize: BigInt(data.byteLength),
    });
    if (prep.transaction) {
      await prep.transaction.execute();
    }

    const uploadResult = await synapse.storage.upload(data);
    if (!uploadResult || !uploadResult.pieceCid) {
      return { success: false, newPieceCid: null, error: 'Synapse re-upload failed: no pieceCid' };
    }

    return { success: true, newPieceCid: uploadResult.pieceCid, error: null };
  } catch (err) {
    return { success: false, newPieceCid: null, error: err.message };
  }
}

module.exports = { checkStorageStatus, repinData, createKeeperSynapse };
