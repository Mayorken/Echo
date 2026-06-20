/**
 * deploy.js
 *
 * Deploys EchoMemoryRegistryV3 behind an ERC1967 UUPS proxy to Filecoin's
 * FEVM Calibration testnet. The proxy address is the permanent address
 * AI tools integrate against — upgrades swap the implementation without
 * changing this address.
 *
 * Run with: npm run deploy
 *
 * Requires a funded Calibration-net wallet. Get test FIL from:
 *   https://faucet.calibration.fildev.network
 *
 * Set your private key:  export PRIVATE_KEY=0x...
 * Optional RPC override: export RPC_URL=https://...
 */

const { ethers } = require('ethers');
const { compileAll, compileProxy } = require('./compile-helper');

const CALIBRATION_RPC = process.env.RPC_URL || 'https://api.calibration.node.glif.io/rpc/v1';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: PRIVATE_KEY env var is not set.');
    console.error('');
    console.error('  Windows PowerShell:  $env:PRIVATE_KEY = "0x..."');
    console.error('  Mac/Linux:           export PRIVATE_KEY=0x...');
    console.error('');
    console.error('Get test FIL at: https://faucet.calibration.fildev.network');
    process.exit(1);
  }

  console.log('Compiling contracts...');
  const contracts = compileAll();
  const proxyArtifact = compileProxy();
  const v3 = contracts.EchoMemoryRegistryV3;

  if (!v3) {
    console.error('EchoMemoryRegistryV3 not found in compiled output. Run: npm run compile');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(CALIBRATION_RPC, undefined, { cacheTimeout: -1 });
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('');
  console.log('Network:  Filecoin Calibration testnet');
  console.log('RPC:     ', CALIBRATION_RPC);
  console.log('Wallet:  ', wallet.address);

  const balance = await provider.getBalance(wallet.address);
  console.log('Balance: ', ethers.formatEther(balance), 'tFIL');
  console.log('');

  if (balance === 0n) {
    console.error('Wallet has 0 tFIL. Get test FIL at:');
    console.error('  https://faucet.calibration.fildev.network');
    process.exit(1);
  }

  // 1. Deploy the V3 implementation
  console.log('Step 1/3 — Deploying EchoMemoryRegistryV3 implementation...');
  const implFactory = new ethers.ContractFactory(v3.abi, v3.bytecode, wallet);
  const impl = await implFactory.deploy();
  console.log('  Tx submitted:', impl.deploymentTransaction().hash);
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log('  Implementation:', implAddress);

  // 2. Encode initialize(owner)
  const initData = impl.interface.encodeFunctionData('initialize', [wallet.address]);

  // 3. Deploy ERC1967 proxy
  console.log('');
  console.log('Step 2/3 — Deploying ERC1967 proxy...');
  const proxyFactory = new ethers.ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode, wallet);
  const proxy = await proxyFactory.deploy(implAddress, initData);
  console.log('  Tx submitted:', proxy.deploymentTransaction().hash);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log('  Proxy:', proxyAddress);

  // 4. Verify
  console.log('');
  console.log('Step 3/3 — Verifying deployment...');
  const contract = new ethers.Contract(proxyAddress, v3.abi, provider);
  const version = await contract.version();
  const owner   = await contract.owner();
  console.log('  version():', version.toString());
  console.log('  owner():  ', owner);

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           DEPLOYMENT COMPLETE ✓                  ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║ Proxy (use this address everywhere):             ║');
  console.log('║  ' + proxyAddress.padEnd(48) + '║');
  console.log('║                                                  ║');
  console.log('║ Implementation:                                  ║');
  console.log('║  ' + implAddress.padEnd(48) + '║');
  console.log('║                                                  ║');
  console.log('║ Contract version: ' + version.toString().padEnd(31) + '║');
  console.log('║ Owner:            ' + owner.slice(0, 10) + '...' + owner.slice(-6).padEnd(23) + '║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('Set these for the SDK, keeper, and integrations:');
  console.log('');
  console.log('  $env:CONTRACT_ADDRESS = "' + proxyAddress + '"');
  console.log('  $env:RPC_URL          = "' + CALIBRATION_RPC + '"');
  console.log('');
  console.log('Explorer:');
  console.log('  https://calibration.filscan.io/address/' + proxyAddress);
}

main().catch((err) => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
