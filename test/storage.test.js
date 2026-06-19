const { expect } = require('chai');
const { createLighthouseStorage, DEFAULT_GATEWAY } = require('../lib/storage');

describe('lib/storage.js (Lighthouse adapter)', function () {
  this.timeout(10000);

  describe('createLighthouseStorage', function () {
    it('throws if no API key is provided', function () {
      expect(() => createLighthouseStorage()).to.throw('API key is required');
      expect(() => createLighthouseStorage('')).to.throw('API key is required');
    });

    it('returns an object with put and get methods', function () {
      const storage = createLighthouseStorage('test-key');
      expect(storage).to.have.property('put').that.is.a('function');
      expect(storage).to.have.property('get').that.is.a('function');
    });
  });

  describe('put (with mocked Lighthouse SDK)', function () {
    let originalUploadBuffer;
    const lighthouse = require('@lighthouse-web3/sdk');

    before(function () {
      originalUploadBuffer = lighthouse.uploadBuffer;
    });

    afterEach(function () {
      lighthouse.uploadBuffer = originalUploadBuffer;
    });

    it('uploads bytes via uploadBuffer and returns the CID', async function () {
      const fakeCid = 'QmTestCid123456789abcdef';
      lighthouse.uploadBuffer = async function (buffer, apiKey) {
        expect(Buffer.isBuffer(buffer)).to.equal(true);
        expect(apiKey).to.equal('my-api-key');
        return { data: { Name: fakeCid, Hash: fakeCid, Size: String(buffer.length) } };
      };

      const storage = createLighthouseStorage('my-api-key');
      const cid = await storage.put(new Uint8Array([1, 2, 3, 4]));
      expect(cid).to.equal(fakeCid);
    });

    it('converts Uint8Array to Buffer before uploading', async function () {
      let receivedBuffer;
      lighthouse.uploadBuffer = async function (buffer) {
        receivedBuffer = buffer;
        return { data: { Name: 'cid', Hash: 'cid', Size: '5' } };
      };

      const storage = createLighthouseStorage('key');
      await storage.put(new Uint8Array([10, 20, 30, 40, 50]));
      expect(Buffer.isBuffer(receivedBuffer)).to.equal(true);
      expect(receivedBuffer.length).to.equal(5);
      expect(receivedBuffer[0]).to.equal(10);
      expect(receivedBuffer[4]).to.equal(50);
    });

    it('throws if Lighthouse returns an unexpected response', async function () {
      lighthouse.uploadBuffer = async function () {
        return { data: null };
      };

      const storage = createLighthouseStorage('key');
      let threw = false;
      try {
        await storage.put(new Uint8Array([1]));
      } catch (err) {
        threw = true;
        expect(err.message).to.include('unexpected response');
      }
      expect(threw).to.equal(true);
    });

    it('throws if Lighthouse returns no data at all', async function () {
      lighthouse.uploadBuffer = async function () {
        return {};
      };

      const storage = createLighthouseStorage('key');
      let threw = false;
      try {
        await storage.put(new Uint8Array([1]));
      } catch (err) {
        threw = true;
        expect(err.message).to.include('unexpected response');
      }
      expect(threw).to.equal(true);
    });
  });

  describe('get (with mocked fetch)', function () {
    let originalFetch;

    before(function () {
      originalFetch = globalThis.fetch;
    });

    afterEach(function () {
      globalThis.fetch = originalFetch;
    });

    it('fetches from the default IPFS gateway and returns Uint8Array', async function () {
      const testData = new Uint8Array([99, 100, 101]);
      globalThis.fetch = async function (url) {
        expect(url).to.equal(`${DEFAULT_GATEWAY}/QmTestCid`);
        return {
          ok: true,
          arrayBuffer: async () => testData.buffer,
        };
      };

      const storage = createLighthouseStorage('key');
      const result = await storage.get('QmTestCid');
      expect(result).to.be.an.instanceOf(Uint8Array);
      expect(result.length).to.equal(3);
      expect(result[0]).to.equal(99);
    });

    it('uses a custom gateway when provided', async function () {
      let calledUrl;
      globalThis.fetch = async function (url) {
        calledUrl = url;
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      };

      const storage = createLighthouseStorage('key', { gateway: 'https://my-gateway.io/ipfs' });
      await storage.get('QmCustom');
      expect(calledUrl).to.equal('https://my-gateway.io/ipfs/QmCustom');
    });

    it('throws on HTTP error responses', async function () {
      globalThis.fetch = async function () {
        return { ok: false, status: 404 };
      };

      const storage = createLighthouseStorage('key');
      let threw = false;
      try {
        await storage.get('QmNonExistent');
      } catch (err) {
        threw = true;
        expect(err.message).to.include('HTTP 404');
        expect(err.message).to.include('QmNonExistent');
      }
      expect(threw).to.equal(true);
    });
  });

  describe('re-export from echo-sdk', function () {
    it('is accessible via the SDK module', function () {
      const { createLighthouseStorage: fromSdk } = require('../echo-sdk');
      expect(fromSdk).to.be.a('function');
      const storage = fromSdk('test-key');
      expect(storage).to.have.property('put');
      expect(storage).to.have.property('get');
    });
  });
});
