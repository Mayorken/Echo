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

const keyStore = new Map(); // apiKey => { userAddress, createdAt }

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
  keyStore.set(apiKey, { userAddress, createdAt: new Date().toISOString() });
  return apiKey;
}

/**
 * Look up the user address an API key belongs to.
 * @param {string} apiKey
 * @returns {{ userAddress: string, createdAt: string } | null}
 */
function validateApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return null;
  return keyStore.get(apiKey) || null;
}

/**
 * Revoke an API key so it can no longer be used.
 * @param {string} apiKey
 * @returns {boolean} true if a key was found and removed
 */
function revokeApiKey(apiKey) {
  return keyStore.delete(apiKey);
}

module.exports = { generateApiKey, validateApiKey, revokeApiKey };
