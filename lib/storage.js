/**
 * lib/storage.js
 *
 * Synapse SDK storage adapter for Echo — wires the SDK's put/get interface
 * to real Filecoin storage via the Synapse SDK (https://docs.filecoin.cloud).
 *
 * Upload uses Synapse's storage.upload API; retrieval uses storage.download.
 * The adapter matches the { put(bytes)->cid, get(cid)->bytes } contract that
 * EchoClient expects, so swapping from the in-memory fake used in tests to
 * real Filecoin storage is a one-line change:
 *
 *   const storage = await createSynapseStorage(privateKey);
 *   const client = new EchoClient(rpcUrl, contractAddr, signer, storage);
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
 * Create a Synapse SDK-backed storage adapter.
 *
 * @param {string} privateKey Hex-encoded private key (with 0x prefix) for a
 *        wallet funded with FIL (gas) and USDFC (storage payments).
 * @param {object} [options]
 * @param {string} [options.chain] 'mainnet' or 'calibration' (default: 'calibration')
 * @param {string} [options.source] Application identifier stored as metadata (default: 'echo')
 * @param {boolean} [options.withCDN] Enable Filecoin Beam CDN for faster retrieval
 * @param {boolean} [options.autoPrepare] Automatically call prepare() before upload (default: true)
 * @returns {Promise<{ put(bytes: Uint8Array): Promise<string>, get(cid: string): Promise<Uint8Array> }>}
 */
async function createSynapseStorage(privateKey, options) {
  if (!privateKey) {
    throw new Error('Private key is required for Synapse storage — fund a wallet with FIL + USDFC');
  }

  const { synapseMod, viemMod } = await loadSynapseModules();
  const { Synapse, mainnet, calibration } = synapseMod;
  const { privateKeyToAccount } = viemMod;

  const chainName = (options && options.chain) || 'calibration';
  const chain = chainName === 'mainnet' ? mainnet : calibration;
  const source = (options && options.source) || 'echo';
  const autoPrepare = options && options.autoPrepare !== undefined ? options.autoPrepare : true;

  const account = privateKeyToAccount(privateKey);

  const synapseOpts = { account, source, chain };
  if (options && options.withCDN) {
    synapseOpts.withCDN = true;
  }
  const synapse = Synapse.create(synapseOpts);

  return {
    /**
     * Upload encrypted context bytes to Filecoin via Synapse SDK.
     * @param {Uint8Array} bytes
     * @returns {Promise<string>} pieceCid
     */
    async put(bytes) {
      if (autoPrepare) {
        const prep = await synapse.storage.prepare({
          dataSize: BigInt(bytes.byteLength),
        });
        if (prep.transaction) {
          await prep.transaction.execute();
        }
      }

      const result = await synapse.storage.upload(bytes);
      if (!result || !result.pieceCid) {
        throw new Error('Synapse upload failed: no pieceCid in response');
      }
      return result.pieceCid;
    },

    /**
     * Retrieve context bytes from Filecoin by pieceCid.
     * @param {string} pieceCid
     * @returns {Promise<Uint8Array>}
     */
    async get(pieceCid) {
      if (!pieceCid || typeof pieceCid !== 'string') {
        throw new Error('Invalid pieceCid format');
      }
      const data = await synapse.storage.download({ pieceCid });
      return new Uint8Array(data);
    },
  };
}

module.exports = { createSynapseStorage };
