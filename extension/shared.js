(function (root) {
  'use strict';

  const SECRET_PATTERNS = [
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
    /\b(?:api[_ -]?key|private[_ -]?key|secret|password)\s*[:=]\s*\S+/gi,
    /\b0x[a-fA-F0-9]{64}\b/g,
    /\b(?:\d[ -]*?){13,19}\b/g,
    /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  ];

  function sanitizeText(value) {
    let text = String(value || '').replace(/\s+/g, ' ').trim();
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
    return text.slice(0, 12000);
  }

  function normalizeMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
      .map((message) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        text: sanitizeText(message.text),
      }))
      .filter((message) => message.text.length > 1)
      .slice(-40);
  }

  function fingerprint(capture) {
    const source = `${capture.platform}|${capture.url}|${capture.messages.map((m) => `${m.role}:${m.text}`).join('|')}`;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function mergeContext(existing, capture) {
    const base = existing && typeof existing === 'object' ? { ...existing } : {};
    const summaries = Array.isArray(base.conversation_summaries) ? [...base.conversation_summaries] : [];
    const clean = {
      id: fingerprint(capture),
      platform: capture.platform,
      title: sanitizeText(capture.title || 'Untitled conversation').slice(0, 180),
      source_url: capture.url,
      captured_at: capture.capturedAt || new Date().toISOString(),
      messages: normalizeMessages(capture.messages),
    };
    const withoutDuplicate = summaries.filter((item) => item && item.id !== clean.id);
    base.conversation_summaries = [...withoutDuplicate, clean].slice(-50);
    base.last_automatic_sync = clean.captured_at;
    return base;
  }

  const api = { sanitizeText, normalizeMessages, fingerprint, mergeContext };
  root.EchoCapture = api;
  if (typeof module !== 'undefined') module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
