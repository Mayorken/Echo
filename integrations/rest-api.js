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
const { BillingLedger } = require('../lib/billingLedger');
const { createMcpAuth, verifyPkce } = require('../lib/mcpAuth');
const { handleRemoteMcp } = require('../lib/remoteMcp');
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

async function broadcastRawTransaction(rpcUrl, rawTransaction, fetchImpl = fetch) {
  const request = async (method, params) => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`Filecoin RPC returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) {
      const rpcError = new Error(payload.error.message || JSON.stringify(payload.error));
      rpcError.code = payload.error.code;
      throw rpcError;
    }
    return payload.result;
  };

  const hash = ethers.keccak256(rawTransaction);
  try {
    return await request('eth_sendRawTransaction', [rawTransaction]);
  } catch (err) {
    if (/already known|already in.*pool|nonce too low/i.test(err.message)) {
      const receipt = await request('eth_getTransactionReceipt', [hash]);
      if (receipt) return hash;
    }
    throw err;
  }
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
    createCheckoutSession,
    stripe,
    stripeWebhookSecret,
    billingLedger,
    provisionStorageCredit,
    prepareOnboarding,
    broadcastOnboardingTransaction,
    appUrl = 'https://mayorken.github.io/Echo/',
  } = config;

  const app = express();
  app.use(helmet());
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins }));
  }

  // Stripe signatures must be verified against the unparsed request body.
  // Register this route before the JSON body parser used by the rest of the API.
  app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !stripeWebhookSecret || !billingLedger || !provisionStorageCredit) {
      return res.status(503).json({ error: 'Stripe webhook is not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        stripeWebhookSecret,
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const echoAddress = intent.metadata && intent.metadata.echoAddress;
      const plan = intent.metadata && intent.metadata.plan;
      const creditCents = Number(intent.metadata && intent.metadata.creditCents);
      if (!ethers.isAddress(echoAddress || '') || !Number.isInteger(creditCents) || creditCents <= 0) {
        return res.json({ received: true });
      }

      const payment = billingLedger.begin({
        paymentIntentId: intent.id,
        userAddress: echoAddress,
        plan,
        creditCents,
      });
      if (payment.state === 'active' || payment.state === 'refunded') {
        return res.json({ received: true, state: payment.state });
      }

      try {
        if (payment.state === 'payment_received' || payment.state === 'retrying') {
          billingLedger.transition(intent.id, 'provisioning');
        }
        const receipt = await provisionStorageCredit({
          userAddress: echoAddress,
          creditCents,
          plan,
          paymentIntentId: intent.id,
        });
        billingLedger.transition(intent.id, 'active', { provisioningReceipt: receipt });
      } catch (err) {
        const latest = billingLedger.getPayment(intent.id);
        if (latest && latest.state === 'provisioning') {
          billingLedger.transition(intent.id, 'retrying', { error: err.message });
        }
        console.error(`Storage provisioning failed for ${intent.id}:`, err.message);
        return res.status(500).json({ received: false, error: 'Storage provisioning failed' });
      }
    }

    return res.json({ received: true });
  });

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));

  const client = new EchoClient(rpcUrl, contractAddress, signer, storage);
  const serviceWalletAddress = signer && signer.address ? signer.address : null;
  const connectorActivity = new Map();
  function recordConnector(userAddress, clientName, action) {
    const userKey = userAddress.toLowerCase();
    const current = connectorActivity.get(userKey) || {};
    const connectorKey = String(clientName || 'AI application').toLowerCase();
    const previous = current[connectorKey] || {};
    current[connectorKey] = {
      name: clientName || previous.name || 'AI application',
      connectedAt: previous.connectedAt || new Date().toISOString(),
      lastUsedAt: action === 'connected' ? previous.lastUsedAt || null : new Date().toISOString(),
      lastAction: action,
    };
    connectorActivity.set(userKey, current);
  }

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      contractAddress,
      serviceWalletAddress,
      network: process.env.SYNAPSE_CHAIN || 'calibration',
      billingEnabled: Boolean(createCheckoutSession),
      timestamp: new Date().toISOString(),
    });
  });

  app.use((req, res, next) => {
    const publicConnectorPath = req.path === '/mcp'
      || req.path === '/authorize'
      || req.path === '/token'
      || req.path === '/register'
      || req.path.startsWith('/.well-known/');
    if (req.path.startsWith('/v1/') || publicConnectorPath) return next();
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
    let onboardingStage = 'validate_request';
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
      onboardingStage = 'check_read_access';
      const readGranted = await client.contract.hasAccess(userAddress, serviceWalletAddress);
      onboardingStage = 'check_write_access';
      const writeGranted = await client.contract.hasWriteAccess(userAddress, serviceWalletAddress);
      let onboardingTransactions = [];
      if ((!readGranted || !writeGranted) && prepareOnboarding) {
        onboardingStage = 'fund_user_wallet';
        await prepareOnboarding(userAddress);
        if (!readGranted) {
          onboardingTransactions.push({
            label: 'Enable secure access',
            to: contractAddress,
            data: client.contract.interface.encodeFunctionData('grantAccess', [serviceWalletAddress]),
          });
        }
        if (!writeGranted) {
          onboardingTransactions.push({
            label: 'Enable secure updates',
            to: contractAddress,
            data: client.contract.interface.encodeFunctionData('grantWriteAccess', [serviceWalletAddress]),
          });
        }
      } else if (!readGranted) {
        return res.status(403).json({
          error: `Address ${userAddress} has not granted this service (${serviceWalletAddress}) access yet. Call grantAccess() first.`,
        });
      }
      onboardingStage = 'issue_api_key';
      const apiKey = generateApiKey(userAddress);
      res.json({
        apiKey,
        userAddress,
        onboardingRequired: onboardingTransactions.length > 0,
        onboardingTransactions,
      });
    } catch (err) {
      console.error(`POST /v1/auth/signup error at ${onboardingStage}:`, err.message);
      res.status(500).json({
        error: 'Internal server error',
        code: 'ONBOARDING_FAILED',
        stage: onboardingStage,
        providerCode: typeof err.code === 'string' ? err.code : 'UNKNOWN',
      });
    }
  });

  /**
   * POST /v1/auth/broadcast
   * Broadcast a user-signed onboarding permission transaction. The browser's
   * embedded wallet remains the only signer; the API is only a reliable RPC
   * transport for Filecoin nodes that reject browser-originated submissions.
   */
  app.post('/v1/auth/broadcast', async (req, res) => {
    try {
      if (!broadcastOnboardingTransaction || !serviceWalletAddress) {
        return res.status(503).json({ error: 'Onboarding broadcaster is not configured' });
      }
      const { rawTransaction } = req.body;
      if (typeof rawTransaction !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawTransaction)) {
        return res.status(400).json({ error: 'Valid rawTransaction is required' });
      }

      let transaction;
      let call;
      try {
        transaction = ethers.Transaction.from(rawTransaction);
        call = client.contract.interface.parseTransaction({
          data: transaction.data,
          value: transaction.value,
        });
      } catch {
        return res.status(400).json({ error: 'Invalid signed onboarding transaction' });
      }
      const allowedMethod = call && (call.name === 'grantAccess' || call.name === 'grantWriteAccess');
      const correctContract = transaction.to
        && transaction.to.toLowerCase() === contractAddress.toLowerCase();
      const correctService = call && call.args[0]
        && String(call.args[0]).toLowerCase() === serviceWalletAddress.toLowerCase();
      if (!transaction.from || !allowedMethod || !correctContract || !correctService || transaction.value !== 0n) {
        return res.status(400).json({ error: 'Transaction is not an Echo onboarding permission' });
      }
      if (transaction.gasLimit <= 0n) {
        return res.status(400).json({ error: 'Onboarding transaction requires a positive gas limit' });
      }

      const response = await broadcastOnboardingTransaction(rawTransaction);
      res.json({ hash: typeof response === 'string' ? response : response.hash });
    } catch (err) {
      console.error('POST /v1/auth/broadcast error:', err.message);
      res.status(502).json({
        error: err.reason || err.info?.error?.message || err.error?.message || err.message
          || 'Filecoin network rejected the signed transaction',
      });
    }
  });

  async function requireApiKey(req, res, next) {
    const header = req.get('Authorization') || '';
    const credential = header.startsWith('Bearer ') ? header.slice(7) : null;
    const separator = credential ? credential.lastIndexOf('.') : -1;
    const apiKey = separator > 0 ? credential.slice(0, separator) : credential;
    const embeddedKey = separator > 0 ? credential.slice(separator + 1) : '';
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
    req.echoKey = /^[0-9a-fA-F]{64}$/.test(embeddedKey) ? embeddedKey : '';
    next();
  }

  const mcpAuth = createMcpAuth(encryptionKey);
  const mcpUrl = (req) => process.env.MCP_PUBLIC_URL || `${req.protocol}://${req.get('host')}/mcp`;
  const authBase = (req) => mcpUrl(req).replace(/\/mcp$/, '');

  function oauthMetadata(req) {
    const base = authBase(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['echo:context:read', 'echo:context:write'],
    };
  }

  app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(oauthMetadata(req)));
  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json({
    resource: mcpUrl(req),
    authorization_servers: [authBase(req)],
    scopes_supported: ['echo:context:read', 'echo:context:write'],
  }));
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json({
    resource: mcpUrl(req),
    authorization_servers: [authBase(req)],
    scopes_supported: ['echo:context:read', 'echo:context:write'],
  }));

  app.post('/register', (req, res) => {
    const redirectUris = req.body && req.body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0
      || redirectUris.some((uri) => !/^https:\/\//.test(uri) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(uri))) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }
    const clientId = mcpAuth.seal({
      type: 'client',
      redirectUris,
      clientName: req.body.client_name || 'AI application',
    }, 365 * 24 * 60 * 60 * 1000);
    return res.status(201).json({
      client_id: clientId,
      client_name: req.body.client_name || 'AI application',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  app.get('/authorize', (req, res) => {
    const clientRecord = mcpAuth.open(req.query.client_id, 'client');
    const redirectUri = req.query.redirect_uri;
    if (!clientRecord || !clientRecord.redirectUris.includes(redirectUri)) {
      return res.status(400).send('Invalid Echo connector client or redirect address.');
    }
    if (req.query.response_type !== 'code' || req.query.code_challenge_method !== 'S256'
      || !req.query.code_challenge) {
      return res.status(400).send('This connector must use authorization code and PKCE S256.');
    }
    const requestToken = mcpAuth.seal({
      type: 'approval',
      clientId: req.query.client_id,
      clientName: clientRecord.clientName,
      redirectUri,
      state: req.query.state || '',
      scope: req.query.scope || 'echo:context:read echo:context:write',
      // Some MCP clients send the authorization-server origin as the resource
      // even when protected-resource discovery advertises the full /mcp URL.
      // Always issue the token for Echo's canonical MCP endpoint so the
      // subsequent initialize/tools-list exchange has a stable audience.
      resource: mcpUrl(req),
      codeChallenge: req.query.code_challenge,
    }, 10 * 60 * 1000);
    const destination = new URL(appUrl);
    destination.searchParams.set('oauth_request', requestToken);
    return res.redirect(destination.toString());
  });

  app.post('/v1/oauth/approve', requireApiKey, (req, res) => {
    const approval = mcpAuth.open(req.body && req.body.request, 'approval');
    const recoveryKey = req.body && req.body.recoveryKey;
    if (!approval || !/^[0-9a-fA-F]{64}$/.test(recoveryKey || '')) {
      return res.status(400).json({ error: 'Invalid or expired connector approval' });
    }
    const code = mcpAuth.seal({
      type: 'code',
      userAddress: req.userAddress,
      recoveryKey,
      clientName: approval.clientName,
      clientId: approval.clientId,
      redirectUri: approval.redirectUri,
      resource: approval.resource,
      scope: approval.scope,
      codeChallenge: approval.codeChallenge,
    }, 5 * 60 * 1000);
    recordConnector(req.userAddress, approval.clientName, 'connected');
    const callback = new URL(approval.redirectUri);
    callback.searchParams.set('code', code);
    if (approval.state) callback.searchParams.set('state', approval.state);
    return res.json({ redirectTo: callback.toString() });
  });

  app.post('/token', (req, res) => {
    const code = mcpAuth.open(req.body && req.body.code, 'code');
    if (!code || req.body.grant_type !== 'authorization_code'
      || req.body.client_id !== code.clientId || req.body.redirect_uri !== code.redirectUri
      || !verifyPkce(req.body.code_verifier, code.codeChallenge)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const accessToken = mcpAuth.seal({
      type: 'access',
      userAddress: code.userAddress,
      recoveryKey: code.recoveryKey,
      clientName: code.clientName,
      resource: code.resource,
      scope: code.scope,
    }, 7 * 24 * 60 * 60 * 1000);
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 7 * 24 * 60 * 60,
      scope: code.scope,
    });
  });

  app.all('/mcp', async (req, res) => {
    const origin = req.get('Origin');
    if (origin && !/^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com)$/.test(origin)
      && !corsOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Untrusted MCP origin' });
    }
    const header = req.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const access = mcpAuth.open(token, 'access');
    if (!access || access.resource !== mcpUrl(req)) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${authBase(req)}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'MCP authorization required' });
    }
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const stillGranted = await client.contract.hasAccess(access.userAddress, serviceWalletAddress);
      if (!stillGranted) return res.status(403).json({ error: 'Echo access has been revoked' });
      return await handleRemoteMcp(req, res, {
        client,
        userAddress: access.userAddress,
        recoveryKey: access.recoveryKey,
        onActivity: (action) => recordConnector(access.userAddress, access.clientName, action),
      });
    } catch (err) {
      console.error('Remote MCP error:', err.message);
      if (!res.headersSent) return res.status(500).json({
        jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Echo connector failed' },
      });
      return undefined;
    }
  });

  /**
   * GET /v1/context
   * Load and decrypt the signed-in user's context.
   * Header: X-Echo-Key: <64-char hex decryption key>
   */
  app.get('/v1/context', requireApiKey, async (req, res) => {
    try {
      const decryptionKey = parseHexKey(req.get('X-Echo-Key') || req.echoKey, 'X-Echo-Key');
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
      const encKey = parseHexKey(req.get('X-Echo-Key') || req.echoKey, 'X-Echo-Key');
      const result = await client.saveMemoryFor(req.userAddress, context, encKey);
      res.json({ success: true, cid: result.cid, integrityHash: result.integrityHash });
    } catch (err) {
      console.error('POST /v1/context error:', err.message);
      const status = /X-Echo-Key header/.test(err.message) ? 400 : 500;
      res.status(status).json({ error: status === 400 ? err.message : 'Internal server error' });
    }
  });

  /** GET /v1/access — list the authenticated user's current grants. */
  app.get('/v1/access', requireApiKey, async (req, res) => {
    try {
      const apps = await client.listAccess(req.userAddress);
      res.json({ apps });
    } catch (err) {
      console.error('GET /v1/access error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/v1/connectors/status', requireApiKey, (req, res) => {
    const connectors = Object.values(connectorActivity.get(req.userAddress.toLowerCase()) || {})
      .sort((a, b) => Date.parse(b.lastUsedAt || b.connectedAt) - Date.parse(a.lastUsedAt || a.connectedAt));
    res.json({ connectors });
  });

  /** Create a Stripe Checkout session for a USD-denominated storage plan. */
  app.post('/v1/billing/checkout', requireApiKey, async (req, res) => {
    try {
      if (!createCheckoutSession) {
        return res.status(503).json({ error: 'Billing is not configured' });
      }
      const plan = req.body && req.body.plan;
      if (!['starter', 'plus', 'team'].includes(plan)) {
        return res.status(400).json({ error: 'Unknown storage plan' });
      }
      const session = await createCheckoutSession({ plan, userAddress: req.userAddress });
      res.json({ checkoutUrl: session.url });
    } catch (err) {
      console.error('POST /v1/billing/checkout error:', err.message);
      res.status(500).json({ error: 'Unable to start checkout' });
    }
  });

  /** Return the signed-in user's USD storage-credit and provisioning status. */
  app.get('/v1/billing/status', requireApiKey, (req, res) => {
    if (!billingLedger) {
      return res.status(503).json({ error: 'Billing is not configured' });
    }
    res.json(billingLedger.getAccount(req.userAddress));
  });

  return app;
}

async function startServer() {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.PRIVATE_KEY;
  const synapsePrivateKey = process.env.SYNAPSE_PRIVATE_KEY;
  const encryptionKeyHex = (process.env.ENCRYPTION_KEY || '')
    .trim()
    .replace(/^ENCRYPTION_KEY\s*=\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/^0x/i, '');
  const operatorApiKey = process.env.OPERATOR_API_KEY;
  const defaultCorsOrigins = [
    'https://mayorken.github.io',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
  ];
  const corsOrigins = (process.env.CORS_ORIGINS || defaultCorsOrigins.join(','))
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const appUrl = process.env.APP_URL || 'https://mayorken.github.io/Echo/';
  const storageTreasuryReady = process.env.STORAGE_TREASURY_READY === 'true';
  const walletBootstrapEnabled = process.env.ENABLE_WALLET_BOOTSTRAP === 'true';
  const onboardingGasFil = process.env.ONBOARDING_GAS_FIL || '0.02';
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

  let createCheckoutSession;
  let stripe;
  let provisionStorageCredit;
  let prepareOnboarding;
  const billingLedger = new BillingLedger();
  if (walletBootstrapEnabled) {
    if ((process.env.SYNAPSE_CHAIN || 'calibration') !== 'calibration') {
      throw new Error('ENABLE_WALLET_BOOTSTRAP is restricted to calibration until production abuse controls are configured');
    }
    const targetBalance = ethers.parseEther(onboardingGasFil);
    prepareOnboarding = async (userAddress) => {
      const balance = await provider.getBalance(userAddress);
      if (balance >= targetBalance) return;
      const transaction = await signer.sendTransaction({
        to: userAddress,
        value: targetBalance - balance,
      });
      await transaction.wait();
    };
  }
  if (stripeSecretKey && !storageTreasuryReady) {
    console.warn('Warning: Stripe billing is disabled until STORAGE_TREASURY_READY=true');
  }
  if (stripeSecretKey && storageTreasuryReady) {
    stripe = require('stripe')(stripeSecretKey);
    const plans = {
      starter: { name: 'Echo Starter Storage', cents: 500 },
      plus: { name: 'Echo Plus Storage', cents: 1500 },
      team: { name: 'Echo Team Storage', cents: 4000 },
    };
    createCheckoutSession = async ({ plan, userAddress }) => {
      const selected = plans[plan];
      const metadata = {
        echoAddress: userAddress,
        plan,
        creditCents: String(selected.cents),
        storageUsd: (selected.cents / 100).toFixed(2),
        settlementModel: 'managed-reserve',
      };
      return stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: selected.cents,
            product_data: { name: selected.name },
          },
        }],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${appUrl}/?payment=success`,
        cancel_url: `${appUrl}/?payment=cancelled`,
      });
    };

    // The platform treasury is pre-funded with USDFC for storage and FIL for
    // gas. A successful provisioning reserves USD-denominated Echo credit;
    // it does not claim that the customer's card purchase bought FIL.
    provisionStorageCredit = async ({ paymentIntentId }) => `managed-reserve:${paymentIntentId}`;
  }

  const app = createApp({
    rpcUrl,
    contractAddress,
    signer,
    storage,
    encryptionKey,
    operatorApiKey,
    corsOrigins,
    createCheckoutSession,
    stripe,
    stripeWebhookSecret,
    billingLedger,
    provisionStorageCredit,
    prepareOnboarding,
    broadcastOnboardingTransaction: (rawTransaction) => broadcastRawTransaction(rpcUrl, rawTransaction),
    appUrl,
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

module.exports = { createApp, broadcastRawTransaction };
