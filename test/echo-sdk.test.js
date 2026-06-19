const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { EchoClient, generateEncryptionKey } = require('../echo-sdk');
const { deployProxy } = require('./proxy-helper');

function makeFakeStorage() {
  const blobs = new Map();
  let counter = 0;
  return {
    blobs,
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

describe('EchoClient unit tests', function () {
  this.timeout(30000);

  let contracts, port = 9600;

  before(function () {
    contracts = compileAll();
  });

  function closeServerWithTimeout(server, ms = 2000) {
    return Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
  }

  async function setupTestEnv() {
    const thisPort = port++;
    const server = ganache.server({ logging: { quiet: true } });
    await new Promise((resolve, reject) => {
      server.listen(thisPort, (err) => (err ? reject(err) : resolve()));
    });
    const rpcUrl = `http://127.0.0.1:${thisPort}`;

    const setupProvider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    const privateKeys = server.provider.getInitialAccounts();
    const keys = Object.values(privateKeys).map((a) => a.secretKey);
    const [ownerKey, appAKey, appBKey, strangerKey] = keys;

    const ownerWallet = new ethers.Wallet(ownerKey, setupProvider);
    const appAWallet = new ethers.Wallet(appAKey, setupProvider);
    const appBWallet = new ethers.Wallet(appBKey, setupProvider);
    const strangerWallet = new ethers.Wallet(strangerKey, setupProvider);

    const deployed = await deployProxy(contracts.EchoMemoryRegistry, ownerWallet);
    const registryAddress = await deployed.getAddress();

    const teardown = async () => {
      setupProvider.destroy();
      await closeServerWithTimeout(server);
    };

    return { rpcUrl, registryAddress, ownerWallet, appAWallet, appBWallet, strangerWallet, teardown };
  }

  describe('listAccess', function () {
    it('returns an empty array when no apps have been granted', async function () {
      const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        const list = await client.listAccess(ownerWallet.address);
        expect(list).to.be.an('array').that.is.empty;
      } finally {
        await teardown();
      }
    });

    it('lists granted apps with active status true', async function () {
      const { rpcUrl, registryAddress, ownerWallet, appAWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        await client.grantAccess(appAWallet.address);

        const list = await client.listAccess(ownerWallet.address);
        expect(list).to.have.length(1);
        expect(list[0].app).to.equal(appAWallet.address);
        expect(list[0].active).to.equal(true);
      } finally {
        await teardown();
      }
    });

    it('shows revoked apps with active status false', async function () {
      const { rpcUrl, registryAddress, ownerWallet, appAWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        await client.grantAccess(appAWallet.address);
        await client.revokeAccess(appAWallet.address);

        const list = await client.listAccess(ownerWallet.address);
        expect(list).to.have.length(1);
        expect(list[0].app).to.equal(appAWallet.address);
        expect(list[0].active).to.equal(false);
      } finally {
        await teardown();
      }
    });

    it('lists multiple apps with mixed active/revoked status', async function () {
      const { rpcUrl, registryAddress, ownerWallet, appAWallet, appBWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        await client.grantAccess(appAWallet.address);
        await client.grantAccess(appBWallet.address);
        await client.revokeAccess(appAWallet.address);

        const list = await client.listAccess(ownerWallet.address);
        expect(list).to.have.length(2);

        const appAEntry = list.find((e) => e.app === appAWallet.address);
        const appBEntry = list.find((e) => e.app === appBWallet.address);
        expect(appAEntry.active).to.equal(false);
        expect(appBEntry.active).to.equal(true);
      } finally {
        await teardown();
      }
    });
  });

  describe('loadMemory edge cases', function () {
    it('returns null when no memory has been saved yet', async function () {
      const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const key = await generateEncryptionKey();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        const result = await client.loadMemory(ownerWallet.address, key);
        expect(result).to.equal(null);
      } finally {
        await teardown();
      }
    });
  });

  describe('saveMemory', function () {
    it('returns the cid and integrityHash', async function () {
      const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const key = await generateEncryptionKey();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        const result = await client.saveMemory({ note: 'test' }, key);
        expect(result).to.have.property('cid').that.is.a('string');
        expect(result).to.have.property('integrityHash').that.is.a('string');
        expect(result.integrityHash).to.match(/^0x[0-9a-f]{64}$/);
      } finally {
        await teardown();
      }
    });

    it('stores encrypted data in the storage adapter', async function () {
      const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const key = await generateEncryptionKey();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
        const { cid } = await client.saveMemory({ note: 'encrypted' }, key);

        expect(storage.blobs.has(cid)).to.equal(true);
        const raw = storage.blobs.get(cid);
        // Encrypted data should not contain the plaintext
        const rawStr = Buffer.from(raw).toString('utf8');
        expect(rawStr).to.not.include('"encrypted"');
      } finally {
        await teardown();
      }
    });

    it('overwrites previous memory on a second save', async function () {
      const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const key = await generateEncryptionKey();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);

        await client.saveMemory({ version: 1 }, key);
        await client.saveMemory({ version: 2 }, key);

        const loaded = await client.loadMemory(ownerWallet.address, key);
        expect(loaded.version).to.equal(2);
      } finally {
        await teardown();
      }
    });
  });

  describe('integrity check', function () {
    it('fails loadMemory when storage returns corrupted data', async function () {
      const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
      try {
        const storage = makeFakeStorage();
        const key = await generateEncryptionKey();
        const client = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);

        const { cid } = await client.saveMemory({ important: 'data' }, key);

        // Corrupt the stored blob — replace with a valid encryption of different data
        const differentPlaintext = new Uint8Array(Buffer.from(JSON.stringify({ tampered: true })));
        const { encrypt } = require('../lib/crypto');
        const corruptedBlob = await encrypt(differentPlaintext, key);
        storage.blobs.set(cid, corruptedBlob);

        let threw = false;
        try {
          await client.loadMemory(ownerWallet.address, key);
        } catch (err) {
          threw = true;
          expect(err.message).to.include('integrity');
        }
        expect(threw, 'loadMemory should throw on integrity mismatch').to.equal(true);
      } finally {
        await teardown();
      }
    });
  });

  describe('generateEncryptionKey (re-exported)', function () {
    it('is callable from the SDK module', async function () {
      const key = await generateEncryptionKey();
      expect(key).to.be.an.instanceOf(Uint8Array);
      expect(key.length).to.equal(32);
    });
  });
});
