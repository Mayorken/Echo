const ganache = require('ganache');
const { ethers } = require('ethers');
const { compileAll, deployContract } = require('../compile-helper');

/**
 * A minimal in-memory stand-in for a real Filecoin storage adapter (Synapse
 * SDK / web3.storage / Lighthouse). Implements the same put(bytes)->cid and
 * get(cid)->bytes contract the real EchoClient expects.
 */
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

function closeServerWithTimeout(server, ms = 2000) {
  return Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * Creates an in-process ganache provider suitable for unit tests.
 * Returns an ethers BrowserProvider wrapping ganache with caching disabled.
 */
function createGanacheProvider() {
  const ganacheProvider = ganache.provider({ logging: { quiet: true } });
  return new ethers.BrowserProvider(ganacheProvider, undefined, { cacheTimeout: -1 });
}

/**
 * Spins up a dedicated ganache HTTP server on the given port and returns the
 * RPC URL, a JSON-RPC provider, and the raw private keys for the first three
 * accounts. Caller is responsible for teardown.
 */
async function createGanacheServer(port) {
  const server = ganache.server({ logging: { quiet: true } });
  await new Promise((resolve, reject) => {
    server.listen(port, (err) => (err ? reject(err) : resolve()));
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const privateKeys = server.provider.getInitialAccounts();
  const keys = Object.values(privateKeys).map((a) => a.secretKey);

  return { server, rpcUrl, provider, keys };
}

module.exports = {
  compileAll,
  deployContract,
  makeFakeStorage,
  closeServerWithTimeout,
  createGanacheProvider,
  createGanacheServer,
};
