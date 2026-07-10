const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { expectRevertedWithCustomError, expectEmit } = require('./assertions');
const { deployProxy } = require('./proxy-helper');

describe('EchoMemoryRegistry (running on a local in-process chain)', function () {
  this.timeout(30000);

  let provider, registry, owner, appA, appB, stranger, contracts;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    [owner, appA, appB, stranger] = await Promise.all(
      accounts.slice(0, 4).map((a) => provider.getSigner(a.address))
    );
  });

  beforeEach(async function () {
    registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
  });

  const cid = 'bafybeig6xv5nj9q4z2p7h3m8w1kexamplecid';
  const integrityHash = ethers.keccak256(ethers.toUtf8Bytes('hello memory'));

  describe('proxy setup', function () {
    it('sets the deployer as owner', async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it('cannot be initialized again', async function () {
      let threw = false;
      try {
        await registry.initialize(stranger.address);
      } catch (err) {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });

  describe('memory writes', function () {
    it('stores a memory pointer and emits MemoryUpdated', async function () {
      await expectEmit(
        () => registry.connect(owner).updateMemory(cid, integrityHash),
        registry,
        'MemoryUpdated'
      );
      const [storedCid, storedHash] = await registry.getMemory(owner.address);
      expect(storedCid).to.equal(cid);
      expect(storedHash).to.equal(integrityHash);
    });

    it('lets the owner read their own memory with no access grant needed', async function () {
      await registry.connect(owner).updateMemory(cid, integrityHash);
      const [storedCid] = await registry.connect(owner).getMemory(owner.address);
      expect(storedCid).to.equal(cid);
    });
  });

  describe('input validation', function () {
    it('rejects empty CID in updateMemory', async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(owner).updateMemory('', integrityHash),
        registry,
        'EmptyCid'
      );
    });

    it('rejects granting access to the zero address', async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(owner).grantAccess(ethers.ZeroAddress),
        registry,
        'NotAuthorized'
      );
    });

    it('rejects funding with zero value', async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(owner).fundRenewal({ value: 0 }),
        registry,
        'ZeroFundAmount'
      );
    });
  });

  describe('access control', function () {
    beforeEach(async function () {
      await registry.connect(owner).updateMemory(cid, integrityHash);
    });

    it('blocks an app with no granted access from reading memory', async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(appA).getMemory(owner.address),
        registry,
        'NotAuthorized'
      );
    });

    it('lets a granted app read memory, and emits AccessGranted', async function () {
      await expectEmit(
        () => registry.connect(owner).grantAccess(appA.address),
        registry,
        'AccessGranted',
        [owner.address, appA.address]
      );
      const [storedCid] = await registry.connect(appA).getMemory(owner.address);
      expect(storedCid).to.equal(cid);
      expect(await registry.hasAccess(owner.address, appA.address)).to.equal(true);
    });

    it("revokes access so the app can no longer read, and emits AccessRevoked", async function () {
      await registry.connect(owner).grantAccess(appA.address);
      await expectEmit(
        () => registry.connect(owner).revokeAccess(appA.address),
        registry,
        'AccessRevoked',
        [owner.address, appA.address]
      );
      await expectRevertedWithCustomError(
        () => registry.connect(appA).getMemory(owner.address),
        registry,
        'NotAuthorized'
      );
      expect(await registry.hasAccess(owner.address, appA.address)).to.equal(false);
    });

    it("revoking one app does not affect another app's access", async function () {
      await registry.connect(owner).grantAccess(appA.address);
      await registry.connect(owner).grantAccess(appB.address);
      await registry.connect(owner).revokeAccess(appA.address);

      expect(await registry.hasAccess(owner.address, appA.address)).to.equal(false);
      expect(await registry.hasAccess(owner.address, appB.address)).to.equal(true);
      const [storedCid] = await registry.connect(appB).getMemory(owner.address);
      expect(storedCid).to.equal(cid);
    });

    it('keeps both apps in appAccessHistory even after one is revoked', async function () {
      await registry.connect(owner).grantAccess(appA.address);
      await registry.connect(owner).grantAccess(appB.address);
      await registry.connect(owner).revokeAccess(appA.address);

      const history = await registry.appAccessHistory(owner.address);
      expect(history).to.include(appA.address);
      expect(history).to.include(appB.address);
    });

    it("a stranger can never read another user's memory without being granted access", async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(stranger).getMemory(owner.address),
        registry,
        'NotAuthorized'
      );
    });
  });

  describe('write access control (delegated writes via updateMemoryFor)', function () {
    it('blocks an app with no granted write access from writing on behalf of a user', async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(appA).updateMemoryFor(owner.address, cid, integrityHash),
        registry,
        'NotAuthorized'
      );
    });

    it('rejects granting write access to the zero address', async function () {
      await expectRevertedWithCustomError(
        () => registry.connect(owner).grantWriteAccess(ethers.ZeroAddress),
        registry,
        'NotAuthorized'
      );
    });

    it('lets a write-granted app write on the user\'s behalf, and emits WriteAccessGranted + MemoryUpdated', async function () {
      await expectEmit(
        () => registry.connect(owner).grantWriteAccess(appA.address),
        registry,
        'WriteAccessGranted',
        [owner.address, appA.address]
      );
      expect(await registry.hasWriteAccess(owner.address, appA.address)).to.equal(true);

      await expectEmit(
        () => registry.connect(appA).updateMemoryFor(owner.address, cid, integrityHash),
        registry,
        'MemoryUpdated'
      );
      const [storedCid, storedHash] = await registry.getMemory(owner.address);
      expect(storedCid).to.equal(cid);
      expect(storedHash).to.equal(integrityHash);
    });

    it('revokes write access so the app can no longer write, and emits WriteAccessRevoked', async function () {
      await registry.connect(owner).grantWriteAccess(appA.address);
      await expectEmit(
        () => registry.connect(owner).revokeWriteAccess(appA.address),
        registry,
        'WriteAccessRevoked',
        [owner.address, appA.address]
      );
      expect(await registry.hasWriteAccess(owner.address, appA.address)).to.equal(false);
      await expectRevertedWithCustomError(
        () => registry.connect(appA).updateMemoryFor(owner.address, cid, integrityHash),
        registry,
        'NotAuthorized'
      );
    });

    it('read access and write access are independent grants', async function () {
      await registry.connect(owner).grantAccess(appA.address);
      // appA can read (granted) but still cannot write (not granted)
      const [readCid] = await registry.connect(appA).getMemory(owner.address);
      expect(readCid).to.equal('');
      await expectRevertedWithCustomError(
        () => registry.connect(appA).updateMemoryFor(owner.address, cid, integrityHash),
        registry,
        'NotAuthorized'
      );

      // appB has write access but was never granted read access
      await registry.connect(owner).grantWriteAccess(appB.address);
      await registry.connect(appB).updateMemoryFor(owner.address, cid, integrityHash);
      await expectRevertedWithCustomError(
        () => registry.connect(appB).getMemory(owner.address),
        registry,
        'NotAuthorized'
      );
    });

    it('rejects empty CID in updateMemoryFor', async function () {
      await registry.connect(owner).grantWriteAccess(appA.address);
      await expectRevertedWithCustomError(
        () => registry.connect(appA).updateMemoryFor(owner.address, '', integrityHash),
        registry,
        'EmptyCid'
      );
    });

    it('lets a user write their own memory via updateMemoryFor with no grant needed', async function () {
      await registry.connect(owner).updateMemoryFor(owner.address, cid, integrityHash);
      const [storedCid] = await registry.getMemory(owner.address);
      expect(storedCid).to.equal(cid);
    });
  });

  describe('renewal funding (perpetual storage endowment)', function () {
    it('accepts FIL and tracks balance per user, emitting RenewalFunded', async function () {
      const amount = ethers.parseEther('1.0');
      await expectEmit(
        () => registry.connect(owner).fundRenewal({ value: amount }),
        registry,
        'RenewalFunded',
        [owner.address, amount, amount]
      );
      expect(await registry.renewalBalanceOf(owner.address)).to.equal(amount);
    });

    it('lets a user withdraw funded amounts back out', async function () {
      const amount = ethers.parseEther('2.0');
      await registry.connect(owner).fundRenewal({ value: amount });

      const before = await provider.getBalance(owner.address);
      const tx = await registry.connect(owner).withdrawRenewal(ethers.parseEther('1.0'));
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await provider.getBalance(owner.address);

      expect(after).to.equal(before + ethers.parseEther('1.0') - gasCost);
      expect(await registry.renewalBalanceOf(owner.address)).to.equal(ethers.parseEther('1.0'));
    });

    it('reverts if a user tries to withdraw more than their balance', async function () {
      await registry.connect(owner).fundRenewal({ value: ethers.parseEther('0.5') });
      await expectRevertedWithCustomError(
        () => registry.connect(owner).withdrawRenewal(ethers.parseEther('1.0')),
        registry,
        'NothingToWithdraw'
      );
    });

    it("keeps each user's renewal balance independent", async function () {
      await registry.connect(owner).fundRenewal({ value: ethers.parseEther('1.0') });
      await registry.connect(appA).fundRenewal({ value: ethers.parseEther('3.0') });

      expect(await registry.renewalBalanceOf(owner.address)).to.equal(ethers.parseEther('1.0'));
      expect(await registry.renewalBalanceOf(appA.address)).to.equal(ethers.parseEther('3.0'));
    });
  });

  describe('re-entrancy guard', function () {
    it('blocks a malicious contract from re-entering withdrawRenewal to drain extra funds', async function () {
      const attackerFactory = new ethers.ContractFactory(
        contracts.ReentrancyAttacker.abi,
        contracts.ReentrancyAttacker.bytecode,
        owner
      );
      const attacker = await attackerFactory.deploy(await registry.getAddress());
      await attacker.waitForDeployment();

      await attacker.fund({ value: ethers.parseEther('1.0') });
      expect(await registry.renewalBalanceOf(await attacker.getAddress())).to.equal(
        ethers.parseEther('1.0')
      );

      await expectRevertedWithCustomError(
        () => attacker.attack(ethers.parseEther('1.0')),
        registry,
        'TransferFailed'
      );

      expect(await registry.renewalBalanceOf(await attacker.getAddress())).to.equal(
        ethers.parseEther('1.0')
      );
    });
  });
});
