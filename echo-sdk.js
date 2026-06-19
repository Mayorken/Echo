/**
 * echo-sdk.js
 *
 * Client SDK any AI tool integrates to read and write a user's portable
 * Echo context. Two things happen on every write:
 *
 *   1. The context is encrypted client-side and uploaded to Filecoin
 *      (via a storage gateway like web3.storage / Lighthouse / Synapse SDK),
 *      which returns a CID.
 *   2. That CID + an integrity hash get written to the EchoMemoryRegistry
 *      contract on FEVM, scoped to the user's wallet.
 *
 * Reading is the mirror image: fetch the CID + hash from the contract (only
 * works if the calling AI tool has been granted access), pull the encrypted
 * blob from Filecoin, decrypt client-side, and verify it against the hash.
 *
 * This file is a working scaffold against the real ABI generated from
 * EchoMemoryRegistry.sol — swap in a deployed contract address and an
 * RPC URL to point it at FEVM Calibration testnet or mainnet.
 */

const { ethers } = require('ethers');
const registryAbi = require('./EchoMemoryRegistry.abi.json');
const { encrypt, decrypt, generateKey } = require('./lib/crypto');

class EchoClient {
  /**
   * @param {string} rpcUrl FEVM RPC endpoint, e.g. Filecoin Calibration testnet
   * @param {string} contractAddress Deployed EchoMemoryRegistry address
   * @param {ethers.Signer} signer The end user's wallet signer (e.g. from a
   *        browser wallet), or the AI tool's own signer when reading on the
   *        user's behalf with granted access.
   * @param {object} storage An adapter exposing put(bytes) -> cid and get(cid) -> bytes,
   *        backed by whichever Filecoin storage gateway the tool uses.
   */
  constructor(rpcUrl, contractAddress, signer, storage) {
    if (!rpcUrl || typeof rpcUrl !== 'string') {
      throw new Error('EchoClient: rpcUrl must be a non-empty string');
    }
    if (!contractAddress || typeof contractAddress !== 'string') {
      throw new Error('EchoClient: contractAddress must be a non-empty string');
    }
    if (!storage || typeof storage.put !== 'function' || typeof storage.get !== 'function') {
      throw new Error('EchoClient: storage must implement put(bytes) and get(cid)');
    }

    // Wrapping in a NonceManager avoids a real race we hit during testing:
    // providers can serve a momentarily stale "pending" nonce when several
    // transactions are sent back-to-back from the same address (e.g. save,
    // then grant, then revoke). NonceManager tracks the next nonce locally
    // instead of re-querying the provider for every send.
    //
    // this.provider is only constructed in read-only mode (no signer) —
    // when a signer is given, its own provider is used and we don't spin up
    // a second, unused provider doing background work nobody awaits.
    const runner = signer
      ? new ethers.NonceManager(signer)
      : (this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 }));
    this.contract = new ethers.Contract(contractAddress, registryAbi, runner);
    this.storage = storage;
  }

  /**
   * Save the latest context snapshot for the connected user.
   * @param {object} memoryObject Plain JS object: project context, preferences, decisions, etc.
   * @param {Uint8Array} encryptionKey 32-byte symmetric key controlled by the
   *        user — generate one with generateEncryptionKey(). Never sent on-chain.
   */
  async saveMemory(memoryObject, encryptionKey) {
    if (memoryObject == null) {
      throw new Error('saveMemory: memoryObject must not be null or undefined');
    }
    if (!(encryptionKey instanceof Uint8Array) || encryptionKey.length !== 32) {
      throw new Error('saveMemory: encryptionKey must be a 32-byte Uint8Array');
    }

    let plaintext;
    try {
      plaintext = new TextEncoder().encode(JSON.stringify(memoryObject));
    } catch (err) {
      throw new Error(`saveMemory: failed to serialize memoryObject: ${err.message}`);
    }

    const integrityHash = ethers.keccak256(plaintext);

    const encrypted = await encrypt(plaintext, encryptionKey);

    let cid;
    try {
      cid = await this.storage.put(encrypted);
    } catch (err) {
      throw new Error(`saveMemory: storage.put failed: ${err.message}`);
    }

    try {
      const tx = await this.contract.updateMemory(cid, integrityHash);
      await tx.wait();
    } catch (err) {
      throw new Error(`saveMemory: on-chain updateMemory failed: ${err.message}`);
    }

    return { cid, integrityHash };
  }

  /**
   * Read another (or your own) user's context, decrypt, and verify integrity.
   * Will revert on-chain if the calling AI tool hasn't been granted access.
   * @param {string} userAddress
   * @param {Uint8Array} decryptionKey the same 32-byte key used in saveMemory
   */
  async loadMemory(userAddress, decryptionKey) {
    if (!userAddress || typeof userAddress !== 'string') {
      throw new Error('loadMemory: userAddress must be a non-empty string');
    }
    if (!(decryptionKey instanceof Uint8Array) || decryptionKey.length !== 32) {
      throw new Error('loadMemory: decryptionKey must be a 32-byte Uint8Array');
    }

    let cid, integrityHash;
    try {
      [cid, integrityHash] = await this.contract.getMemory(userAddress);
    } catch (err) {
      throw new Error(`loadMemory: on-chain getMemory failed (access may be denied): ${err.message}`);
    }
    if (!cid) return null;

    let encrypted;
    try {
      encrypted = await this.storage.get(cid);
    } catch (err) {
      throw new Error(`loadMemory: storage.get failed for CID "${cid}": ${err.message}`);
    }

    let plaintext;
    try {
      plaintext = await decrypt(encrypted, decryptionKey);
    } catch (err) {
      throw new Error(`loadMemory: decryption failed (wrong key or corrupted data): ${err.message}`);
    }

    const computedHash = ethers.keccak256(plaintext);
    if (computedHash !== integrityHash) {
      throw new Error('loadMemory: integrity check failed — retrieved data does not match on-chain hash');
    }

    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
      throw new Error(`loadMemory: failed to parse decrypted memory as JSON: ${err.message}`);
    }
  }

  /** Grant a new AI tool (by its contract/wallet address) read access to your context. */
  async grantAccess(appAddress) {
    if (!appAddress || typeof appAddress !== 'string') {
      throw new Error('grantAccess: appAddress must be a non-empty string');
    }
    try {
      const tx = await this.contract.grantAccess(appAddress);
      return tx.wait();
    } catch (err) {
      throw new Error(`grantAccess: transaction failed for ${appAddress}: ${err.message}`);
    }
  }

  /** Revoke a previously granted tool's access — the user controls who reads their context. */
  async revokeAccess(appAddress) {
    if (!appAddress || typeof appAddress !== 'string') {
      throw new Error('revokeAccess: appAddress must be a non-empty string');
    }
    try {
      const tx = await this.contract.revokeAccess(appAddress);
      return tx.wait();
    } catch (err) {
      throw new Error(`revokeAccess: transaction failed for ${appAddress}: ${err.message}`);
    }
  }

  /** Fund the perpetual-storage renewal endowment for your vault. */
  async fundRenewal(amountInFil) {
    if (!amountInFil || typeof amountInFil !== 'string') {
      throw new Error('fundRenewal: amountInFil must be a non-empty string (e.g. "1.0")');
    }
    let value;
    try {
      value = ethers.parseEther(amountInFil);
    } catch (err) {
      throw new Error(`fundRenewal: invalid FIL amount "${amountInFil}": ${err.message}`);
    }
    try {
      const tx = await this.contract.fundRenewal({ value });
      return tx.wait();
    } catch (err) {
      throw new Error(`fundRenewal: transaction failed: ${err.message}`);
    }
  }

  /** List every AI tool ever granted access, with their current (live) status. */
  async listAccess(userAddress) {
    if (!userAddress || typeof userAddress !== 'string') {
      throw new Error('listAccess: userAddress must be a non-empty string');
    }

    let history;
    try {
      history = await this.contract.appAccessHistory(userAddress);
    } catch (err) {
      throw new Error(`listAccess: failed to fetch access history: ${err.message}`);
    }

    const withStatus = await Promise.all(
      history.map(async (app) => {
        try {
          return { app, active: await this.contract.hasAccess(userAddress, app) };
        } catch (err) {
          return { app, active: null, error: err.message };
        }
      })
    );
    return withStatus;
  }
}

const { createLighthouseStorage } = require('./lib/storage');

module.exports = { EchoClient, generateEncryptionKey: generateKey, createLighthouseStorage };
