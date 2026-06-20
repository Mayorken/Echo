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
 * EchoMemoryRegistryV3.sol — swap in a deployed contract address and an
 * RPC URL to point it at FEVM Calibration testnet or mainnet.
 */

const { ethers } = require('ethers');
const registryAbi = require('./EchoMemoryRegistry.abi.json');
const { encrypt, decrypt, generateKey } = require('./lib/crypto');

class EchoClient {
  /**
   * @param {string} rpcUrl FEVM RPC endpoint, e.g. Filecoin Calibration testnet
   * @param {string} contractAddress Deployed EchoMemoryRegistry proxy address
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

  // =========================================================================
  // Personal vault (original V1 API)
  // =========================================================================

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

  // =========================================================================
  // Team Vaults (V3 API)
  //
  // vaultName is a human-readable string (e.g. "team-alpha"). The SDK hashes
  // it with keccak256 (ethers.id) to produce the bytes32 vaultId used on-chain,
  // so the same string always maps to the same vault.
  // =========================================================================

  /** @param {string} vaultName Human-readable vault identifier */
  _vaultId(vaultName) {
    return ethers.id(vaultName);
  }

  /**
   * Create a new shared vault. The caller becomes the vault owner and the
   * first member. Only the owner can later grant or revoke other members.
   * @param {string} vaultName Human-readable name (e.g. "team-alpha")
   */
  async createVault(vaultName) {
    const tx = await this.contract.createVault(this._vaultId(vaultName));
    return tx.wait();
  }

  /**
   * Save a context snapshot to a shared team vault.
   * Any current vault member (not just the owner) can write.
   * The context is encrypted client-side before upload — vault members
   * must share the encryption key out-of-band (e.g. via a key-agreement protocol).
   * @param {string} vaultName
   * @param {object} memoryObject
   * @param {Uint8Array} encryptionKey 32-byte key shared by all vault members
   */
  async saveVaultMemory(vaultName, memoryObject, encryptionKey) {
    const plaintext = new TextEncoder().encode(JSON.stringify(memoryObject));
    const integrityHash = ethers.keccak256(plaintext);

    const encrypted = await encrypt(plaintext, encryptionKey);
    const cid = await this.storage.put(encrypted);

    const tx = await this.contract.updateVaultMemory(this._vaultId(vaultName), cid, integrityHash);
    await tx.wait();
    return { cid, integrityHash };
  }

  /**
   * Load and decrypt a team vault's context. Caller must be a vault member.
   * @param {string} vaultName
   * @param {Uint8Array} decryptionKey the shared 32-byte key
   */
  async loadVaultMemory(vaultName, decryptionKey) {
    const [cid, integrityHash] = await this.contract.getVaultMemory(this._vaultId(vaultName));
    if (!cid) return null;

    const encrypted = await this.storage.get(cid);
    const plaintext = await decrypt(encrypted, decryptionKey);

    const computedHash = ethers.keccak256(plaintext);
    if (computedHash !== integrityHash) {
      throw new Error('Vault memory integrity check failed: data does not match on-chain hash');
    }
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  /**
   * Grant a teammate access to a vault. Only the vault owner can call this.
   * @param {string} vaultName
   * @param {string} memberAddress Ethereum address of the new member
   */
  async grantVaultAccess(vaultName, memberAddress) {
    const tx = await this.contract.grantVaultAccess(this._vaultId(vaultName), memberAddress);
    return tx.wait();
  }

  /**
   * Revoke a member's access. Only the vault owner can call this.
   * The owner cannot revoke themselves.
   * @param {string} vaultName
   * @param {string} memberAddress
   */
  async revokeVaultAccess(vaultName, memberAddress) {
    const tx = await this.contract.revokeVaultAccess(this._vaultId(vaultName), memberAddress);
    return tx.wait();
  }

  /**
   * Check whether an address is currently a member of a vault.
   * @param {string} vaultName
   * @param {string} memberAddress
   * @returns {Promise<boolean>}
   */
  async hasVaultAccess(vaultName, memberAddress) {
    return this.contract.hasVaultAccess(this._vaultId(vaultName), memberAddress);
  }

  /**
   * Return the on-chain owner of a vault (zero address if vault doesn't exist).
   * @param {string} vaultName
   * @returns {Promise<string>}
   */
  async getVaultOwner(vaultName) {
    return this.contract.getVaultOwner(this._vaultId(vaultName));
  }

  /**
   * List every address ever granted access to the vault (caller must be a member).
   * Filter through hasVaultAccess() to find currently active members.
   * @param {string} vaultName
   * @returns {Promise<string[]>}
   */
  async listVaultMembers(vaultName) {
    return this.contract.getVaultMembers(this._vaultId(vaultName));
  }
}

// =========================================================================
// Social Login — optional Web3Auth provider factory
//
// Adds social login (Google, GitHub, etc.) as an alternative to a raw
// private key, without building a centralized auth server. Web3Auth derives
// a non-custodial key client-side; the user's Filecoin address is
// deterministic from their social identity, and the key never leaves the browser.
//
// Usage (browser only — requires @web3auth/modal):
//
//   import { createWeb3AuthSigner } from 'echo-sdk';
//
//   const signer = await createWeb3AuthSigner('YOUR_WEB3AUTH_CLIENT_ID', {
//     rpcUrl: 'https://api.calibration.node.glif.io/rpc/v1',
//     network: 'sapphire_devnet',  // or 'sapphire_mainnet' for production
//   });
//   const client = new EchoClient(rpcUrl, contractAddress, signer, storage);
//
// Install the optional dep separately: npm install @web3auth/modal
// =========================================================================

/**
 * Create an ethers Signer backed by Web3Auth social login.
 *
 * This is intentionally thin — it initializes and connects Web3Auth, then
 * wraps the provider in ethers so the rest of the SDK works unchanged.
 * The caller is responsible for showing any UI around the login flow.
 *
 * @param {string} clientId Web3Auth project client ID (from dashboard.web3auth.io)
 * @param {object} options
 * @param {string} options.rpcUrl FEVM RPC endpoint (used as the chain's RPC)
 * @param {string} [options.network='sapphire_devnet'] Web3Auth network
 *        ('sapphire_devnet' for testnet, 'sapphire_mainnet' for production)
 * @param {number} [options.chainId=314159] Chain ID (314159 = Filecoin Calibration, 314 = mainnet)
 * @param {string} [options.displayName='Filecoin'] Chain display name for the Web3Auth modal
 * @param {string} [options.ticker='FIL'] Native currency ticker
 * @returns {Promise<ethers.Signer>}
 */
async function createWeb3AuthSigner(clientId, options = {}) {
  let Web3Auth, CHAIN_NAMESPACES;
  try {
    ({ Web3Auth } = require('@web3auth/modal'));
    ({ CHAIN_NAMESPACES } = require('@web3auth/base'));
  } catch {
    throw new Error(
      'Web3Auth packages not installed. Run: npm install @web3auth/modal @web3auth/base'
    );
  }

  const rpcUrl = options.rpcUrl || 'https://api.calibration.node.glif.io/rpc/v1';
  const chainId = options.chainId || 314159;
  const network = options.network || 'sapphire_devnet';

  const web3auth = new Web3Auth({
    clientId,
    web3AuthNetwork: network,
    chainConfig: {
      chainNamespace: CHAIN_NAMESPACES.EIP155,
      chainId: '0x' + chainId.toString(16),
      rpcTarget: rpcUrl,
      displayName: options.displayName || 'Filecoin',
      ticker: options.ticker || 'FIL',
      tickerName: options.tickerName || 'Filecoin',
    },
  });

  await web3auth.initModal();
  const web3authProvider = await web3auth.connect();

  if (!web3authProvider) {
    throw new Error('Web3Auth login cancelled or failed');
  }

  const ethersProvider = new ethers.BrowserProvider(web3authProvider);
  return ethersProvider.getSigner();
}

const { createLighthouseStorage } = require('./lib/storage');

module.exports = { EchoClient, generateEncryptionKey: generateKey, createLighthouseStorage, createWeb3AuthSigner };
