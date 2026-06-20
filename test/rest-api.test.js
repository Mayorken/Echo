const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { deployProxy } = require('./proxy-helper');
const { createApp } = require('../integrations/rest-api');
const { generateKey } = require('../lib/crypto');

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

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
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

describe('integrations/rest-api.js', function () {
  this.timeout(30000);

  let contracts, provider, owner, stranger, app, encryptionKey;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    owner = await provider.getSigner(accounts[0].address);
    stranger = await provider.getSigner(accounts[1].address);
    encryptionKey = await generateKey();
  });

  beforeEach(async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
    const contractAddress = await registry.getAddress();
    const storage = makeFakeStorage();
    app = createApp({
      rpcUrl: 'not-used',
      contractAddress,
      signer: owner,
      storage,
      encryptionKey,
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
});
