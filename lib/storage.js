/**
 * lib/storage.js
 *
 * Lighthouse storage adapter for Echo — wires the SDK's put/get interface
 * to real Filecoin storage via Lighthouse (https://lighthouse.storage).
 *
 * Upload uses Lighthouse's uploadBuffer API; retrieval fetches from an IPFS
 * gateway. The adapter matches the { put(bytes)->cid, get(cid)->bytes }
 * contract that EchoClient expects, so swapping from the in-memory fake
 * used in tests to real Filecoin storage is a one-line change:
 *
 *   const storage = createLighthouseStorage(apiKey);
 *   const client = new EchoClient(rpcUrl, contractAddr, signer, storage);
 */

const lighthouse = require('@lighthouse-web3/sdk');

const DEFAULT_GATEWAY = 'https://gateway.lighthouse.storage/ipfs';

/**
 * Create a Lighthouse-backed storage adapter.
 * @param {string} apiKey Lighthouse API key (get one at https://files.lighthouse.storage)
 * @param {object} [options]
 * @param {string} [options.gateway] IPFS gateway base URL (defaults to Lighthouse's public gateway)
 * @returns {{ put(bytes: Uint8Array): Promise<string>, get(cid: string): Promise<Uint8Array> }}
 */
function createLighthouseStorage(apiKey, options) {
  if (!apiKey) throw new Error('Lighthouse API key is required — get one at https://files.lighthouse.storage');
  const gateway = (options && options.gateway) || DEFAULT_GATEWAY;

  return {
    /**
     * Upload encrypted context bytes to Filecoin via Lighthouse.
     * @param {Uint8Array} bytes
     * @returns {Promise<string>} CID
     */
    async put(bytes) {
      const buffer = Buffer.from(bytes);
      const response = await lighthouse.uploadBuffer(buffer, apiKey);
      if (!response || !response.data || !response.data.Hash) {
        throw new Error('Lighthouse upload failed: unexpected response');
      }
      return response.data.Hash;
    },

    /**
     * Retrieve context bytes from Filecoin/IPFS by CID.
     * @param {string} cid
     * @returns {Promise<Uint8Array>}
     */
    async get(cid) {
      const url = `${gateway}/${cid}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to retrieve CID ${cid}: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    },
  };
}

module.exports = { createLighthouseStorage, DEFAULT_GATEWAY };
