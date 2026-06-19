const solc = require('solc');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

/**
 * Runs the solc compiler against an arbitrary set of Solidity sources.
 * Every caller that previously hand-rolled its own solc invocation now
 * goes through this single path, keeping the evmVersion pin and error
 * handling in one place.
 *
 * @param {Record<string, {content: string}>} sources solc-style source map
 * @returns {object} parsed solc output (the `contracts` key is what callers need)
 */
function compileSources(sources) {
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

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
 * Used by compile.js and deploy.js where the test-only attacker is irrelevant.
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
 * Compiles both the main contract and the test-only attacker helper,
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
  };

  const { output } = compileSources(sources);

  return {
    EchoMemoryRegistry: extractContract(output, 'EchoMemoryRegistry.sol', 'EchoMemoryRegistry'),
    ReentrancyAttacker: extractContract(output, 'ReentrancyAttacker.sol', 'ReentrancyAttacker'),
  };
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

module.exports = { compileSources, compileRegistry, compileAll, deployContract };
