const solc = require('solc');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

/**
 * Resolve Solidity import paths, including @openzeppelin/* from node_modules.
 */
function findImports(importPath) {
  const candidates = [
    path.join(__dirname, 'node_modules', importPath),
    path.join(__dirname, 'contracts', importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, 'utf8') };
    }
  }
  return { error: `File not found: ${importPath}` };
}

/**
 * Runs the solc compiler against an arbitrary set of Solidity sources.
 * Every caller that previously hand-rolled its own solc invocation now
 * goes through this single path, keeping the evmVersion pin and error
 * handling in one place.
 *
 * @param {Record<string, {content: string}>} sources solc-style source map
 * @param {object} [options]
 * @param {Function} [options.importResolver] solc import callback (defaults to findImports)
 * @returns {object} { output, warnings }
 */
function compileSources(sources, options) {
  const importResolver = (options && options.importResolver) || findImports;

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: importResolver }));

  const warnings = [];
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length) {
      fatal.forEach((e) => console.error(e.formattedMessage));
      throw new Error('Solidity compilation failed');
    }
    output.errors
      .filter((e) => e.severity !== 'error')
      .forEach((e) => warnings.push(e.formattedMessage));
  }

  return { output, warnings };
}

function extractContract(output, fileName, contractName) {
  const compiled = output.contracts[fileName][contractName];
  return { abi: compiled.abi, bytecode: '0x' + compiled.evm.bytecode.object };
}

/**
 * Compiles only the main EchoMemoryRegistry contract.
 * Used by compile.js where the test-only attacker and V2 are irrelevant.
 */
function compileRegistry() {
  const sources = {
    'EchoMemoryRegistry.sol': {
      content: fs.readFileSync(path.join(__dirname, 'contracts', 'EchoMemoryRegistry.sol'), 'utf8'),
    },
  };

  const { output, warnings } = compileSources(sources);
  return {
    contract: extractContract(output, 'EchoMemoryRegistry.sol', 'EchoMemoryRegistry'),
    warnings,
  };
}

/**
 * Compiles the main contract, the test-only attacker helper, and V2,
 * returning { abi, bytecode } for each. Used by the test suite.
 */
function compileAll() {
  const sources = {
    'EchoMemoryRegistry.sol': {
      content: fs.readFileSync(path.join(__dirname, 'contracts', 'EchoMemoryRegistry.sol'), 'utf8'),
    },
    'ReentrancyAttacker.sol': {
      content: fs.readFileSync(
        path.join(__dirname, 'contracts', 'test-helpers', 'ReentrancyAttacker.sol'),
        'utf8'
      ),
    },
    'EchoMemoryRegistryV2.sol': {
      content: fs.readFileSync(
        path.join(__dirname, 'contracts', 'EchoMemoryRegistryV2.sol'),
        'utf8'
      ),
    },
  };

  const { output } = compileSources(sources);

  const result = {
    EchoMemoryRegistry: extractContract(output, 'EchoMemoryRegistry.sol', 'EchoMemoryRegistry'),
    ReentrancyAttacker: extractContract(output, 'ReentrancyAttacker.sol', 'ReentrancyAttacker'),
  };

  const v2File = output.contracts['EchoMemoryRegistryV2.sol'];
  if (v2File && v2File['EchoMemoryRegistryV2']) {
    result.EchoMemoryRegistryV2 = extractContract(output, 'EchoMemoryRegistryV2.sol', 'EchoMemoryRegistryV2');
  }

  return result;
}

/**
 * Compile just the ERC1967Proxy from OpenZeppelin for proxy deployment.
 * Uses a small wrapper source so relative OZ imports resolve correctly.
 */
function compileProxy() {
  const wrapperSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";`;

  const sources = {
    'ProxyWrapper.sol': { content: wrapperSource },
  };

  const { output } = compileSources(sources);

  const proxyKey = '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
  const proxy = output.contracts[proxyKey]['ERC1967Proxy'];
  return { abi: proxy.abi, bytecode: '0x' + proxy.evm.bytecode.object };
}

/**
 * Deploys a compiled contract and waits for the deployment transaction.
 * Deduplicates the ContractFactory → deploy → waitForDeployment pattern
 * used in deploy.js and both test files.
 *
 * @param {{abi: any[], bytecode: string}} compiled  output from compileRegistry/compileAll
 * @param {ethers.Signer} signer                     wallet or signer to deploy with
 * @returns {Promise<ethers.Contract>}                the deployed contract instance
 */
async function deployContract(compiled, signer) {
  const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract;
}

module.exports = { compileSources, compileRegistry, compileAll, compileProxy, deployContract };
