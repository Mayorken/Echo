const { expect } = require('chai');
const {
  createSynapseStorage,
  prepareUploadBytes,
  restoreDownloadBytes,
  MIN_PIECE_BYTES,
} = require('../lib/storage');

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

  describe('minimum piece-size envelope', function () {
    it('pads a short encrypted payload and restores it byte-for-byte', function () {
      const original = Uint8Array.from([1, 2, 3, 4, 5]);
      const padded = prepareUploadBytes(original);

      expect(padded.byteLength).to.equal(MIN_PIECE_BYTES);
      expect(Array.from(restoreDownloadBytes(padded))).to.deep.equal(Array.from(original));
    });

    it('leaves sufficiently large and legacy unwrapped payloads unchanged', function () {
      const large = new Uint8Array(MIN_PIECE_BYTES + 10).fill(7);
      const legacy = Uint8Array.from([9, 8, 7]);

      expect(prepareUploadBytes(large)).to.equal(large);
      expect(restoreDownloadBytes(large)).to.equal(large);
      expect(restoreDownloadBytes(legacy)).to.equal(legacy);
    });

    it('rejects a malformed Echo padding envelope', function () {
      const padded = prepareUploadBytes(Uint8Array.from([1, 2, 3]));
      new DataView(padded.buffer).setUint32(8, 9999, false);
      expect(() => restoreDownloadBytes(padded)).to.throw('Invalid Echo storage padding envelope');
    });
  });
});
