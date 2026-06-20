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
    // Shims for OZ contracts removed in v5 (e.g. ReentrancyGuardUpgradeable)
    path.join(__dirname, 'contracts', 'shims', path.basename(importPath)),
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
    'EchoMemoryRegistryV3.sol': {
      content: fs.readFileSync(
        path.join(__dirname, 'contracts', 'EchoMemoryRegistryV3.sol'),
        'utf8'
      ),
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

  const registry = output.contracts['EchoMemoryRegistry.sol']['EchoMemoryRegistry'];
  const attacker = output.contracts['ReentrancyAttacker.sol']['ReentrancyAttacker'];
  const registryV2 = output.contracts['EchoMemoryRegistryV2.sol']['EchoMemoryRegistryV2'];

  const registryV3 = output.contracts['EchoMemoryRegistryV3.sol']['EchoMemoryRegistryV3'];

  const result = {
    EchoMemoryRegistry: { abi: registry.abi, bytecode: '0x' + registry.evm.bytecode.object },
    ReentrancyAttacker: { abi: attacker.abi, bytecode: '0x' + attacker.evm.bytecode.object },
  };

  if (registryV2) {
    result.EchoMemoryRegistryV2 = { abi: registryV2.abi, bytecode: '0x' + registryV2.evm.bytecode.object };
  }

  if (registryV3) {
    result.EchoMemoryRegistryV3 = { abi: registryV3.abi, bytecode: '0x' + registryV3.evm.bytecode.object };
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
  const proxy = output.contracts[proxyKey]['ERC1967Proxy'];
  return { abi: proxy.abi, bytecode: '0x' + proxy.evm.bytecode.object };
}

module.exports = { compileAll, compileProxy };
