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
const { compileRegistry, deployContract } = require('./compile-helper');

const CALIBRATION_RPC = 'https://api.calibration.node.glif.io/rpc/v1';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Set PRIVATE_KEY env var to a funded Calibration testnet wallet key');
  }

  const { contract: compiled } = compileRegistry();

  const provider = new ethers.JsonRpcProvider(CALIBRATION_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('Deploying EchoMemoryRegistry to Filecoin Calibration testnet...');
  const contract = await deployContract(compiled, wallet);

  console.log('Deployed at:', await contract.getAddress());
  console.log('Save this address — the SDK and prototype both need it.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
