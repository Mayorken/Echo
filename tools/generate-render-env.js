#!/usr/bin/env node
const { randomBytes } = require('crypto');
const { writeFileSync } = require('fs');
const { resolve } = require('path');
const { ethers } = require('ethers');

const outputPath = resolve(__dirname, '..', '.env.render.local');
const wallet = ethers.Wallet.createRandom();
const encryptionKey = randomBytes(32).toString('hex');

writeFileSync(outputPath, [
  '# Echo Render secrets — never commit or share this file',
  `# Service wallet address (safe to share): ${wallet.address}`,
  `PRIVATE_KEY=${wallet.privateKey}`,
  `SYNAPSE_PRIVATE_KEY=${wallet.privateKey}`,
  `ENCRYPTION_KEY=${encryptionKey}`,
  '',
].join('\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });

console.log(`Created ${outputPath}`);
console.log(`Service wallet address: ${wallet.address}`);
