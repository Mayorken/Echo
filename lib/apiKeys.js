/**
 * lib/apiKeys.js
 *
 * API key issuance and validation for the hosted REST API. Lets a developer
 * hit Echo's hosted endpoints on a user's behalf with a single bearer token
 * instead of a wallet — the key maps to a user address that has already
 * granted the hosted service read and/or write access on-chain (see
 * grantAccess() / grantWriteAccess() in echo-sdk.js).
 *
 * Storage is an in-memory Map, matching this project's existing pattern for
 * swappable-later pieces (see lib/storage.js's test fake). A real deployment
 * behind more than one process needs a real datastore (Redis/Postgres/etc.)
 * instead — keys wouldn't survive a restart or be shared across instances.
 */

'use strict';

const crypto = require('crypto');

const keyStore = new Map(); // apiKey => { userAddress, createdAt, expiresAt }
const API_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const challengeStore = new Map(); // address => { nonce, message, expiresAt }
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createAuthChallenge(userAddress) {
  const normalized = userAddress.toLowerCase();
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const message = `Echo authentication\nAddress: ${normalized}\nNonce: ${nonce}`;
  challengeStore.set(normalized, { nonce, message, expiresAt });
  return { message, expiresAt: new Date(expiresAt).toISOString() };
}

function consumeAuthChallenge(userAddress) {
  const normalized = userAddress.toLowerCase();
  const challenge = challengeStore.get(normalized);
  challengeStore.delete(normalized);
  if (!challenge || challenge.expiresAt < Date.now()) return null;
  return challenge;
}

/**
 * Issue a new API key for a user address.
 * @param {string} userAddress
 * @returns {string} apiKey — a 32-byte hex token, prefixed for readability
 */
function generateApiKey(userAddress) {
  if (typeof userAddress !== 'string' || !userAddress) {
    throw new Error('generateApiKey: userAddress must be a non-empty string');
  }
  const apiKey = 'echo_' + crypto.randomBytes(32).toString('hex');
  keyStore.set(apiKey, {
    userAddress,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + API_KEY_TTL_MS).toISOString(),
  });
  return apiKey;
}

/**
 * Look up the user address an API key belongs to.
 * @param {string} apiKey
 * @returns {{ userAddress: string, createdAt: string } | null}
 */
function validateApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return null;
  const record = keyStore.get(apiKey);
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= Date.now()) {
    keyStore.delete(apiKey);
    return null;
  }
  return record;
}

/**
 * Revoke an API key so it can no longer be used.
 * @param {string} apiKey
 * @returns {boolean} true if a key was found and removed
 */
function revokeApiKey(apiKey) {
  return keyStore.delete(apiKey);
}

module.exports = {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  createAuthChallenge,
  consumeAuthChallenge,
};
