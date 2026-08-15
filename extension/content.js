(function () {
  'use strict';

  const platform = location.hostname.includes('claude') ? 'Claude' : 'ChatGPT';

  function visibleText(node) {
    return node && node.innerText ? node.innerText.trim() : '';
  }

  function extractChatGpt() {
    return [...document.querySelectorAll('[data-message-author-role]')].map((node) => ({
      role: node.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant',
      text: visibleText(node),
    }));
  }

  function extractClaude() {
    const collected = [];
    const selectors = [
      ['[data-testid="user-message"]', 'user'],
      ['[data-is-streaming="false"]', 'assistant'],
      ['.font-claude-response', 'assistant'],
    ];
    for (const [selector, role] of selectors) {
      for (const node of document.querySelectorAll(selector)) collected.push({ node, role, text: visibleText(node) });
    }
    return collected
      .filter((item, index) => item.text && collected.findIndex((other) => other.text === item.text) === index)
      .sort((a, b) => (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(({ role, text }) => ({ role, text }));
  }

  function capture() {
    return {
      platform,
      title: document.title.replace(/\s*[|—-]\s*(Claude|ChatGPT).*$/i, '').trim(),
      url: location.href.split('?')[0],
      capturedAt: new Date().toISOString(),
      messages: platform === 'Claude' ? extractClaude() : extractChatGpt(),
    };
  }

  async function sync(manual) {
    button.dataset.state = 'busy';
    button.textContent = 'Syncing…';
    const result = await chrome.runtime.sendMessage({ type: 'ECHO_SYNC_CAPTURE', capture: capture(), manual });
    button.dataset.state = result && result.error ? 'error' : 'done';
    button.textContent = result && result.error ? 'Echo needs attention' : result && result.skipped ? 'Already in Echo' : 'Saved to Echo ✓';
    setTimeout(() => { button.dataset.state = ''; button.textContent = 'Save to Echo'; }, 3500);
  }

  const button = document.createElement('button');
  button.id = 'echo-capture-button';
  button.type = 'button';
  button.textContent = 'Save to Echo';
  button.title = 'Privately save this conversation to Echo';
  button.onclick = () => sync(true);
  document.documentElement.appendChild(button);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ECHO_CAPTURE') sync(Boolean(message.manual));
  });
}());
