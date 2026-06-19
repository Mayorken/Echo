const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { deployProxy } = require('./proxy-helper');

describe('UUPS Upgrade (V1 → V2)', function () {
  this.timeout(30000);

  let provider, owner, stranger, contracts;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    [owner, stranger] = await Promise.all(
      accounts.slice(0, 2).map((a) => provider.getSigner(a.address))
    );
  });

  it('owner can upgrade V1 proxy to V2 and call version()', async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);

    const v2Factory = new ethers.ContractFactory(
      contracts.EchoMemoryRegistryV2.abi,
      contracts.EchoMemoryRegistryV2.bytecode,
      owner
    );
    const v2Impl = await v2Factory.deploy();
    await v2Impl.waitForDeployment();

    await registry.upgradeToAndCall(await v2Impl.getAddress(), '0x');

    const v2 = new ethers.Contract(
      await registry.getAddress(),
      contracts.EchoMemoryRegistryV2.abi,
      owner
    );
    expect(await v2.version()).to.equal(2n);
  });

  it('preserves all storage across upgrade (vaults, access, renewal)', async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
    const cid = 'bafybeig6xv5nj9q4z2p7h3m8w1kexamplecid';
    const hash = ethers.keccak256(ethers.toUtf8Bytes('test'));

    await registry.connect(owner).updateMemory(cid, hash);
    await registry.connect(owner).grantAccess(stranger.address);
    await registry.connect(owner).fundRenewal({ value: ethers.parseEther('1.0') });

    const v2Factory = new ethers.ContractFactory(
      contracts.EchoMemoryRegistryV2.abi,
      contracts.EchoMemoryRegistryV2.bytecode,
      owner
    );
    const v2Impl = await v2Factory.deploy();
    await v2Impl.waitForDeployment();
    await registry.upgradeToAndCall(await v2Impl.getAddress(), '0x');

    const v2 = new ethers.Contract(
      await registry.getAddress(),
      contracts.EchoMemoryRegistryV2.abi,
      owner
    );

    const [storedCid, storedHash] = await v2.connect(stranger).getMemory(owner.address);
    expect(storedCid).to.equal(cid);
    expect(storedHash).to.equal(hash);
    expect(await v2.hasAccess(owner.address, stranger.address)).to.equal(true);
    expect(await v2.renewalBalanceOf(owner.address)).to.equal(ethers.parseEther('1.0'));
    expect(await v2.version()).to.equal(2n);
  });

  it('non-owner cannot upgrade', async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);

    const v2Factory = new ethers.ContractFactory(
      contracts.EchoMemoryRegistryV2.abi,
      contracts.EchoMemoryRegistryV2.bytecode,
      stranger
    );
    const v2Impl = await v2Factory.deploy();
    await v2Impl.waitForDeployment();

    let threw = false;
    try {
      await registry.connect(stranger).upgradeToAndCall(await v2Impl.getAddress(), '0x');
    } catch (err) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('proxy address stays the same after upgrade', async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
    const proxyAddr = await registry.getAddress();

    const v2Factory = new ethers.ContractFactory(
      contracts.EchoMemoryRegistryV2.abi,
      contracts.EchoMemoryRegistryV2.bytecode,
      owner
    );
    const v2Impl = await v2Factory.deploy();
    await v2Impl.waitForDeployment();
    await registry.upgradeToAndCall(await v2Impl.getAddress(), '0x');

    const v2 = new ethers.Contract(
      proxyAddr,
      contracts.EchoMemoryRegistryV2.abi,
      owner
    );
    expect(await v2.getAddress()).to.equal(proxyAddr);
    expect(await v2.version()).to.equal(2n);
  });

  it('owner is preserved after upgrade', async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);

    const v2Factory = new ethers.ContractFactory(
      contracts.EchoMemoryRegistryV2.abi,
      contracts.EchoMemoryRegistryV2.bytecode,
      owner
    );
    const v2Impl = await v2Factory.deploy();
    await v2Impl.waitForDeployment();
    await registry.upgradeToAndCall(await v2Impl.getAddress(), '0x');

    const v2 = new ethers.Contract(
      await registry.getAddress(),
      contracts.EchoMemoryRegistryV2.abi,
      owner
    );
    expect(await v2.owner()).to.equal(owner.address);
  });
});
