'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const { createMcpAuth, verifyPkce } = require('../lib/mcpAuth');

describe('MCP OAuth token protection', function () {
  let auth;

  beforeEach(function () {
    auth = createMcpAuth(crypto.randomBytes(32));
  });

  it('seals and opens a typed token', function () {
    const token = auth.seal({ type: 'access', userAddress: '0x123', recoveryKey: 'ab'.repeat(32) }, 1000);
    const value = auth.open(token, 'access');
    expect(value.userAddress).to.equal('0x123');
    expect(value.recoveryKey).to.equal('ab'.repeat(32));
  });

  it('rejects tampered, expired, and wrong-type tokens', function () {
    const token = auth.seal({ type: 'code' }, 1000);
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(auth.open(tampered, 'code')).to.equal(null);
    expect(auth.open(token, 'access')).to.equal(null);
    const expired = auth.seal({ type: 'code' }, -1);
    expect(auth.open(expired, 'code')).to.equal(null);
  });

  it('verifies an OAuth PKCE S256 challenge', function () {
    const verifier = 'echo-connector-verifier-abcdefghijklmnopqrstuvwxyz1234567890';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge)).to.equal(true);
    expect(verifyPkce(verifier + 'wrong', challenge)).to.equal(false);
  });
});
