/**
 * deploy.js
 *
 * Deploys EchoMemoryRegistry to Filecoin's FEVM Calibration testnet.
 * Run with: node deploy.js
 *
 * Requires a funded Calibration-net wallet. Get test FIL from the
 * Calibration faucet, then set PRIVATE_KEY below via an environment
 * variable (never hardcode a real key).
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const CALIBRATION_RPC = 'https://api.calibration.node.glif.io/rpc/v1';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Set PRIVATE_KEY env var to a funded Calibration testnet wallet key');
  }

  // Compile fresh so the deployed bytecode always matches the current source.
  const source = fs.readFileSync(path.join(__dirname, 'contracts', 'EchoMemoryRegistry.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'EchoMemoryRegistry.sol': { content: source } },
    settings: { evmVersion: 'london', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const compiled = output.contracts['EchoMemoryRegistry.sol']['EchoMemoryRegistry'];

  const provider = new ethers.JsonRpcProvider(CALIBRATION_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  const factory = new ethers.ContractFactory(compiled.abi, compiled.evm.bytecode.object, wallet);
  console.log('Deploying EchoMemoryRegistry to Filecoin Calibration testnet...');
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  console.log('Deployed at:', await contract.getAddress());
  console.log('Save this address — the SDK and prototype both need it.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
