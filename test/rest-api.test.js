const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { deployProxy } = require('./proxy-helper');
const { createApp, broadcastRawTransaction } = require('../integrations/rest-api');
const { generateKey } = require('../lib/crypto');
const { BillingLedger } = require('../lib/billingLedger');

function makeFakeStorage() {
  const blobs = new Map();
  let counter = 0;
  return {
    async put(bytes) {
      const cid = `fakecid${counter++}`;
      blobs.set(cid, bytes);
      return cid;
    },
    async get(cid) {
      if (!blobs.has(cid)) throw new Error('not found: ' + cid);
      return blobs.get(cid);
    },
  };
}

function request(app, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method: method.toUpperCase(),
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          headers === false ? {} : { 'X-Echo-Operator-Key': 'test-operator-secret' },
          headers || {}
        ),
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('broadcastRawTransaction', function () {
  it('returns the Filecoin RPC transaction hash directly', async function () {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x${'ab'.repeat(32)}` }),
    });
    expect(await broadcastRawTransaction('https://rpc.test', '0x1234', fetchImpl))
      .to.equal(`0x${'ab'.repeat(32)}`);
  });

  it('preserves the real Filecoin RPC error message', async function () {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ error: { code: -32000, message: 'insufficient funds for gas' } }),
    });
    try {
      await broadcastRawTransaction('https://rpc.test', '0x1234', fetchImpl);
      expect.fail('expected the RPC request to fail');
    } catch (err) {
      expect(err.message).to.equal('insufficient funds for gas');
    }
  });

  it('treats an already-mined transaction as a successful retry', async function () {
    let calls = 0;
    const fetchImpl = async () => ({
      ok: true,
      json: async () => (++calls === 1
        ? { error: { code: -32000, message: 'nonce too low' } }
        : { result: { status: '0x1' } }),
    });
    expect(await broadcastRawTransaction('https://rpc.test', '0x1234', fetchImpl))
      .to.equal(ethers.keccak256('0x1234'));
  });
});

async function signedSignup(app, signer) {
  const challenge = await request(app, 'POST', '/v1/auth/challenge', {
    userAddress: signer.address,
  });
  const signature = await signer.signMessage(challenge.body.message);
  return request(app, 'POST', '/v1/auth/signup', {
    userAddress: signer.address,
    signature,
  });
}

describe('integrations/rest-api.js', function () {
  this.timeout(30000);

  let contracts, provider, owner, stranger, ownerAuth, strangerAuth, app, encryptionKey, registry, billingLedger;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    const initialAccounts = Object.values(ganacheProvider.getInitialAccounts());
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    owner = await provider.getSigner(accounts[0].address);
    stranger = await provider.getSigner(accounts[1].address);
    ownerAuth = new ethers.Wallet(initialAccounts[0].secretKey);
    strangerAuth = new ethers.Wallet(initialAccounts[1].secretKey);
    encryptionKey = await generateKey();
  });

  beforeEach(async function () {
    registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
    const contractAddress = await registry.getAddress();
    const storage = makeFakeStorage();
    billingLedger = new BillingLedger();
    app = createApp({
      rpcUrl: 'not-used',
      contractAddress,
      signer: owner,
      storage,
      encryptionKey,
      operatorApiKey: 'test-operator-secret',
      createCheckoutSession: async ({ plan, userAddress }) => ({
        url: `https://checkout.stripe.test/${plan}/${userAddress}`,
      }),
      billingLedger,
      broadcastOnboardingTransaction: (rawTransaction) => provider.broadcastTransaction(rawTransaction),
    });
  });

  describe('GET /health', function () {
    it('returns ok status', async function () {
      const res = await request(app, 'GET', '/health');
      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal('ok');
      expect(res.body).to.have.property('contractAddress');
      expect(res.body).to.have.property('timestamp');
    });
  });

  describe('POST /context/save', function () {
    it('rejects requests without the operator key', async function () {
      const res = await request(app, 'POST', '/context/save', { context: {} }, false);
      expect(res.status).to.equal(401);
    });

    it('saves context and returns cid + integrityHash', async function () {
      const res = await request(app, 'POST', '/context/save', {
        context: { project: 'Echo', stack: 'Solidity + Node.js' },
      });
      expect(res.status).to.equal(200);
      expect(res.body.success).to.equal(true);
      expect(res.body).to.have.property('cid');
      expect(res.body).to.have.property('integrityHash');
    });

    it('rejects missing context', async function () {
      const res = await request(app, 'POST', '/context/save', {});
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('context');
    });

    it('rejects non-object context', async function () {
      const res = await request(app, 'POST', '/context/save', { context: 'string' });
      expect(res.status).to.equal(400);
    });
  });

  describe('GET /context/load/:userAddress', function () {
    it('returns null when no context exists', async function () {
      const res = await request(app, 'GET', `/context/load/${owner.address}`);
      expect(res.status).to.equal(200);
      expect(res.body.context).to.equal(null);
    });

    it('loads saved context', async function () {
      const context = { project: 'Echo', decisions: ['UUPS proxy', 'AES-256-GCM'] };
      await request(app, 'POST', '/context/save', { context });
      const res = await request(app, 'GET', `/context/load/${owner.address}`);
      expect(res.status).to.equal(200);
      expect(res.body.context).to.deep.equal(context);
    });

    it('rejects invalid address', async function () {
      const res = await request(app, 'GET', '/context/load/not-an-address');
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('address');
    });
  });

  describe('POST /access/grant + /access/revoke', function () {
    it('grants and then revokes access', async function () {
      const grantRes = await request(app, 'POST', '/access/grant', {
        appAddress: stranger.address,
      });
      expect(grantRes.status).to.equal(200);
      expect(grantRes.body.success).to.equal(true);
      expect(grantRes.body.granted).to.equal(stranger.address);

      const revokeRes = await request(app, 'POST', '/access/revoke', {
        appAddress: stranger.address,
      });
      expect(revokeRes.status).to.equal(200);
      expect(revokeRes.body.success).to.equal(true);
      expect(revokeRes.body.revoked).to.equal(stranger.address);
    });

    it('rejects invalid appAddress', async function () {
      const res = await request(app, 'POST', '/access/grant', { appAddress: 'bad' });
      expect(res.status).to.equal(400);
    });
  });

  describe('GET /access/list/:userAddress', function () {
    it('returns empty list initially', async function () {
      const res = await request(app, 'GET', `/access/list/${owner.address}`);
      expect(res.status).to.equal(200);
      expect(res.body.apps).to.deep.equal([]);
    });

    it('lists granted apps', async function () {
      await request(app, 'POST', '/access/grant', { appAddress: stranger.address });
      const res = await request(app, 'GET', `/access/list/${owner.address}`);
      expect(res.status).to.equal(200);
      expect(res.body.apps).to.have.length(1);
      expect(res.body.apps[0].app).to.equal(stranger.address);
      expect(res.body.apps[0].active).to.equal(true);
    });
  });

  describe('POST /key/generate', function () {
    it('returns a hex-encoded 32-byte key', async function () {
      const res = await request(app, 'POST', '/key/generate');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('key');
      expect(res.body.key).to.match(/^[0-9a-f]{64}$/);
    });
  });

  describe('hosted multi-tenant routes (API key auth)', function () {
    // In these tests `owner` plays the hosted service's own wallet (it's the
    // signer the app was built with), and `stranger` plays an end user who
    // grants that service wallet access on-chain. encryptionKey is only set
    // once the outer before() hook runs, so keyHex is computed lazily inside
    // each beforeEach/it below rather than at describe-body eval time.

    describe('POST /v1/auth/signup', function () {
      it('rejects an address that has not granted read access', async function () {
        const res = await signedSignup(app, strangerAuth);
        expect(res.status).to.equal(403);
        expect(res.body.error).to.include('grantAccess');
      });

      it('issues an API key once read access is granted', async function () {
        await registry.connect(stranger).grantAccess(owner.address);
        const res = await signedSignup(app, strangerAuth);
        expect(res.status).to.equal(200);
        expect(res.body.apiKey).to.match(/^echo_[0-9a-f]{64}$/);
        expect(res.body.userAddress).to.equal(stranger.address);
      });

      it('rejects an invalid userAddress', async function () {
        const res = await request(app, 'POST', '/v1/auth/signup', { userAddress: 'not-an-address' });
        expect(res.status).to.equal(400);
      });

      it('rejects signup without proof of wallet ownership', async function () {
        await registry.connect(stranger).grantAccess(owner.address);
        const res = await request(app, 'POST', '/v1/auth/signup', {
          userAddress: stranger.address,
          signature: await ownerAuth.signMessage('not the issued challenge'),
        });
        expect(res.status).to.equal(401);
      });

      it('broadcasts only a user-signed Echo onboarding permission', async function () {
        const network = await provider.getNetwork();
        const feeData = await provider.getFeeData();
        const rawTransaction = await strangerAuth.signTransaction({
          chainId: network.chainId,
          nonce: await provider.getTransactionCount(stranger.address),
          gasLimit: 150000n,
          gasPrice: feeData.gasPrice,
          to: await registry.getAddress(),
          data: registry.interface.encodeFunctionData('grantAccess', [owner.address]),
          value: 0n,
        });
        const res = await request(app, 'POST', '/v1/auth/broadcast', { rawTransaction });
        expect(res.status).to.equal(200);
        expect(res.body.hash).to.match(/^0x[0-9a-f]{64}$/);
        await provider.waitForTransaction(res.body.hash);
        expect(await registry.hasAccess(stranger.address, owner.address)).to.equal(true);
      });

      it('rejects a signed transaction that is not an onboarding permission', async function () {
        const rawTransaction = await strangerAuth.signTransaction({
          chainId: (await provider.getNetwork()).chainId,
          nonce: await provider.getTransactionCount(stranger.address),
          gasLimit: 21000n,
          gasPrice: (await provider.getFeeData()).gasPrice,
          to: owner.address,
          value: 1n,
        });
        const res = await request(app, 'POST', '/v1/auth/broadcast', { rawTransaction });
        expect(res.status).to.equal(400);
      });
    });

    describe('GET /v1/context and POST /v1/context', function () {
      let apiKey, keyHex;

      beforeEach(async function () {
        keyHex = Buffer.from(encryptionKey).toString('hex');
        await registry.connect(stranger).grantAccess(owner.address);
        const signupRes = await signedSignup(app, strangerAuth);
        apiKey = signupRes.body.apiKey;
      });

      it('rejects requests with no API key', async function () {
        const res = await request(app, 'GET', '/v1/context');
        expect(res.status).to.equal(401);
      });

      it('rejects requests with a bogus API key', async function () {
        const res = await request(app, 'GET', '/v1/context', null, { Authorization: 'Bearer not-a-real-key' });
        expect(res.status).to.equal(401);
      });

      it('returns null context before anything has been saved', async function () {
        const res = await request(app, 'GET', '/v1/context', null, {
          Authorization: `Bearer ${apiKey}`,
          'X-Echo-Key': keyHex,
        });
        expect(res.status).to.equal(200);
        expect(res.body.context).to.equal(null);
      });

      it('lists access grants through the authenticated endpoint', async function () {
        const res = await request(app, 'GET', '/v1/access', null, {
          Authorization: `Bearer ${apiKey}`,
        });
        expect(res.status).to.equal(200);
        expect(res.body.apps).to.be.an('array');
        expect(res.body.apps.some((entry) => entry.app === owner.address && entry.active)).to.equal(true);
      });

      it('creates a USD Stripe checkout for a storage plan', async function () {
        const res = await request(app, 'POST', '/v1/billing/checkout', { plan: 'plus' }, {
          Authorization: `Bearer ${apiKey}`,
        });
        expect(res.status).to.equal(200);
        expect(res.body.checkoutUrl).to.include('checkout.stripe.test/plus');
      });

      it('returns the signed-in user storage-credit status', async function () {
        const res = await request(app, 'GET', '/v1/billing/status', null, {
          Authorization: `Bearer ${apiKey}`,
        });
        expect(res.status).to.equal(200);
        expect(res.body.creditCents).to.equal(0);
        expect(res.body.payments).to.deep.equal([]);
      });

      it('rejects saving without write access granted', async function () {
        const res = await request(app, 'POST', '/v1/context', { context: { hello: 'world' } }, {
          Authorization: `Bearer ${apiKey}`,
          'X-Echo-Key': keyHex,
        });
        expect(res.status).to.not.equal(200);
      });

      it('rejects a missing X-Echo-Key header', async function () {
        await registry.connect(stranger).grantWriteAccess(owner.address);
        const res = await request(app, 'POST', '/v1/context', { context: { hello: 'world' } }, {
          Authorization: `Bearer ${apiKey}`,
        });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.include('X-Echo-Key');
      });

      it('saves and loads context once write access is granted', async function () {
        await registry.connect(stranger).grantWriteAccess(owner.address);
        const saveRes = await request(app, 'POST', '/v1/context', { context: { hello: 'world' } }, {
          Authorization: `Bearer ${apiKey}`,
          'X-Echo-Key': keyHex,
        });
        expect(saveRes.status).to.equal(200);
        expect(saveRes.body.success).to.equal(true);

        const loadRes = await request(app, 'GET', '/v1/context', null, {
          Authorization: `Bearer ${apiKey}`,
          'X-Echo-Key': keyHex,
        });
        expect(loadRes.status).to.equal(200);
        expect(loadRes.body.context).to.deep.equal({ hello: 'world' });
      });
    });
  });
});
