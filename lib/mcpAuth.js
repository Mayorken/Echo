'use strict';

const crypto = require('crypto');

function createMcpAuth(encryptionKey) {
  const key = Buffer.from(encryptionKey);
  if (key.length !== 32) throw new Error('MCP auth requires a 32-byte encryption key');

  function seal(payload, ttlMs) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64url');
  }

  function open(token, expectedType) {
    try {
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== token) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8'));
      if (payload.type !== expectedType || payload.exp <= Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  return { seal, open };
}

function verifyPkce(verifier, expectedChallenge) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  const actual = crypto.createHash('sha256').update(verifier).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expectedChallenge || ''));
}

module.exports = { createMcpAuth, verifyPkce };
