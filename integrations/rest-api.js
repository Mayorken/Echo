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
 *   LIGHTHOUSE_API_KEY — Lighthouse API key for Filecoin storage
 *   ENCRYPTION_KEY     — Hex-encoded 32-byte encryption key (or generate one)
 *   PORT               — Server port (default: 3000)
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const { EchoClient, generateEncryptionKey } = require('../echo-sdk');
const { createLighthouseStorage } = require('../lib/storage');

function createApp(config) {
  const {
    rpcUrl,
    contractAddress,
    signer,
    storage,
    encryptionKey,
  } = config;

  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));

  const client = new EchoClient(rpcUrl, contractAddress, signer, storage);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', contractAddress, timestamp: new Date().toISOString() });
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

  return app;
}

function startServer() {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.PRIVATE_KEY;
  const lighthouseApiKey = process.env.LIGHTHOUSE_API_KEY;
  const encryptionKeyHex = process.env.ENCRYPTION_KEY;
  const port = Number(process.env.PORT) || 3000;

  if (!rpcUrl) { console.error('Error: RPC_URL required'); process.exit(1); }
  if (!contractAddress) { console.error('Error: CONTRACT_ADDRESS required'); process.exit(1); }
  if (!privateKey) { console.error('Error: PRIVATE_KEY required'); process.exit(1); }
  if (!lighthouseApiKey) { console.error('Error: LIGHTHOUSE_API_KEY required'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const signer = new ethers.Wallet(privateKey, provider);
  const storage = createLighthouseStorage(lighthouseApiKey);

  let encryptionKey;
  if (encryptionKeyHex) {
    encryptionKey = Uint8Array.from(Buffer.from(encryptionKeyHex, 'hex'));
  } else {
    console.warn('Warning: No ENCRYPTION_KEY set — generating a temporary one (will not persist across restarts)');
    const { randomBytes } = require('crypto');
    encryptionKey = new Uint8Array(randomBytes(32));
    console.log('Generated key (save this):', Buffer.from(encryptionKey).toString('hex'));
  }

  const app = createApp({ rpcUrl, contractAddress, signer, storage, encryptionKey });
  app.listen(port, () => {
    console.log(`Echo REST API running on http://localhost:${port}`);
    console.log(`Contract: ${contractAddress}`);
    console.log(`Wallet: ${signer.address}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp };
