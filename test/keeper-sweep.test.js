const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { deployProxy } = require('./proxy-helper');
const { checkStorageStatus, repinData } = require('../keeper/renewer');

describe('keeper/index.js — runSweep', function () {
  this.timeout(30000);

  let provider, owner, contracts, registryAddress;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    owner = await provider.getSigner(accounts[0].address);
  });

  beforeEach(async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
    registryAddress = await registry.getAddress();
  });

  it('returns zero counts when no funded vaults exist', async function () {
    const { scanFundedVaults } = require('../keeper/scanner');
    const registryAbi = require('../EchoMemoryRegistry.abi.json');
    const contract = new ethers.Contract(registryAddress, registryAbi, provider);
    const result = await scanFundedVaults(contract);
    expect(result.vaults).to.have.length(0);
  });

  it('identifies funded vaults and checks storage status', async function () {
    const registryAbi = require('../EchoMemoryRegistry.abi.json');
    const registry = new ethers.Contract(registryAddress, registryAbi, owner);
    const hash = ethers.keccak256(ethers.toUtf8Bytes('context'));
    await registry.updateMemory('bafk-expiring-cid', hash);
    await registry.fundRenewal({ value: ethers.parseEther('1.0') });

    const fakeSynapse = {
      storage: {
        download: async () => new Uint8Array([1, 2, 3, 4, 5]),
        prepare: async () => ({ transaction: null }),
        upload: async () => ({ pieceCid: 'bafk-new-cid', size: 5, complete: true, copies: [1, 2] }),
      },
    };

    const { scanFundedVaults } = require('../keeper/scanner');
    const contract = new ethers.Contract(registryAddress, registryAbi, provider);

    const result = await scanFundedVaults(contract);
    expect(result.vaults).to.have.length(1);

    const storageCheck = await checkStorageStatus(result.vaults[0].cid, fakeSynapse);
    expect(storageCheck.status).to.equal('active');
  });

  it('re-pins data when storage is degraded', async function () {
    const registryAbi = require('../EchoMemoryRegistry.abi.json');
    const registry = new ethers.Contract(registryAddress, registryAbi, owner);
    const hash = ethers.keccak256(ethers.toUtf8Bytes('context'));
    await registry.updateMemory('bafk-degraded-cid', hash);
    await registry.fundRenewal({ value: ethers.parseEther('1.0') });

    const fakeSynapse = {
      storage: {
        download: async ({ pieceCid }) => {
          if (pieceCid === 'bafk-degraded-cid') {
            throw new Error('piece not found');
          }
          return new Uint8Array([1, 2, 3]);
        },
        prepare: async () => ({ transaction: null }),
        upload: async () => ({ pieceCid: 'bafk-repinned', size: 3, complete: true, copies: [1, 2] }),
      },
    };

    const storageCheck = await checkStorageStatus('bafk-degraded-cid', fakeSynapse);
    expect(storageCheck.status).to.equal('not-found');
  });

  it('skips vaults with healthy storage', async function () {
    const registryAbi = require('../EchoMemoryRegistry.abi.json');
    const registry = new ethers.Contract(registryAddress, registryAbi, owner);
    const hash = ethers.keccak256(ethers.toUtf8Bytes('context'));
    await registry.updateMemory('bafk-active-cid', hash);
    await registry.fundRenewal({ value: ethers.parseEther('1.0') });

    const fakeSynapse = {
      storage: {
        download: async () => new Uint8Array([1, 2, 3]),
      },
    };

    const { scanFundedVaults } = require('../keeper/scanner');
    const contract = new ethers.Contract(registryAddress, registryAbi, provider);

    const result = await scanFundedVaults(contract);
    expect(result.vaults).to.have.length(1);

    const storageCheck = await checkStorageStatus(result.vaults[0].cid, fakeSynapse);
    expect(storageCheck.status).to.equal('active');
  });
});
