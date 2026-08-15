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

// Filecoin Onchain Cloud rejects pieces smaller than 127 bytes. Echo memories
// are encrypted before reaching this adapter, so a concise fact can still be
// below that threshold. Wrap only short values in a tiny, reversible envelope;
// existing (unwrapped) pieces remain fully backwards compatible.
const MIN_PIECE_BYTES = 127;
const PAD_MAGIC = Uint8Array.from([0x45, 0x43, 0x48, 0x4f, 0x50, 0x41, 0x44, 0x01]); // ECHOPAD\x01
const PAD_HEADER_BYTES = PAD_MAGIC.length + 4;

function prepareUploadBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength >= MIN_PIECE_BYTES) return bytes;

  const padded = new Uint8Array(MIN_PIECE_BYTES);
  padded.set(PAD_MAGIC, 0);
  new DataView(padded.buffer).setUint32(PAD_MAGIC.length, bytes.byteLength, false);
  padded.set(bytes, PAD_HEADER_BYTES);
  return padded;
}

function restoreDownloadBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < PAD_HEADER_BYTES
    || !PAD_MAGIC.every((value, index) => bytes[index] === value)) {
    return bytes;
  }

  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(PAD_MAGIC.length, false);
  if (length > bytes.byteLength - PAD_HEADER_BYTES) {
    throw new Error('Invalid Echo storage padding envelope');
  }
  return bytes.slice(PAD_HEADER_BYTES, PAD_HEADER_BYTES + length);
}

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
    accountAddress: account.address,
    /**
     * Upload encrypted context bytes to Filecoin via Synapse SDK.
     * @param {Uint8Array} bytes
     * @returns {Promise<string>} pieceCid
     */
    async put(bytes) {
      const uploadBytes = prepareUploadBytes(bytes);
      if (autoPrepare) {
        const prep = await synapse.storage.prepare({
          dataSize: BigInt(uploadBytes.byteLength),
        });
        if (prep.transaction) {
          await prep.transaction.execute();
        }
      }

      const result = await synapse.storage.upload(uploadBytes);
      if (!result || !result.pieceCid) {
        throw new Error('Synapse upload failed: no pieceCid in response');
      }
      const pieceCid = result.pieceCid.toString();
      if (!pieceCid || pieceCid === '[object Object]') {
        throw new Error('Synapse upload failed: invalid pieceCid in response');
      }
      return pieceCid;
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
      return restoreDownloadBytes(new Uint8Array(data));
    },
  };
}

module.exports = {
  createSynapseStorage,
  prepareUploadBytes,
  restoreDownloadBytes,
  MIN_PIECE_BYTES,
};
