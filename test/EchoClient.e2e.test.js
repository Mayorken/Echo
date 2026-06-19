const { expect } = require('chai');
const { ethers } = require('ethers');
const { compileAll, deployContract, makeFakeStorage, createGanacheServer, closeServerWithTimeout } = require('./test-helpers');
const { EchoClient, generateEncryptionKey } = require('../echo-sdk');

describe('EchoClient (end-to-end: real encryption + real contract + fake storage)', function () {
  this.timeout(30000);

  let contracts;
  let port = 8600;

  before(function () {
    contracts = compileAll();
  });

  /**
   * Spins up a dedicated ganache HTTP server + fresh contract deployment for
   * a single test, and returns everything needed plus a teardown function.
   * Each test gets its own server/port so background provider activity from
   * one test can never leak into the next.
   */
  async function setupTestEnv() {
    const thisPort = port++;
    const { server, rpcUrl, provider: setupProvider, keys } = await createGanacheServer(thisPort);
    const [ownerKey, appAKey, strangerKey] = keys;

    const ownerWallet = new ethers.Wallet(ownerKey, setupProvider);
    const appAWallet = new ethers.Wallet(appAKey, setupProvider);
    const strangerWallet = new ethers.Wallet(strangerKey, setupProvider);

    const deployed = await deployContract(contracts.EchoMemoryRegistry, ownerWallet);
    const registryAddress = await deployed.getAddress();

    const teardown = async () => {
      setupProvider.destroy();
      await closeServerWithTimeout(server);
    };

    return { rpcUrl, registryAddress, ownerWallet, appAWallet, strangerWallet, teardown };
  }

  it('writes memory, grants an app access, and that app can load + decrypt it', async function () {
    const { rpcUrl, registryAddress, ownerWallet, appAWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const key = await generateEncryptionKey();

      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      const memory = { facts: ['Chem exam: Friday', 'Hates cilantro'], lastTopic: 'finals stress' };
      await ownerClient.saveMemory(memory, key);
      await ownerClient.grantAccess(appAWallet.address);

      const appClient = new EchoClient(rpcUrl, registryAddress, appAWallet, storage);
      const loaded = await appClient.loadMemory(ownerWallet.address, key);

      expect(loaded).to.deep.equal(memory);
    } finally {
      await teardown();
    }
  });

  it('blocks a non-granted app from loading memory at all (fails before decryption is even relevant)', async function () {
    const { rpcUrl, registryAddress, ownerWallet, strangerWallet, teardown } = await setupTestEnv();
    try {
      const storage = makeFakeStorage();
      const key = await generateEncryptionKey();
      const ownerClient = new EchoClient(rpcUrl, registryAddress, ownerWallet, storage);
      await ownerClient.saveMemory({ fact: 'should stay private' }, key);

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
      await ownerClient.saveMemory({ fact: 'only readable with the right key' }, rightKey);
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
      await ownerClient.saveMemory({ fact: 'temporary access' }, key);
      await ownerClient.grantAccess(appAWallet.address);

      const appClient = new EchoClient(rpcUrl, registryAddress, appAWallet, storage);
      const firstLoad = await appClient.loadMemory(ownerWallet.address, key);
      expect(firstLoad.fact).to.equal('temporary access');

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
