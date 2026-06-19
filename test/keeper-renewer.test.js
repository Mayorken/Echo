const { expect } = require('chai');
const lighthouse = require('@lighthouse-web3/sdk');
const { checkDealStatus, repinCid } = require('../keeper/renewer');

describe('keeper/renewer.js', function () {
  let originalDealStatus;
  let originalUploadBuffer;
  let originalFetch;

  beforeEach(function () {
    originalDealStatus = lighthouse.dealStatus;
    originalUploadBuffer = lighthouse.uploadBuffer;
    originalFetch = globalThis.fetch;
  });

  afterEach(function () {
    lighthouse.dealStatus = originalDealStatus;
    lighthouse.uploadBuffer = originalUploadBuffer;
    globalThis.fetch = originalFetch;
  });

  describe('checkDealStatus', function () {
    it('returns "no-deal" when Lighthouse returns empty deals', async function () {
      lighthouse.dealStatus = async function () {
        return { data: [] };
      };
      const result = await checkDealStatus('QmTestCid');
      expect(result.status).to.equal('no-deal');
      expect(result.deals).to.deep.equal([]);
    });

    it('returns "active" when at least one deal is active', async function () {
      lighthouse.dealStatus = async function () {
        return {
          data: [
            { dealStatus: 'active', endEpoch: '999999', currentEpoch: '100000' },
          ],
        };
      };
      const result = await checkDealStatus('QmTestCid');
      expect(result.status).to.equal('active');
    });

    it('returns "expiring" when active deal is within threshold', async function () {
      lighthouse.dealStatus = async function () {
        return {
          data: [
            { dealStatus: 'active', endEpoch: '101000', currentEpoch: '100000' },
          ],
        };
      };
      const result = await checkDealStatus('QmTestCid', { expiryThresholdEpochs: 2880 });
      expect(result.status).to.equal('expiring');
    });

    it('returns "error" when dealStatus throws', async function () {
      lighthouse.dealStatus = async function () {
        throw new Error('Network error');
      };
      const result = await checkDealStatus('QmTestCid');
      expect(result.status).to.equal('error');
      expect(result.error).to.equal('Network error');
    });

    it('returns "no-deal" when data is null', async function () {
      lighthouse.dealStatus = async function () {
        return { data: null };
      };
      const result = await checkDealStatus('QmTestCid');
      expect(result.status).to.equal('no-deal');
    });
  });

  describe('repinCid', function () {
    it('fetches from gateway and re-uploads via Lighthouse', async function () {
      const testData = Buffer.from('encrypted context data');
      globalThis.fetch = async function (url) {
        expect(url).to.include('QmTestCid');
        return {
          ok: true,
          arrayBuffer: async () => testData.buffer.slice(testData.byteOffset, testData.byteOffset + testData.byteLength),
        };
      };
      lighthouse.uploadBuffer = async function (buffer, apiKey) {
        expect(Buffer.isBuffer(buffer)).to.equal(true);
        expect(apiKey).to.equal('test-key');
        return { data: { Hash: 'QmRePinnedCid', Name: 'QmRePinnedCid', Size: '22' } };
      };

      const result = await repinCid('QmTestCid', 'test-key');
      expect(result.success).to.equal(true);
      expect(result.newCid).to.equal('QmRePinnedCid');
    });

    it('returns error when gateway fetch fails', async function () {
      globalThis.fetch = async function () {
        return { ok: false, status: 404 };
      };

      const result = await repinCid('QmMissingCid', 'test-key');
      expect(result.success).to.equal(false);
      expect(result.error).to.include('HTTP 404');
    });

    it('returns error when Lighthouse upload fails', async function () {
      globalThis.fetch = async function () {
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(10),
        };
      };
      lighthouse.uploadBuffer = async function () {
        return { data: {} };
      };

      const result = await repinCid('QmTestCid', 'test-key');
      expect(result.success).to.equal(false);
      expect(result.error).to.include('unexpected response');
    });

    it('uses custom gateway when provided', async function () {
      let fetchedUrl = '';
      globalThis.fetch = async function (url) {
        fetchedUrl = url;
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(5),
        };
      };
      lighthouse.uploadBuffer = async function () {
        return { data: { Hash: 'QmNew', Name: 'QmNew', Size: '5' } };
      };

      await repinCid('QmTestCid', 'test-key', { gateway: 'https://custom-gw.io/ipfs' });
      expect(fetchedUrl).to.equal('https://custom-gw.io/ipfs/QmTestCid');
    });

    it('returns error when fetch throws', async function () {
      globalThis.fetch = async function () {
        throw new Error('DNS resolution failed');
      };

      const result = await repinCid('QmTestCid', 'test-key');
      expect(result.success).to.equal(false);
      expect(result.error).to.equal('DNS resolution failed');
    });
  });
});
