const { expect } = require('chai');

/**
 * Extracts raw revert data from an ethers v6 error object. Different
 * providers (and different call paths — eth_call vs eth_estimateGas vs a
 * sent tx) surface it in different places, so this checks them in order.
 */
function extractRevertData(err) {
  if (err.data && err.data !== '0x') return err.data;
  if (err.info && err.info.error && err.info.error.data) {
    const d = err.info.error.data;
    if (typeof d === 'string') return d;
    if (d.result) return d.result;
    if (d.data) return d.data;
  }
  return null;
}

/**
 * Calls an async function expected to revert with a specific Solidity
 * custom error, and asserts on the decoded error name.
 *
 * Usage: await expectRevertedWithCustomError(
 *   () => registry.connect(stranger).getMemory(owner.address),
 *   registry,
 *   'NotAuthorized'
 * );
 */
async function expectRevertedWithCustomError(fn, contract, errorName) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    const data = extractRevertData(err);
    expect(data, `Expected a revert with custom error data, got: ${err.message}`).to.not.be.null;
    const decoded = contract.interface.parseError(data);
    expect(decoded.name).to.equal(errorName);
  }
  expect(threw, `Expected the call to revert with ${errorName}, but it succeeded`).to.equal(true);
}

/**
 * Calls an async function expected to succeed and emit a specific event,
 * then asserts on the event's decoded args.
 *
 * Usage: await expectEmit(
 *   () => registry.connect(owner).grantAccess(appA.address),
 *   registry,
 *   'AccessGranted',
 *   [owner.address, appA.address]
 * );
 */
async function expectEmit(fn, contract, eventName, expectedArgs) {
  const tx = await fn();
  const receipt = await tx.wait();
  const address = await contract.getAddress();

  const matches = receipt.logs
    .filter((log) => log.address.toLowerCase() === address.toLowerCase())
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed && parsed.name === eventName);

  expect(matches.length, `Expected ${eventName} to be emitted, found events: ${receipt.logs.length}`).to.be.greaterThan(0);

  if (expectedArgs) {
    const args = matches[0].args;
    expectedArgs.forEach((expected, i) => {
      expect(args[i].toString()).to.equal(expected.toString());
    });
  }
  return receipt;
}

module.exports = { expectRevertedWithCustomError, expectEmit };
