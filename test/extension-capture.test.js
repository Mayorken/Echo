'use strict';

const { expect } = require('chai');
const { sanitizeText, fingerprint, mergeContext } = require('../extension/shared');

describe('Echo browser capture', function () {
  it('redacts common secrets before upload', function () {
    const result = sanitizeText('password: hunter2 API key: sk_live_abcdefghijklmnop card 4242 4242 4242 4242');
    expect(result).not.to.include('hunter2');
    expect(result).not.to.include('sk_live_');
    expect(result).not.to.include('4242 4242');
    expect(result).to.include('[REDACTED]');
  });

  it('produces a stable conversation fingerprint', function () {
    const capture = { platform: 'Claude', url: 'https://claude.ai/chat/1', messages: [{ role: 'user', text: 'Hello' }] };
    expect(fingerprint(capture)).to.equal(fingerprint({ ...capture }));
  });

  it('preserves structured context while adding conversation history', function () {
    const context = mergeContext({ projects: ['Echo'] }, {
      platform: 'ChatGPT',
      url: 'https://chatgpt.com/c/1',
      title: 'Architecture',
      capturedAt: '2026-08-15T10:00:00.000Z',
      messages: [{ role: 'user', text: 'Keep Filecoin behind the scenes.' }],
    });
    expect(context.projects).to.deep.equal(['Echo']);
    expect(context.conversation_summaries).to.have.length(1);
    expect(context.conversation_summaries[0].messages[0].text).to.equal('Keep Filecoin behind the scenes.');
  });

  it('deduplicates the same capture', function () {
    const capture = { platform: 'Claude', url: 'https://claude.ai/chat/1', title: 'Echo', messages: [{ role: 'user', text: 'Same' }] };
    const once = mergeContext({}, capture);
    const twice = mergeContext(once, capture);
    expect(twice.conversation_summaries).to.have.length(1);
  });
});
