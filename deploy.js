/**
 * deploy.js
 *
 * Deploys EchoMemoryRegistry behind an ERC1967 UUPS proxy to Filecoin's
 * FEVM Calibration testnet. The proxy address is the permanent address
 * AI tools integrate against — upgrades swap the implementation without
 * changing this address.
 *
 * Run with: node deploy.js
 *
 * Requires a funded Calibration-net wallet. Get test FIL from the
 * Calibration faucet, then set PRIVATE_KEY via an environment variable
 * (never hardcode a real key).
 */

const { ethers } = require('ethers');
const { compileAll, compileProxy } = require('./compile-helper');

const CALIBRATION_RPC = 'https://api.calibration.node.glif.io/rpc/v1';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Set PRIVATE_KEY env var to a funded Calibration testnet wallet key');
  }

  const contracts = compileAll();
  const proxyArtifact = compileProxy();

  const provider = new ethers.JsonRpcProvider(CALIBRATION_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);

  // 1. Deploy the implementation contract
  console.log('Deploying EchoMemoryRegistry implementation...');
  const implFactory = new ethers.ContractFactory(
    contracts.EchoMemoryRegistry.abi,
    contracts.EchoMemoryRegistry.bytecode,
    wallet
  );
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log('Implementation deployed at:', implAddress);

  // 2. Encode initialize(owner) call data
  const initData = impl.interface.encodeFunctionData('initialize', [wallet.address]);

  // 3. Deploy the ERC1967 proxy pointing to the implementation
  console.log('Deploying ERC1967 proxy...');
  const proxyFactory = new ethers.ContractFactory(
    proxyArtifact.abi,
    proxyArtifact.bytecode,
    wallet
  );
  const proxy = await proxyFactory.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();

  console.log('');
  console.log('=== DEPLOYMENT COMPLETE ===');
  console.log('Proxy address (use this):', proxyAddress);
  console.log('Implementation address:  ', implAddress);
  console.log('Owner:                   ', wallet.address);
  console.log('');
  console.log('The proxy address is permanent — AI tools integrate against it.');
  console.log('To upgrade: deploy a new implementation and call upgradeToAndCall().');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
