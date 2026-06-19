const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { deployProxy } = require('./proxy-helper');
const { scanFundedVaults } = require('../keeper/scanner');

describe('keeper/scanner.js', function () {
  this.timeout(30000);

  let provider, owner, userA, userB, registry, contracts;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    [owner, userA, userB] = await Promise.all(
      accounts.slice(0, 3).map((a) => provider.getSigner(a.address))
    );
  });

  beforeEach(async function () {
    registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
  });

  it('returns empty array when no vaults exist', async function () {
    const vaults = await scanFundedVaults(registry);
    expect(vaults).to.deep.equal([]);
  });

  it('returns empty array when vaults have CIDs but no renewal balance', async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes('test'));
    await registry.connect(owner).updateMemory('QmTestCid', hash);
    const vaults = await scanFundedVaults(registry);
    expect(vaults).to.deep.equal([]);
  });

  it('returns empty array when vaults have renewal balance but no CID', async function () {
    await registry.connect(owner).fundRenewal({ value: ethers.parseEther('1.0') });
    const vaults = await scanFundedVaults(registry);
    expect(vaults).to.deep.equal([]);
  });

  it('finds vaults with both a CID and a renewal balance', async function () {
    const cid = 'QmFundedVaultCid';
    const hash = ethers.keccak256(ethers.toUtf8Bytes('data'));
    await registry.connect(owner).updateMemory(cid, hash);
    await registry.connect(owner).fundRenewal({ value: ethers.parseEther('2.0') });

    const vaults = await scanFundedVaults(registry);
    expect(vaults).to.have.length(1);
    expect(vaults[0].user).to.equal(owner.address);
    expect(vaults[0].cid).to.equal(cid);
    expect(vaults[0].integrityHash).to.equal(hash);
    expect(vaults[0].renewalBalance).to.equal(ethers.parseEther('2.0'));
  });

  it('returns the latest CID when a user updates memory multiple times', async function () {
    const hash1 = ethers.keccak256(ethers.toUtf8Bytes('v1'));
    const hash2 = ethers.keccak256(ethers.toUtf8Bytes('v2'));
    await registry.connect(owner).updateMemory('QmOldCid', hash1);
    await registry.connect(owner).updateMemory('QmNewCid', hash2);
    await registry.connect(owner).fundRenewal({ value: ethers.parseEther('1.0') });

    const vaults = await scanFundedVaults(registry);
    expect(vaults).to.have.length(1);
    expect(vaults[0].cid).to.equal('QmNewCid');
    expect(vaults[0].integrityHash).to.equal(hash2);
  });

  it('finds multiple funded vaults from different users', async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes('data'));
    await registry.connect(owner).updateMemory('QmCidA', hash);
    await registry.connect(owner).fundRenewal({ value: ethers.parseEther('1.0') });
    await registry.connect(userA).updateMemory('QmCidB', hash);
    await registry.connect(userA).fundRenewal({ value: ethers.parseEther('0.5') });

    const vaults = await scanFundedVaults(registry);
    expect(vaults).to.have.length(2);
    const addresses = vaults.map((v) => v.user);
    expect(addresses).to.include(owner.address);
    expect(addresses).to.include(userA.address);
  });
});
