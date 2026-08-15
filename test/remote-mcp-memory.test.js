'use strict';

const { expect } = require('chai');
const { mergeContext, containsSensitiveFields } = require('../lib/remoteMcp');

describe('remote MCP automatic memory', function () {
  it('merges nested facts without erasing existing context', function () {
    const merged = mergeContext(
      { projects: { Echo: { status: 'active', stack: ['Filecoin'] } }, preferences: { tone: 'concise' } },
      { projects: { Echo: { stack: ['MCP'], nextStep: 'dashboard' } } },
    );
    expect(merged.projects.Echo.status).to.equal('active');
    expect(merged.projects.Echo.stack).to.deep.equal(['Filecoin', 'MCP']);
    expect(merged.projects.Echo.nextStep).to.equal('dashboard');
    expect(merged.preferences.tone).to.equal('concise');
  });

  it('deduplicates repeated array memories', function () {
    expect(mergeContext(['Echo', 'Murmur'], ['Echo', 'Vela'])).to.deep.equal(['Echo', 'Murmur', 'Vela']);
  });

  it('detects credential-like fields before saving', function () {
    expect(containsSensitiveFields({ projects: ['Echo'] })).to.equal(false);
    expect(containsSensitiveFields({ account: { privateKey: '0xabc' } })).to.equal(true);
    expect(containsSensitiveFields({ api_token: 'secret' })).to.equal(true);
  });
});
