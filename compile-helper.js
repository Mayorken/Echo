const solc = require('solc');
const fs = require('fs');
const path = require('path');

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
  };

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    if (fatal.length) {
      fatal.forEach((e) => console.error(e.formattedMessage));
      throw new Error('Solidity compilation failed');
    }
  }

  const registry = output.contracts['EchoMemoryRegistry.sol']['EchoMemoryRegistry'];
  const attacker = output.contracts['ReentrancyAttacker.sol']['ReentrancyAttacker'];

  return {
    EchoMemoryRegistry: { abi: registry.abi, bytecode: '0x' + registry.evm.bytecode.object },
    ReentrancyAttacker: { abi: attacker.abi, bytecode: '0x' + attacker.evm.bytecode.object },
  };
}

module.exports = { compileAll };
