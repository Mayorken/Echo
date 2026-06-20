#!/usr/bin/env node
const { ethers } = require('ethers');
const wallet = ethers.Wallet.createRandom();

console.log('');
console.log('NEW TESTNET WALLET');
console.log('==================');
console.log('Address:    ', wallet.address);
console.log('PrivateKey: ', wallet.privateKey);
console.log('');
console.log('STEPS TO DEPLOY:');
console.log('');
console.log('1. Fund this wallet with test FIL:');
console.log('   https://faucet.calibration.fildev.network');
console.log('   Paste address:', wallet.address);
console.log('');
console.log('2. Set the private key (PowerShell):');
console.log('   $env:PRIVATE_KEY = "' + wallet.privateKey + '"');
console.log('');
console.log('3. Deploy:');
console.log('   npm run deploy');
