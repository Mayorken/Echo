#!/usr/bin/env node
/**
 * tools/get-lighthouse-key.js
 *
 * Generates a Lighthouse API key by signing an auth challenge with the
 * wallet in .env, then writes LIGHTHOUSE_API_KEY back into .env.
 *
 *   node tools/get-lighthouse-key.js
 */

'use strict';

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const { ethers } = require('ethers');

const BASE    = 'https://api.lighthouse.storage';
const ENV_PATH = path.join(__dirname, '..', '.env');

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  console.log('Wallet:', wallet.address);

  // 1. Fetch the challenge message (returns a JSON-encoded string)
  console.log('Requesting auth challenge from Lighthouse...');
  const msgRes = await fetch(`${BASE}/api/auth/get_message?publicKey=${wallet.address}`);
  if (!msgRes.ok) throw new Error(`get_message failed: ${msgRes.status}`);
  const message = await msgRes.json();
  console.log('Challenge:', message);

  // 2. Sign it
  const signed = await wallet.signMessage(message);
  console.log('Signed.');

  // 3. Exchange signature for API key
  console.log('Requesting API key...');
  const keyRes = await fetch(`${BASE}/api/auth/create_api_key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: wallet.address, signedMessage: signed }),
  });
  if (!keyRes.ok) {
    const err = await keyRes.json().catch(() => ({}));
    throw new Error(`create_api_key failed ${keyRes.status}: ${JSON.stringify(err)}`);
  }
  const apiKey = await keyRes.json();
  console.log('\nLighthouse API key:', apiKey);

  // 4. Write it back into .env
  let envContent = fs.readFileSync(ENV_PATH, 'utf8');
  if (envContent.includes('LIGHTHOUSE_API_KEY=')) {
    envContent = envContent.replace(/^LIGHTHOUSE_API_KEY=.*$/m, `LIGHTHOUSE_API_KEY=${apiKey}`);
  } else {
    envContent += `\nLIGHTHOUSE_API_KEY=${apiKey}\n`;
  }
  fs.writeFileSync(ENV_PATH, envContent, 'utf8');
  console.log('.env updated — you can now run: npm start');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
