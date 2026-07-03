const { expect } = require('chai');
const { createSynapseStorage } = require('../lib/storage');

describe('lib/storage.js (Synapse adapter)', function () {
  this.timeout(10000);

  describe('createSynapseStorage', function () {
    it('rejects if no private key is provided', async function () {
      try {
        await createSynapseStorage();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('Private key is required');
      }

      try {
        await createSynapseStorage('');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('Private key is required');
      }
    });

    it('returns an object with put and get methods', async function () {
      // Use a well-known test private key (not a real wallet)
      const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      const storage = await createSynapseStorage(testKey);
      expect(storage).to.have.property('put').that.is.a('function');
      expect(storage).to.have.property('get').that.is.a('function');
    });
  });

  describe('re-export from echo-sdk', function () {
    it('is accessible via the SDK module', function () {
      const { createSynapseStorage: fromSdk } = require('../echo-sdk');
      expect(fromSdk).to.be.a('function');
    });
  });
});
