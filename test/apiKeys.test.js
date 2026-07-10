const { expect } = require('chai');
const { generateApiKey, validateApiKey, revokeApiKey } = require('../lib/apiKeys');

describe('lib/apiKeys.js', function () {
  const userAddress = '0x1234567890123456789012345678901234567890';

  describe('generateApiKey', function () {
    it('returns a key in the echo_<64-hex> format', function () {
      const key = generateApiKey(userAddress);
      expect(key).to.match(/^echo_[0-9a-f]{64}$/);
    });

    it('generates a different key on each call', function () {
      const a = generateApiKey(userAddress);
      const b = generateApiKey(userAddress);
      expect(a).to.not.equal(b);
    });

    it('rejects a missing userAddress', function () {
      expect(() => generateApiKey()).to.throw('userAddress');
      expect(() => generateApiKey('')).to.throw('userAddress');
    });
  });

  describe('validateApiKey', function () {
    it('resolves a valid key back to its userAddress', function () {
      const key = generateApiKey(userAddress);
      const record = validateApiKey(key);
      expect(record).to.not.equal(null);
      expect(record.userAddress).to.equal(userAddress);
      expect(record).to.have.property('createdAt');
    });

    it('returns null for an unknown key', function () {
      expect(validateApiKey('echo_' + 'a'.repeat(64))).to.equal(null);
    });

    it('returns null for non-string input', function () {
      expect(validateApiKey(undefined)).to.equal(null);
      expect(validateApiKey(null)).to.equal(null);
    });
  });

  describe('revokeApiKey', function () {
    it('removes a key so it no longer validates', function () {
      const key = generateApiKey(userAddress);
      expect(validateApiKey(key)).to.not.equal(null);
      const removed = revokeApiKey(key);
      expect(removed).to.equal(true);
      expect(validateApiKey(key)).to.equal(null);
    });

    it('returns false when revoking a key that does not exist', function () {
      expect(revokeApiKey('echo_' + 'b'.repeat(64))).to.equal(false);
    });
  });
});
