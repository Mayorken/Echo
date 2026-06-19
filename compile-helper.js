const solc = require('solc');
const fs = require('fs');
const path = require('path');

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
 * Compiles both the main contract and the test-only attacker helper,
 * returning { abi, bytecode } for each. Used by compile.js (production)
 * and by the test suite (local-chain testing) so there's only one
 * compilation path to keep in sync.
 */
function compileAll() {
  const registryPath = path.join(__dirname, 'contracts', 'EchoMemoryRegistry.sol');
  const attackerPath = path.join(__dirname, 'contracts', 'test-helpers', 'ReentrancyAttacker.sol');
  const v2Path = path.join(__dirname, 'contracts', 'EchoMemoryRegistryV2.sol');

  if (!fs.existsSync(registryPath)) {
    throw new Error(`compileAll: contract source not found at: ${registryPath}`);
  }
  if (!fs.existsSync(attackerPath)) {
    throw new Error(`compileAll: test helper not found at: ${attackerPath}`);
  }

  const sources = {
    'EchoMemoryRegistry.sol': {
      content: fs.readFileSync(registryPath, 'utf8'),
    },
    'ReentrancyAttacker.sol': {
      content: fs.readFileSync(attackerPath, 'utf8'),
    },
    'EchoMemoryRegistryV2.sol': {
      content: fs.readFileSync(v2Path, 'utf8'),
    },
  };

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length) {
      fatal.forEach((e) => console.error(e.formattedMessage));
      throw new Error('Solidity compilation failed');
    }
  }

  if (!output.contracts || !output.contracts['EchoMemoryRegistry.sol'] ||
      !output.contracts['EchoMemoryRegistry.sol']['EchoMemoryRegistry']) {
    throw new Error('compileAll: compilation produced no output for EchoMemoryRegistry');
  }
  if (!output.contracts['ReentrancyAttacker.sol'] ||
      !output.contracts['ReentrancyAttacker.sol']['ReentrancyAttacker']) {
    throw new Error('compileAll: compilation produced no output for ReentrancyAttacker');
  }

  const registry = output.contracts['EchoMemoryRegistry.sol']['EchoMemoryRegistry'];
  const attacker = output.contracts['ReentrancyAttacker.sol']['ReentrancyAttacker'];
  const registryV2 = output.contracts['EchoMemoryRegistryV2.sol']['EchoMemoryRegistryV2'];

  if (!registry.abi || !registry.evm?.bytecode?.object) {
    throw new Error('compileAll: EchoMemoryRegistry output is missing ABI or bytecode');
  }
  if (!attacker.abi || !attacker.evm?.bytecode?.object) {
    throw new Error('compileAll: ReentrancyAttacker output is missing ABI or bytecode');
  }

  const result = {
    EchoMemoryRegistry: { abi: registry.abi, bytecode: '0x' + registry.evm.bytecode.object },
    ReentrancyAttacker: { abi: attacker.abi, bytecode: '0x' + attacker.evm.bytecode.object },
  };

  if (registryV2) {
    result.EchoMemoryRegistryV2 = { abi: registryV2.abi, bytecode: '0x' + registryV2.evm.bytecode.object };
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

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length) {
      fatal.forEach((e) => console.error(e.formattedMessage));
      throw new Error('Proxy compilation failed');
    }
  }

  const proxyKey = '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
  if (!output.contracts || !output.contracts[proxyKey] || !output.contracts[proxyKey]['ERC1967Proxy']) {
    throw new Error('compileProxy: compilation produced no output for ERC1967Proxy');
  }
  const proxy = output.contracts[proxyKey]['ERC1967Proxy'];
  if (!proxy.abi || !proxy.evm?.bytecode?.object) {
    throw new Error('compileProxy: ERC1967Proxy output is missing ABI or bytecode');
  }
  return { abi: proxy.abi, bytecode: '0x' + proxy.evm.bytecode.object };
}

module.exports = { compileAll, compileProxy };
