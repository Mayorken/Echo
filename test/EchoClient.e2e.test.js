const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { EchoClient, generateEncryptionKey } = require('../echo-sdk');
const { deployProxy } = require('./proxy-helper');

/**
 * A minimal in-memory stand-in for a real Filecoin storage adapter (Synapse
 * SDK). Implements the same put(bytes)->cid and
 * get(cid)->bytes contract the real EchoClient expects, so this test
 * exercises the actual save/load code path end-to-end without needing
 * network access to a live storage gateway.
 */
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

describe('EchoClient (end-to-end: real encryption + real contract + fake storage)', function () {
  this.timeout(30000);

  let contracts;
  let port = 8600;

  before(function () {
    contracts = compileAll();
  });

  function closeServerWithTimeout(server, ms = 2000) {
    return Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ]);
  }

  /**
   * Spins up a dedicated ganache HTTP server + fresh contract deployment for
   * a single test, and returns everything needed plus a teardown function.
   * Each test gets its own server/port so background provider activity from
   * one test can never leak into the next.
   */
  async function setupTestEnv() {
    const thisPort = port++;
    const server = ganache.server({ logging: { quiet: true } });
    await new Promise((resolve, reject) => {
      server.listen(thisPort, (err) => (err ? reject(err) : resolve()));
    });
    const rpcUrl = `http://127.0.0.1:${thisPort}`;

    const setupProvider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    const privateKeys = server.provider.getInitialAccounts();
    const [ownerKey, appAKey, strangerKey] = Object.values(privateKeys).map((a) => a.secretKey);

    const ownerWallet = new ethers.Wallet(ownerKey, setupProvider);
    const appAWallet = new ethers.Wallet(appAKey, setupProvider);
    const strangerWallet = new ethers.Wallet(strangerKey, setupProvider);

    const deployed = await deployProxy(contracts.EchoMemoryRegistry, ownerWallet);
    const registryAddress = await deployed.getAddress();

    const teardown = async () => {
      setupProvider.destroy();
      await closeServerWithTimeout(server);
    };

    return { rpcUrl, registryAddress, ownerWallet, appAWallet, strangerWallet, teardown };
  }

  it('writes context, grants an AI tool access, and that tool can load + decrypt it', async function () {
    const { rpcUrl, registryAddress, ownerWallet, appAWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const key = await generateEncryptionKey();

      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      const context = { stack: ['Go 1.22', 'PostgreSQL', 'Docker'], archDecision: 'AES-256-GCM for doc encryption', currentTask: 'listing endpoint' };
      await ownerClient.saveMemory(context, key);
      await ownerClient.grantAccess(appAWallet.address);

      const appClient = new EchoClient(rpcUrl, registryAddress, appAWallet, storage);
      const loaded = await appClient.loadMemory(ownerWallet.address, key);

      expect(loaded).to.deep.equal(context);
    } finally {
      await teardown();
    }
  });

  it('blocks a non-granted AI tool from loading context (fails before decryption is even relevant)', async function () {
    const { rpcUrl, registryAddress, ownerWallet, strangerWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const key = await generateEncryptionKey();
      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      await ownerClient.saveMemory({ archDecision: 'should stay private to authorized tools' }, key);

      const strangerClient = new EchoClient(rpcUrl, registryAddress, strangerWallet, storage);
      let threw = false;
      try {
        await strangerClient.loadMemory(ownerWallet.address, key);
      } catch (err) {
        threw = true;
      }
      expect(threw).to.equal(true);
    } finally {
      await teardown();
    }
  });

  it('rejects a load with the wrong decryption key even if contract access was granted', async function () {
    const { rpcUrl, registryAddress, ownerWallet, appAWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const rightKey = await generateEncryptionKey();
      const wrongKey = await generateEncryptionKey();

      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      await ownerClient.saveMemory({ preference: 'only readable with the right key' }, rightKey);
      await ownerClient.grantAccess(appAWallet.address);

      const appClient = new EchoClient(rpcUrl, registryAddress, appAWallet, storage);
      let threw = false;
      try {
        await appClient.loadMemory(ownerWallet.address, wrongKey);
      } catch (err) {
        threw = true;
      }
      expect(threw).to.equal(true);
    } finally {
      await teardown();
    }
  });

  it('revoking access blocks future loads even though the encrypted blob still exists in storage', async function () {
    const { rpcUrl, registryAddress, ownerWallet, appAWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const key = await generateEncryptionKey();
      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      await ownerClient.saveMemory({ preference: 'temporary access to project context' }, key);
      await ownerClient.grantAccess(appAWallet.address);

      const appClient = new EchoClient(rpcUrl, registryAddress, appAWallet, storage);
      const firstLoad = await appClient.loadMemory(ownerWallet.address, key);
      expect(firstLoad.preference).to.equal('temporary access to project context');

      await ownerClient.revokeAccess(appAWallet.address);

      let threw = false;
      try {
        await appClient.loadMemory(ownerWallet.address, key);
      } catch (err) {
        threw = true;
      }
      expect(threw).to.equal(true);
    } finally {
      await teardown();
    }
  });

  it('funds and reports a renewal balance through the client SDK', async function () {
    const { rpcUrl, registryAddress, ownerWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      await ownerClient.fundRenewal('0.5');
      const balance = await ownerClient.contract.renewalBalanceOf(ownerWallet.address);
      expect(balance).to.equal(ethers.parseEther('0.5'));
    } finally {
      await teardown();
    }
  });
});
