const { expect } = require('chai');
const { compileAll } = require('../compile-helper');

describe('compile-helper.js', function () {
  this.timeout(30000);

  let result;

  before(function () {
    result = compileAll();
  });

  it('returns EchoMemoryRegistry with abi and bytecode', function () {
    expect(result).to.have.property('EchoMemoryRegistry');
    expect(result.EchoMemoryRegistry).to.have.property('abi').that.is.an('array');
    expect(result.EchoMemoryRegistry).to.have.property('bytecode').that.is.a('string');
    expect(result.EchoMemoryRegistry.bytecode).to.match(/^0x[0-9a-f]+$/);
  });

  it('returns ReentrancyAttacker with abi and bytecode', function () {
    expect(result).to.have.property('ReentrancyAttacker');
    expect(result.ReentrancyAttacker).to.have.property('abi').that.is.an('array');
    expect(result.ReentrancyAttacker).to.have.property('bytecode').that.is.a('string');
    expect(result.ReentrancyAttacker.bytecode).to.match(/^0x[0-9a-f]+$/);
  });

  it('EchoMemoryRegistry ABI contains expected functions', function () {
    const names = result.EchoMemoryRegistry.abi
      .filter((e) => e.type === 'function')
      .map((e) => e.name);
    const expected = [
      'updateMemory',
      'getMemory',
      'grantAccess',
      'revokeAccess',
      'hasAccess',
      'fundRenewal',
      'withdrawRenewal',
      'renewalBalanceOf',
      'appAccessHistory',
      'initialize',
      'owner',
      'upgradeToAndCall',
      'proxiableUUID',
    ];
    for (const fn of expected) {
      expect(names).to.include(fn);
    }
  });

  it('returns EchoMemoryRegistryV2 with abi and bytecode', function () {
    expect(result).to.have.property('EchoMemoryRegistryV2');
    const v2Names = result.EchoMemoryRegistryV2.abi
      .filter((e) => e.type === 'function')
      .map((e) => e.name);
    expect(v2Names).to.include('version');
  });

  it('EchoMemoryRegistry ABI contains expected events', function () {
    const names = result.EchoMemoryRegistry.abi
      .filter((e) => e.type === 'event')
      .map((e) => e.name);
    const expected = ['MemoryUpdated', 'AccessGranted', 'AccessRevoked', 'WriteAccessGranted', 'WriteAccessRevoked', 'RenewalFunded', 'RenewalWithdrawn'];
    for (const ev of expected) {
      expect(names).to.include(ev);
    }
  });

  it('EchoMemoryRegistry ABI contains expected custom errors', function () {
    const names = result.EchoMemoryRegistry.abi
      .filter((e) => e.type === 'error')
      .map((e) => e.name);
    expect(names).to.include('NotAuthorized');
    expect(names).to.include('NothingToWithdraw');
    expect(names).to.include('TransferFailed');
    expect(names).to.include('EmptyCid');
    expect(names).to.include('ZeroFundAmount');
  });
});
