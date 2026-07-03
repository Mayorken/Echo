const { expect } = require('chai');
const { checkStorageStatus, repinData } = require('../keeper/renewer');

describe('keeper/renewer.js', function () {
  describe('checkStorageStatus', function () {
    it('returns "active" when download succeeds', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => new Uint8Array([1, 2, 3]),
        },
      };
      const result = await checkStorageStatus('bafk-test-cid', fakeSynapse);
      expect(result.status).to.equal('active');
    });

    it('returns "not-found" when download throws "not found"', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => { throw new Error('piece not found'); },
        },
      };
      const result = await checkStorageStatus('bafk-missing', fakeSynapse);
      expect(result.status).to.equal('not-found');
      expect(result.copies).to.equal(0);
    });

    it('returns "not-found" when download returns null', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => null,
        },
      };
      const result = await checkStorageStatus('bafk-null', fakeSynapse);
      expect(result.status).to.equal('not-found');
    });

    it('returns "error" when download throws a non-"not found" error', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => { throw new Error('Network timeout'); },
        },
      };
      const result = await checkStorageStatus('bafk-err', fakeSynapse);
      expect(result.status).to.equal('error');
      expect(result.error).to.equal('Network timeout');
    });
  });

  describe('repinData', function () {
    it('downloads and re-uploads data via Synapse', async function () {
      const testData = new Uint8Array([10, 20, 30]);
      const fakeSynapse = {
        storage: {
          download: async () => testData,
          prepare: async () => ({ transaction: null }),
          upload: async (data) => {
            expect(data).to.deep.equal(testData);
            return { pieceCid: 'bafk-new-cid', size: 3, complete: true, copies: [1, 2] };
          },
        },
      };

      const result = await repinData('bafk-old-cid', fakeSynapse);
      expect(result.success).to.equal(true);
      expect(result.newPieceCid).to.equal('bafk-new-cid');
    });

    it('executes prepare transaction when needed', async function () {
      let prepareExecuted = false;
      const fakeSynapse = {
        storage: {
          download: async () => new Uint8Array([1]),
          prepare: async () => ({
            transaction: { execute: async () => { prepareExecuted = true; return { hash: '0x123' }; } },
          }),
          upload: async () => ({ pieceCid: 'bafk-new', size: 1, complete: true, copies: [1] }),
        },
      };

      const result = await repinData('bafk-test', fakeSynapse);
      expect(result.success).to.equal(true);
      expect(prepareExecuted).to.equal(true);
    });

    it('returns error when download fails', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => { throw new Error('Download failed'); },
        },
      };

      const result = await repinData('bafk-missing', fakeSynapse);
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('Download failed');
    });

    it('returns error when upload returns no pieceCid', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => new Uint8Array([1]),
          prepare: async () => ({ transaction: null }),
          upload: async () => ({}),
        },
      };

      const result = await repinData('bafk-test', fakeSynapse);
      expect(result.success).to.equal(false);
      expect(result.error).to.include('no pieceCid');
    });

    it('returns error when download returns null', async function () {
      const fakeSynapse = {
        storage: {
          download: async () => null,
        },
      };

      const result = await repinData('bafk-null', fakeSynapse);
      expect(result.success).to.equal(false);
      expect(result.error).to.include('no data');
    });
  });
});
