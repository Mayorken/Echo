/**
 * integrations/rest-api.js
 *
 * Express REST API that wraps the Echo SDK, exposing context portability
 * operations as HTTP endpoints. This is the universal integration point
 * for AI tools — any platform with HTTP capabilities can use it:
 *
 *   - ChatGPT (via Actions / OpenAPI spec)
 *   - Claude (via MCP HTTP transport or direct tool use)
 *   - Gemini, Codex, or any other AI tool
 *
 * Environment variables:
 *   RPC_URL            — FEVM RPC endpoint
 *   CONTRACT_ADDRESS   — Deployed EchoMemoryRegistry proxy address
 *   PRIVATE_KEY        — Wallet private key for signing transactions
 *   SYNAPSE_PRIVATE_KEY — Private key for Synapse SDK Filecoin storage
 *   SYNAPSE_CHAIN      — 'mainnet' or 'calibration' (default: 'calibration')
 *   ENCRYPTION_KEY     — Hex-encoded 32-byte encryption key (or generate one)
 *   PORT               — Server port (default: 3000)
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const { EchoClient, generateEncryptionKey } = require('../echo-sdk');
const { createSynapseStorage } = require('../lib/storage');
const {
  generateApiKey,
  validateApiKey,
  createAuthChallenge,
  consumeAuthChallenge,
} = require('../lib/apiKeys');

function parseHexKey(hex, headerName) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${headerName} header must be a 64-character hex string (32 bytes)`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function createApp(config) {
  const {
    rpcUrl,
    contractAddress,
    signer,
    storage,
    encryptionKey,
    operatorApiKey,
    corsOrigins = [],
  } = config;

  const app = express();
  app.use(helmet());
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins }));
  }
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));

  const client = new EchoClient(rpcUrl, contractAddress, signer, storage);
  const serviceWalletAddress = signer && signer.address ? signer.address : null;

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', contractAddress, timestamp: new Date().toISOString() });
  });

  app.use((req, res, next) => {
    if (req.path.startsWith('/v1/')) return next();
    if (!operatorApiKey) {
      return res.status(503).json({ error: 'Self-hosted operator routes are disabled' });
    }
    if (req.get('X-Echo-Operator-Key') !== operatorApiKey) {
      return res.status(401).json({ error: 'Missing or invalid operator key' });
    }
    next();
  });

  /**
   * POST /context/save
   * Save a context snapshot for the connected user.
   * Body: { context: { ...any JSON... } }
   */
  app.post('/context/save', async (req, res) => {
    try {
      const { context } = req.body;
      if (!context || typeof context !== 'object') {
        return res.status(400).json({ error: 'Request body must include a "context" object' });
      }
      const result = await client.saveMemory(context, encryptionKey);
      res.json({ success: true, cid: result.cid, integrityHash: result.integrityHash });
    } catch (err) {
      console.error('POST /context/save error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /context/load/:userAddress
   * Load and decrypt a user's context. Requires granted access.
   */
  app.get('/context/load/:userAddress', async (req, res) => {
    try {
      const { userAddress } = req.params;
      if (!ethers.isAddress(userAddress)) {
        return res.status(400).json({ error: 'Invalid Ethereum address' });
      }
      const context = await client.loadMemory(userAddress, encryptionKey);
      if (context === null) {
        return res.json({ context: null, message: 'No context stored for this user' });
      }
      res.json({ context });
    } catch (err) {
      console.error('GET /context/load error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /access/grant
   * Grant an AI tool read access to the user's context.
   * Body: { appAddress: "0x..." }
   */
  app.post('/access/grant', async (req, res) => {
    try {
      const { appAddress } = req.body;
      if (!appAddress || !ethers.isAddress(appAddress)) {
        return res.status(400).json({ error: 'Valid "appAddress" is required' });
      }
      await client.grantAccess(appAddress);
      res.json({ success: true, granted: appAddress });
    } catch (err) {
      console.error('POST /access/grant error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /access/revoke
   * Revoke an AI tool's access to the user's context.
   * Body: { appAddress: "0x..." }
   */
  app.post('/access/revoke', async (req, res) => {
    try {
      const { appAddress } = req.body;
      if (!appAddress || !ethers.isAddress(appAddress)) {
        return res.status(400).json({ error: 'Valid "appAddress" is required' });
      }
      await client.revokeAccess(appAddress);
      res.json({ success: true, revoked: appAddress });
    } catch (err) {
      console.error('POST /access/revoke error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /access/list/:userAddress
   * List all AI tools that have been granted access, with current status.
   */
  app.get('/access/list/:userAddress', async (req, res) => {
    try {
      const { userAddress } = req.params;
      if (!ethers.isAddress(userAddress)) {
        return res.status(400).json({ error: 'Invalid Ethereum address' });
      }
      const apps = await client.listAccess(userAddress);
      res.json({ apps });
    } catch (err) {
      console.error('GET /access/list error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /renewal/fund
   * Fund the perpetual-storage renewal endowment.
   * Body: { amountInFil: "0.1" }
   */
  app.post('/renewal/fund', async (req, res) => {
    try {
      const { amountInFil } = req.body;
      if (!amountInFil || isNaN(Number(amountInFil)) || Number(amountInFil) <= 0) {
        return res.status(400).json({ error: 'Valid "amountInFil" is required (positive number as string)' });
      }
      await client.fundRenewal(amountInFil);
      res.json({ success: true, funded: amountInFil });
    } catch (err) {
      console.error('POST /renewal/fund error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /key/generate
   * Generate a new 256-bit encryption key (hex-encoded).
   */
  app.post('/key/generate', async (req, res) => {
    try {
      const key = await generateEncryptionKey();
      const hex = Buffer.from(key).toString('hex');
      res.json({ key: hex });
    } catch (err) {
      console.error('POST /key/generate error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Team Vault routes (V3) ────────────────────────────────────────────────
  // Switch between personal and team context by calling the /vault/* routes
  // instead of /context/* and supplying a vaultName. The target address in
  // integration configs determines which path to use.

  /**
   * POST /vault/create
   * Create a new shared team vault with the current signer as owner.
   * Body: { vaultName: "team-alpha" }
   */
  app.post('/vault/create', async (req, res) => {
    try {
      const { vaultName } = req.body;
      if (!vaultName || typeof vaultName !== 'string') {
        return res.status(400).json({ error: '"vaultName" string is required' });
      }
      await client.createVault(vaultName);
      res.json({ success: true, vault: vaultName });
    } catch (err) {
      console.error('POST /vault/create error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /vault/save
   * Save shared AI context to a team vault.
   * Body: { vaultName: "team-alpha", context: { ...any JSON... } }
   */
  app.post('/vault/save', async (req, res) => {
    try {
      const { vaultName, context } = req.body;
      if (!vaultName || typeof vaultName !== 'string') {
        return res.status(400).json({ error: '"vaultName" string is required' });
      }
      if (!context || typeof context !== 'object') {
        return res.status(400).json({ error: '"context" object is required' });
      }
      const result = await client.saveVaultMemory(vaultName, context, encryptionKey);
      res.json({ success: true, vault: vaultName, cid: result.cid, integrityHash: result.integrityHash });
    } catch (err) {
      console.error('POST /vault/save error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /vault/load/:vaultName
   * Load and decrypt the shared AI context from a team vault.
   * Caller must be a current vault member.
   */
  app.get('/vault/load/:vaultName', async (req, res) => {
    try {
      const { vaultName } = req.params;
      if (!vaultName) {
        return res.status(400).json({ error: 'vaultName is required' });
      }
      const context = await client.loadVaultMemory(vaultName, encryptionKey);
      if (context === null) {
        return res.json({ context: null, message: 'No context stored for this vault' });
      }
      res.json({ context });
    } catch (err) {
      console.error('GET /vault/load error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /vault/grant
   * Grant a teammate access to a vault. Only the vault owner can call this.
   * Body: { vaultName: "team-alpha", memberAddress: "0x..." }
   */
  app.post('/vault/grant', async (req, res) => {
    try {
      const { vaultName, memberAddress } = req.body;
      if (!vaultName || typeof vaultName !== 'string') {
        return res.status(400).json({ error: '"vaultName" string is required' });
      }
      if (!memberAddress || !ethers.isAddress(memberAddress)) {
        return res.status(400).json({ error: 'Valid "memberAddress" is required' });
      }
      await client.grantVaultAccess(vaultName, memberAddress);
      res.json({ success: true, vault: vaultName, granted: memberAddress });
    } catch (err) {
      console.error('POST /vault/grant error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /vault/revoke
   * Revoke a member's access. Only the vault owner can call this.
   * Body: { vaultName: "team-alpha", memberAddress: "0x..." }
   */
  app.post('/vault/revoke', async (req, res) => {
    try {
      const { vaultName, memberAddress } = req.body;
      if (!vaultName || typeof vaultName !== 'string') {
        return res.status(400).json({ error: '"vaultName" string is required' });
      }
      if (!memberAddress || !ethers.isAddress(memberAddress)) {
        return res.status(400).json({ error: 'Valid "memberAddress" is required' });
      }
      await client.revokeVaultAccess(vaultName, memberAddress);
      res.json({ success: true, vault: vaultName, revoked: memberAddress });
    } catch (err) {
      console.error('POST /vault/revoke error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Hosted multi-tenant routes (API key auth) ──────────────────────────────
  // Everything above operates as "the connected user" = this server's own
  // signer (self-hosted mode: one operator, one wallet). The routes below let
  // a hosted deployment serve many users, each authenticating with an API key
  // instead of a wallet. A user must first grant this server's wallet
  // (serviceWalletAddress) read access (and, for saving, write access — see
  // grantWriteAccess() in echo-sdk.js) before signing up here.
  //
  // Trust note: because this server performs the encrypt/decrypt itself, the
  // caller's encryption key and plaintext context necessarily pass through
  // this process transiently (in-memory, per-request, never persisted) —
  // that's a different trust boundary than encryption happening entirely in
  // the end user's own browser or device. Worth being explicit about rather
  // than implying it's identical to the fully client-side model.

  /**
   * POST /v1/auth/challenge
   * Create a short-lived message the user must sign with their wallet.
   */
  app.post('/v1/auth/challenge', (req, res) => {
    const { userAddress } = req.body;
    if (!userAddress || !ethers.isAddress(userAddress)) {
      return res.status(400).json({ error: 'Valid "userAddress" is required' });
    }
    res.json(createAuthChallenge(userAddress));
  });

  /**
   * POST /v1/auth/signup
   * Issue an API key for a user who has already granted this server's wallet
   * read access on-chain. Body: { userAddress: "0x..." }
   */
  app.post('/v1/auth/signup', async (req, res) => {
    try {
      if (!serviceWalletAddress) {
        return res.status(503).json({ error: 'Hosted mode is not configured on this server' });
      }
      const { userAddress, signature } = req.body;
      if (!userAddress || !ethers.isAddress(userAddress)) {
        return res.status(400).json({ error: 'Valid "userAddress" is required' });
      }
      if (!signature || typeof signature !== 'string') {
        return res.status(400).json({ error: 'Wallet signature is required' });
      }
      const challenge = consumeAuthChallenge(userAddress);
      if (!challenge) {
        return res.status(401).json({ error: 'Authentication challenge is missing or expired' });
      }
      let recovered;
      try {
        recovered = ethers.verifyMessage(challenge.message, signature);
      } catch {
        return res.status(401).json({ error: 'Invalid wallet signature' });
      }
      if (recovered.toLowerCase() !== userAddress.toLowerCase()) {
        return res.status(401).json({ error: 'Signature does not match userAddress' });
      }
      const granted = await client.contract.hasAccess(userAddress, serviceWalletAddress);
      if (!granted) {
        return res.status(403).json({
          error: `Address ${userAddress} has not granted this service (${serviceWalletAddress}) read access yet. Call grantAccess() first.`,
        });
      }
      const apiKey = generateApiKey(userAddress);
      res.json({ apiKey, userAddress });
    } catch (err) {
      console.error('POST /v1/auth/signup error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  async function requireApiKey(req, res, next) {
    const header = req.get('Authorization') || '';
    const apiKey = header.startsWith('Bearer ') ? header.slice(7) : null;
    const record = apiKey ? validateApiKey(apiKey) : null;
    if (!record) {
      return res.status(401).json({ error: 'Missing or invalid API key' });
    }
    try {
      const stillGranted = await client.contract.hasAccess(record.userAddress, serviceWalletAddress);
      if (!stillGranted) {
        return res.status(403).json({ error: 'On-chain access has been revoked' });
      }
    } catch (err) {
      console.error('API key authorization check error:', err.message);
      return res.status(503).json({ error: 'Authorization service unavailable' });
    }
    req.userAddress = record.userAddress;
    next();
  }

  /**
   * GET /v1/context
   * Load and decrypt the signed-in user's context.
   * Header: X-Echo-Key: <64-char hex decryption key>
   */
  app.get('/v1/context', requireApiKey, async (req, res) => {
    try {
      const decryptionKey = parseHexKey(req.get('X-Echo-Key'), 'X-Echo-Key');
      const context = await client.loadMemory(req.userAddress, decryptionKey);
      if (context === null) {
        return res.json({ context: null, message: 'No context stored for this user' });
      }
      res.json({ context });
    } catch (err) {
      console.error('GET /v1/context error:', err.message);
      const status = /X-Echo-Key header/.test(err.message) ? 400 : 500;
      res.status(status).json({ error: status === 400 ? err.message : 'Internal server error' });
    }
  });

  /**
   * POST /v1/context
   * Save context on the signed-in user's behalf. Requires the user to have
   * granted this server's wallet write access (grantWriteAccess()).
   * Header: X-Echo-Key: <64-char hex encryption key>
   * Body: { context: { ...any JSON... } }
   */
  app.post('/v1/context', requireApiKey, async (req, res) => {
    try {
      const { context } = req.body;
      if (!context || typeof context !== 'object') {
        return res.status(400).json({ error: 'Request body must include a "context" object' });
      }
      const encKey = parseHexKey(req.get('X-Echo-Key'), 'X-Echo-Key');
      const result = await client.saveMemoryFor(req.userAddress, context, encKey);
      res.json({ success: true, cid: result.cid, integrityHash: result.integrityHash });
    } catch (err) {
      console.error('POST /v1/context error:', err.message);
      const status = /X-Echo-Key header/.test(err.message) ? 400 : 500;
      res.status(status).json({ error: status === 400 ? err.message : 'Internal server error' });
    }
  });

  return app;
}

async function startServer() {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.PRIVATE_KEY;
  const synapsePrivateKey = process.env.SYNAPSE_PRIVATE_KEY;
  const encryptionKeyHex = process.env.ENCRYPTION_KEY;
  const operatorApiKey = process.env.OPERATOR_API_KEY;
  const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
  const port = Number(process.env.PORT) || 3000;

  if (!rpcUrl) { console.error('Error: RPC_URL required'); process.exit(1); }
  if (!contractAddress) { console.error('Error: CONTRACT_ADDRESS required'); process.exit(1); }
  if (!privateKey) { console.error('Error: PRIVATE_KEY required'); process.exit(1); }
  if (!synapsePrivateKey) { console.error('Error: SYNAPSE_PRIVATE_KEY required'); process.exit(1); }
  if (!operatorApiKey) {
    console.warn('Warning: OPERATOR_API_KEY is not set; signer-backed self-hosted routes are disabled');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const signer = new ethers.Wallet(privateKey, provider);
  const storage = await createSynapseStorage(synapsePrivateKey, {
    chain: process.env.SYNAPSE_CHAIN || 'calibration',
  });

  let encryptionKey;
  if (encryptionKeyHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)');
    }
    encryptionKey = Uint8Array.from(Buffer.from(encryptionKeyHex, 'hex'));
  } else {
    console.warn('Warning: No ENCRYPTION_KEY set — generating a temporary one (will not persist across restarts)');
    const { randomBytes } = require('crypto');
    encryptionKey = new Uint8Array(randomBytes(32));
    console.log('Generated key (save this):', Buffer.from(encryptionKey).toString('hex'));
  }

  const app = createApp({
    rpcUrl,
    contractAddress,
    signer,
    storage,
    encryptionKey,
    operatorApiKey,
    corsOrigins,
  });
  app.listen(port, () => {
    console.log(`Echo REST API running on http://localhost:${port}`);
    console.log(`Contract: ${contractAddress}`);
    console.log(`Wallet: ${signer.address}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createApp };
