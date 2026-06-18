/**
 * lib/crypto.js
 *
 * Real AES-256-GCM encryption for Echo memory files, replacing the
 * passthrough placeholder that was in earlier versions of echo-sdk.js.
 *
 * Uses the Web Crypto API when available (any modern browser, which is
 * where this SDK actually runs inside an AI companion app), and falls back
 * to Node's built-in `crypto` module so the same file is testable directly
 * in Node without a bundler.
 *
 * The encryption key never leaves the user's device and never gets written
 * on-chain or to Filecoin — only the resulting ciphertext does. Losing the
 * key means losing access to the memory file; this module doesn't attempt
 * key recovery or escrow, by design.
 */

const IV_LENGTH = 12; // bytes, standard for AES-GCM

const hasWebCrypto = typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;

/** Generate a fresh random 256-bit key. */
async function generateKey() {
  if (hasWebCrypto) {
    const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const raw = await globalThis.crypto.subtle.exportKey('raw', key);
    return new Uint8Array(raw);
  }
  const nodeCrypto = require('crypto');
  return new Uint8Array(nodeCrypto.randomBytes(32));
}

/**
 * Encrypt plaintext bytes under a 256-bit key.
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} keyBytes 32 raw bytes
 * @returns {Promise<Uint8Array>} iv (12 bytes) || ciphertext || authTag (16 bytes), concatenated
 */
async function encrypt(plaintext, keyBytes) {
  if (hasWebCrypto) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const ciphertextWithTag = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return concat(iv, new Uint8Array(ciphertextWithTag));
  }

  const nodeCrypto = require('crypto');
  const iv = nodeCrypto.randomBytes(IV_LENGTH);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(keyBytes), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return concat(new Uint8Array(iv), new Uint8Array(ciphertext), new Uint8Array(tag));
}

/**
 * Decrypt bytes produced by encrypt(). Throws if the key is wrong or the
 * data was tampered with (the GCM auth tag check fails closed).
 * @param {Uint8Array} packed iv || ciphertext || authTag
 * @param {Uint8Array} keyBytes 32 raw bytes
 * @returns {Promise<Uint8Array>} plaintext
 */
async function decrypt(packed, keyBytes) {
  const iv = packed.slice(0, IV_LENGTH);

  if (hasWebCrypto) {
    const ciphertextWithTag = packed.slice(IV_LENGTH);
    const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertextWithTag);
    return new Uint8Array(plaintext);
  }

  const nodeCrypto = require('crypto');
  const tag = packed.slice(packed.length - 16);
  const ciphertext = packed.slice(IV_LENGTH, packed.length - 16);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(keyBytes), Buffer.from(iv));
  decipher.setAuthTag(Buffer.from(tag));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
  return new Uint8Array(plaintext);
}

function concat(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

module.exports = { generateKey, encrypt, decrypt };
