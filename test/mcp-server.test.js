const { expect } = require('chai');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll } = require('../compile-helper');
const { deployProxy } = require('./proxy-helper');
const { createMcpHandler, handleMessage, TOOL_DEFINITIONS } = require('../integrations/mcp-server');
const { generateKey } = require('../lib/crypto');

function makeFakeStorage() {
  const blobs = new Map();
  let counter = 0;
  return {
    async put(bytes) {
      const cid = `fakecid${counter++}`;
      blobs.set(cid, bytes);
      return cid;
    },
    async get(cid) {
      if (!blobs.has(cid)) throw new Error('not found: ' + cid);
      return blobs.get(cid);
    },
  };
}

describe('integrations/mcp-server.js', function () {
  this.timeout(30000);

  let contracts, provider, owner, stranger, handleToolCall, encryptionKey;

  before(async function () {
    contracts = compileAll();
    const ganacheProvider = ganache.provider({ logging: { quiet: true } });
    provider = new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
    const accounts = await provider.listAccounts();
    owner = await provider.getSigner(accounts[0].address);
    stranger = await provider.getSigner(accounts[1].address);
    encryptionKey = await generateKey();
  });

  beforeEach(async function () {
    const registry = await deployProxy(contracts.EchoMemoryRegistry, owner);
    const contractAddress = await registry.getAddress();
    const storage = makeFakeStorage();
    handleToolCall = createMcpHandler({
      rpcUrl: 'not-used',
      contractAddress,
      signer: owner,
      storage,
      encryptionKey,
    });
  });

  describe('TOOL_DEFINITIONS', function () {
    it('exports 7 tool definitions', function () {
      expect(TOOL_DEFINITIONS).to.have.length(7);
      const names = TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).to.include('echo_save_context');
      expect(names).to.include('echo_load_context');
      expect(names).to.include('echo_grant_access');
      expect(names).to.include('echo_revoke_access');
      expect(names).to.include('echo_list_access');
      expect(names).to.include('echo_fund_renewal');
      expect(names).to.include('echo_generate_key');
    });

    it('each tool has name, description, and inputSchema', function () {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool).to.have.property('name');
        expect(tool).to.have.property('description');
        expect(tool).to.have.property('inputSchema');
      }
    });
  });

  describe('echo_save_context', function () {
    it('saves context and returns cid', async function () {
      const result = await handleToolCall('echo_save_context', {
        context: { project: 'Echo', lang: 'Solidity' },
      });
      expect(result.content).to.have.length(1);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).to.equal(true);
      expect(data).to.have.property('cid');
      expect(data).to.have.property('integrityHash');
    });
  });

  describe('echo_load_context', function () {
    it('returns null when no context exists', async function () {
      const result = await handleToolCall('echo_load_context', {
        userAddress: owner.address,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.context).to.equal(null);
    });

    it('loads previously saved context', async function () {
      const context = { stack: 'FEVM', encryption: 'AES-256-GCM' };
      await handleToolCall('echo_save_context', { context });
      const result = await handleToolCall('echo_load_context', {
        userAddress: owner.address,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.context).to.deep.equal(context);
    });
  });

  describe('echo_grant_access + echo_revoke_access', function () {
    it('grants and revokes access', async function () {
      const grantResult = await handleToolCall('echo_grant_access', {
        appAddress: stranger.address,
      });
      const grantData = JSON.parse(grantResult.content[0].text);
      expect(grantData.success).to.equal(true);
      expect(grantData.granted).to.equal(stranger.address);

      const revokeResult = await handleToolCall('echo_revoke_access', {
        appAddress: stranger.address,
      });
      const revokeData = JSON.parse(revokeResult.content[0].text);
      expect(revokeData.success).to.equal(true);
      expect(revokeData.revoked).to.equal(stranger.address);
    });
  });

  describe('echo_list_access', function () {
    it('lists granted apps', async function () {
      await handleToolCall('echo_grant_access', { appAddress: stranger.address });
      const result = await handleToolCall('echo_list_access', {
        userAddress: owner.address,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.apps).to.have.length(1);
      expect(data.apps[0].app).to.equal(stranger.address);
      expect(data.apps[0].active).to.equal(true);
    });
  });

  describe('echo_generate_key', function () {
    it('returns a hex-encoded key', async function () {
      const result = await handleToolCall('echo_generate_key', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.key).to.match(/^[0-9a-f]{64}$/);
    });
  });

  describe('input validation', function () {
    it('rejects invalid userAddress in echo_load_context', async function () {
      let threw = false;
      try {
        await handleToolCall('echo_load_context', { userAddress: 'bad' });
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Valid userAddress');
      }
      expect(threw).to.equal(true);
    });

    it('rejects invalid appAddress in echo_grant_access', async function () {
      let threw = false;
      try {
        await handleToolCall('echo_grant_access', { appAddress: 'not-valid' });
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Valid appAddress');
      }
      expect(threw).to.equal(true);
    });

    it('rejects invalid appAddress in echo_revoke_access', async function () {
      let threw = false;
      try {
        await handleToolCall('echo_revoke_access', { appAddress: '' });
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Valid appAddress');
      }
      expect(threw).to.equal(true);
    });

    it('rejects invalid userAddress in echo_list_access', async function () {
      let threw = false;
      try {
        await handleToolCall('echo_list_access', { userAddress: '0xinvalid' });
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Valid userAddress');
      }
      expect(threw).to.equal(true);
    });

    it('rejects invalid amountInFil in echo_fund_renewal', async function () {
      let threw = false;
      try {
        await handleToolCall('echo_fund_renewal', { amountInFil: '-1' });
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Valid amountInFil');
      }
      expect(threw).to.equal(true);
    });

    it('rejects missing context in echo_save_context', async function () {
      let threw = false;
      try {
        await handleToolCall('echo_save_context', {});
      } catch (err) {
        threw = true;
        expect(err.message).to.include('context');
      }
      expect(threw).to.equal(true);
    });
  });

  describe('unknown tool', function () {
    it('throws on unknown tool name', async function () {
      let threw = false;
      try {
        await handleToolCall('nonexistent_tool', {});
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Unknown tool');
      }
      expect(threw).to.equal(true);
    });
  });

  describe('handleMessage (JSON-RPC)', function () {
    let output;

    beforeEach(function () {
      output = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = function (data) {
        output.push(data);
        return true;
      };
      this._restore = () => { process.stdout.write = originalWrite; };
    });

    afterEach(function () {
      this._restore();
    });

    it('responds to initialize', async function () {
      await handleMessage(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }), handleToolCall);
      expect(output).to.have.length(1);
      const resp = JSON.parse(output[0].trim());
      expect(resp.id).to.equal(1);
      expect(resp.result.serverInfo.name).to.equal('echo-context');
      expect(resp.result.capabilities.tools).to.deep.equal({});
    });

    it('responds to tools/list', async function () {
      await handleMessage(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }), handleToolCall);
      const resp = JSON.parse(output[0].trim());
      expect(resp.result.tools).to.have.length(7);
    });

    it('responds to tools/call', async function () {
      await handleMessage(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo_generate_key', arguments: {} },
      }), handleToolCall);
      const resp = JSON.parse(output[0].trim());
      expect(resp.id).to.equal(3);
      const data = JSON.parse(resp.result.content[0].text);
      expect(data.key).to.match(/^[0-9a-f]{64}$/);
    });

    it('returns error for unknown method', async function () {
      await handleMessage(JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'unknown/method',
      }), handleToolCall);
      const resp = JSON.parse(output[0].trim());
      expect(resp.error.code).to.equal(-32601);
    });
  });
});
