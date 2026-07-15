#!/usr/bin/env node

/**
 * tools/funding-bridge.js
 *
 * Standalone funding bridge: connects any payment source to the on-chain
 * fundRenewal() function so users or organizations can top up a vault's
 * perpetual-storage endowment from whatever payment method they control.
 *
 * The bridge runs locally in the user's environment — nothing is sent to a
 * central server. Keeping this logic in the user's hands is what makes it a
 * "tool" rather than a subscription service.
 *
 * Usage — wallet-funded (simplest):
 *
 *   RPC_URL=https://api.calibration.node.glif.io/rpc/v1 \
 *   CONTRACT_ADDRESS=0x... \
 *   PRIVATE_KEY=0x... \
 *   node tools/funding-bridge.js --amount 0.5
 *
 *   # Fund a specific address (e.g. a team member's vault):
 *   node tools/funding-bridge.js --amount 0.5 --target 0xABCD...
 *
 * Usage — Stripe webhook (organization path):
 *
 *   STRIPE_WEBHOOK_SECRET=whsec_... \
 *   RPC_URL=... CONTRACT_ADDRESS=... PRIVATE_KEY=... \
 *   node tools/funding-bridge.js --stripe-webhook --port 4242
 *
 *   Then configure your Stripe webhook to POST payment_intent.succeeded
 *   events to http://your-server:4242/stripe-webhook. The bridge reads the
 *   metadata.echoAddress field from the PaymentIntent to know which vault to
 *   fund, and metadata.filAmount to know how much.
 *
 * Environment variables:
 *   RPC_URL            — FEVM RPC endpoint
 *   CONTRACT_ADDRESS   — Deployed EchoMemoryRegistry proxy address
 *   PRIVATE_KEY        — Wallet that holds FIL to fund with
 *   STRIPE_WEBHOOK_SECRET — Stripe signing secret (Stripe path only)
 *   PORT               — Webhook listener port (default 4242, Stripe path only)
 */

const { ethers } = require('ethers');
const registryAbi = require('../EchoMemoryRegistry.abi.json');

// =========================================================================
// Core: call fundRenewal() on-chain for a given address
// =========================================================================

/**
 * Fund a vault's renewal endowment on-chain.
 *
 * @param {object} config
 * @param {string} config.rpcUrl
 * @param {string} config.contractAddress
 * @param {string} config.privateKey Funder's private key (holds the FIL)
 * @param {string} config.targetAddress Vault owner to fund (defaults to funder's own address)
 * @param {string} config.amountInFil Amount of FIL to deposit (e.g. "0.5")
 * @param {function} [config.log]
 * @returns {Promise<{txHash: string, from: string, target: string, amount: string}>}
 */
async function fundVault(config) {
  const log = config.log || console.log;

  if (!config.rpcUrl) throw new Error('rpcUrl is required');
  if (!config.contractAddress) throw new Error('contractAddress is required');
  if (!config.privateKey) throw new Error('privateKey is required');
  if (!config.amountInFil || isNaN(Number(config.amountInFil)) || Number(config.amountInFil) <= 0) {
    throw new Error('amountInFil must be a positive number string (e.g. "0.5")');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const signer = new ethers.Wallet(config.privateKey, provider);
  const contract = new ethers.Contract(config.contractAddress, registryAbi, signer);

  const target = config.targetAddress || signer.address;
  const value = ethers.parseEther(config.amountInFil);

  log(`[funding-bridge] Funding vault for ${target} with ${config.amountInFil} FIL...`);

  // fundRenewal() on V1 funds the caller's own vault (msg.sender).
  // To fund a different address's vault, the signer must BE that address,
  // or the owner must call fundRenewal() themselves. This bridge script is
  // intended to be run by the vault owner using their own key.
  if (target.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Cannot fund a different address's vault with this key.\n` +
      `The PRIVATE_KEY must belong to the vault owner (${target}).\n` +
      `Each user runs this bridge script with their own key.`
    );
  }

  const tx = await contract.fundRenewal({ value });
  log(`[funding-bridge] Transaction submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`[funding-bridge] Confirmed in block ${receipt.blockNumber}`);

  const newBalance = await contract.renewalBalanceOf(signer.address);
  log(`[funding-bridge] New renewal balance: ${ethers.formatEther(newBalance)} FIL`);

  return {
    txHash: tx.hash,
    from: signer.address,
    target: signer.address,
    amount: config.amountInFil,
    newBalanceFil: ethers.formatEther(newBalance),
  };
}

// =========================================================================
// Stripe webhook path (optional, requires 'express' and 'stripe' packages)
//
// This path lets an organization wire their Stripe payment flow to Echo
// vault funding. When a payment succeeds, the bridge calls fundRenewal()
// on behalf of the address stored in the PaymentIntent's metadata.
//
// Required Stripe PaymentIntent metadata fields:
//   echoAddress — the vault owner's Ethereum address to fund
//   filAmount   — amount in FIL as a string (e.g. "0.5")
//
// The organization controls the Stripe account and the on-chain wallet that
// holds the FIL. Neither the Stripe API key nor the private key is exposed
// to users — this runs in the organization's own environment.
// =========================================================================

async function startStripeWebhook(config) {
  const log = config.log || console.log;

  let express, stripe;
  try {
    express = require('express');
  } catch {
    throw new Error('express is not installed. Run: npm install express');
  }
  try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  } catch {
    throw new Error('stripe is not installed. Run: npm install stripe');
  }

  const webhookSecret = config.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is required');

  const app = express();

  // Stripe requires the raw body for signature verification
  // Track processed payment intent IDs to guard against Stripe's at-least-once
  // delivery (it retries webhooks on 5xx). A plain in-memory Set is sufficient
  // for single-process deployments; use Redis or a DB for multi-instance setups.
  const processedIntents = new Set();

  app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (err) {
      log(`[funding-bridge] Stripe signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;

      // Idempotency guard: Stripe retries on 5xx, so the same intent can arrive twice.
      if (processedIntents.has(intent.id)) {
        log(`[funding-bridge] Duplicate delivery of ${intent.id} — skipping`);
        return res.json({ received: true });
      }
      const echoAddress = intent.metadata && intent.metadata.echoAddress;
      const filAmount = intent.metadata && intent.metadata.filAmount;

      if (!echoAddress || !filAmount) {
        log(`[funding-bridge] PaymentIntent ${intent.id} missing echoAddress or filAmount metadata — skipping`);
        return res.json({ received: true });
      }

      if (!ethers.isAddress(echoAddress)) {
        log(`[funding-bridge] Invalid echoAddress in metadata: ${echoAddress}`);
        return res.json({ received: true });
      }

      log(`[funding-bridge] Payment succeeded for ${echoAddress} — funding ${filAmount} FIL`);

      try {
        // Note: because fundRenewal() credits msg.sender's vault, the bridge
        // wallet and the echoAddress must be the same. For org-managed vaults
        // (where the bridge wallet IS the vault owner), this works directly.
        // For funding a user's own vault, the user must run the bridge themselves.
        const result = await fundVault({
          ...config,
          targetAddress: echoAddress,
          amountInFil: filAmount,
        });
        processedIntents.add(intent.id);
        log(`[funding-bridge] Funded tx=${result.txHash} newBalance=${result.newBalanceFil} FIL`);
      } catch (fundErr) {
        log(`[funding-bridge] Funding failed for ${echoAddress}: ${fundErr.message}`);
        return res.status(500).json({ received: false, error: 'On-chain funding failed' });
      }
    }

    res.json({ received: true });
  });

  const port = config.port || Number(process.env.PORT) || 4242;
  app.listen(port, () => {
    log(`[funding-bridge] Stripe webhook listener running on port ${port}`);
    log(`[funding-bridge] Configure Stripe to POST payment_intent.succeeded to /stripe-webhook`);
  });
}

// =========================================================================
// CLI entry point
// =========================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const isStripeMode = args.includes('--stripe-webhook');
  const amountIdx = args.indexOf('--amount');
  const targetIdx = args.indexOf('--target');

  const config = {
    rpcUrl: process.env.RPC_URL,
    contractAddress: process.env.CONTRACT_ADDRESS,
    privateKey: process.env.PRIVATE_KEY,
    amountInFil: amountIdx !== -1 ? args[amountIdx + 1] : null,
    targetAddress: targetIdx !== -1 ? args[targetIdx + 1] : null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    port: Number(process.env.PORT) || 4242,
  };

  if (!config.rpcUrl || !config.contractAddress || !config.privateKey) {
    console.error('Error: RPC_URL, CONTRACT_ADDRESS, and PRIVATE_KEY env vars are required');
    process.exit(1);
  }

  if (isStripeMode) {
    startStripeWebhook(config).catch((err) => { console.error(err.message); process.exit(1); });
  } else {
    if (!config.amountInFil) {
      console.error('Error: --amount <fil> is required in wallet mode');
      console.error('Example: node tools/funding-bridge.js --amount 0.5');
      process.exit(1);
    }
    fundVault(config)
      .then((result) => {
        console.log('\nFunding complete:');
        console.log(`  Tx hash:     ${result.txHash}`);
        console.log(`  Amount:      ${result.amount} FIL`);
        console.log(`  New balance: ${result.newBalanceFil} FIL`);
      })
      .catch((err) => { console.error(err.message); process.exit(1); });
  }
}

module.exports = { fundVault, startStripeWebhook };
