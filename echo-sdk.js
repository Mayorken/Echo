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
    const plaintext = new TextEncoder().encode(JSON.stringify(memoryObject));
    const integrityHash = ethers.keccak256(plaintext);

    const encrypted = await encrypt(plaintext, encryptionKey);
    const cid = await this.storage.put(encrypted);

    const tx = await this.contract.updateMemory(cid, integrityHash);
    await tx.wait();
    return { cid, integrityHash };
  }

  /**
   * Read another (or your own) user's context, decrypt, and verify integrity.
   * Will revert on-chain if the calling AI tool hasn't been granted access.
   * @param {string} userAddress
   * @param {Uint8Array} decryptionKey the same 32-byte key used in saveMemory
   */
  async loadMemory(userAddress, decryptionKey) {
    const [cid, integrityHash] = await this.contract.getMemory(userAddress);
    if (!cid) return null;

    const encrypted = await this.storage.get(cid);
    const plaintext = await decrypt(encrypted, decryptionKey);

    const computedHash = ethers.keccak256(plaintext);
    if (computedHash !== integrityHash) {
      throw new Error('Memory integrity check failed: retrieved data does not match on-chain hash');
    }
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  /** Grant a new AI tool (by its contract/wallet address) read access to your context. */
  async grantAccess(appAddress) {
    const tx = await this.contract.grantAccess(appAddress);
    return tx.wait();
  }

  /** Revoke a previously granted tool's access — the user controls who reads their context. */
  async revokeAccess(appAddress) {
    const tx = await this.contract.revokeAccess(appAddress);
    return tx.wait();
  }

  /** Fund the perpetual-storage renewal endowment for your vault. */
  async fundRenewal(amountInFil) {
    const tx = await this.contract.fundRenewal({ value: ethers.parseEther(amountInFil) });
    return tx.wait();
  }

  /** List every AI tool ever granted access, with their current (live) status. */
  async listAccess(userAddress) {
    const history = await this.contract.appAccessHistory(userAddress);
    const withStatus = await Promise.all(
      history.map(async (app) => ({ app, active: await this.contract.hasAccess(userAddress, app) }))
    );
    return withStatus;
  }
}

const { createLighthouseStorage } = require('./lib/storage');

module.exports = { EchoClient, generateEncryptionKey: generateKey, createLighthouseStorage };
