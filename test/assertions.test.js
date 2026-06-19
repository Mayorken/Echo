const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { expectRevertedWithCustomError, expectEmit } = require('./assertions');

describe('test/assertions.js helper tests', function () {
  this.timeout(30000);

  let provider, registry, owner, stranger, contracts;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    [owner, stranger] = await Promise.all(
      accounts.slice(0, 2).map((a) => provider.getSigner(a.address))
    );
  });

  beforeEach(async function () {
    const factory = new ethers.ContractFactory(
      contracts.EchoMemoryRegistry.abi,
      contracts.EchoMemoryRegistry.bytecode,
      owner
    );
    registry = await factory.deploy();
    await registry.waitForDeployment();
  });

  describe('expectRevertedWithCustomError', function () {
    it('passes when the call reverts with the expected custom error', async function () {
      await registry.connect(owner).updateMemory('cid', ethers.keccak256(ethers.toUtf8Bytes('x')));
      await expectRevertedWithCustomError(
        () => registry.connect(stranger).getMemory(owner.address),
        registry,
        'NotAuthorized'
      );
    });

    it('fails (throws) when the call succeeds instead of reverting', async function () {
      await registry.connect(owner).updateMemory('cid', ethers.keccak256(ethers.toUtf8Bytes('x')));
      let threw = false;
      try {
        await expectRevertedWithCustomError(
          () => registry.connect(owner).getMemory(owner.address),
          registry,
          'NotAuthorized'
        );
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Expected the call to revert');
      }
      expect(threw).to.equal(true);
    });

    it('fails when the call reverts with a different custom error name', async function () {
      await registry.connect(owner).fundRenewal({ value: ethers.parseEther('0.5') });
      let threw = false;
      try {
        await expectRevertedWithCustomError(
          () => registry.connect(owner).withdrawRenewal(ethers.parseEther('5.0')),
          registry,
          'NotAuthorized'
        );
      } catch (err) {
        threw = true;
      }
      expect(threw, 'should fail when error name does not match').to.equal(true);
    });
  });

  describe('expectEmit', function () {
    it('passes when the expected event is emitted', async function () {
      const cid = 'testcid';
      const hash = ethers.keccak256(ethers.toUtf8Bytes('data'));
      const receipt = await expectEmit(
        () => registry.connect(owner).updateMemory(cid, hash),
        registry,
        'MemoryUpdated'
      );
      expect(receipt).to.have.property('logs');
    });

    it('validates event args when provided', async function () {
      const receipt = await expectEmit(
        () => registry.connect(owner).grantAccess(stranger.address),
        registry,
        'AccessGranted',
        [owner.address, stranger.address]
      );
      expect(receipt).to.have.property('logs');
    });

    it('fails when the expected event is not emitted', async function () {
      let threw = false;
      try {
        await expectEmit(
          () => registry.connect(owner).grantAccess(stranger.address),
          registry,
          'MemoryUpdated'
        );
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Expected MemoryUpdated to be emitted');
      }
      expect(threw, 'should throw when event not found').to.equal(true);
    });

    it('fails when event args do not match', async function () {
      let threw = false;
      try {
        await expectEmit(
          () => registry.connect(owner).grantAccess(stranger.address),
          registry,
          'AccessGranted',
          [stranger.address, owner.address] // reversed — wrong
        );
      } catch (err) {
        threw = true;
      }
      expect(threw, 'should throw when args mismatch').to.equal(true);
    });
  });
});
