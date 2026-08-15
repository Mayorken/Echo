importScripts('shared.js');

const DEFAULTS = {
  apiUrl: 'https://echo-api-zivt.onrender.com',
  apiToken: '',
  recoveryKey: '',
  captureMode: 'review',
  lastSyncAt: '',
  lastStatus: 'Not connected',
  fingerprints: {},
};

async function settings() {
  return { ...DEFAULTS, ...await chrome.storage.local.get(DEFAULTS) };
}

async function setStatus(lastStatus, extra = {}) {
  await chrome.storage.local.set({ lastStatus, ...extra });
}

async function echoRequest(config, path, options = {}) {
  const response = await fetch(config.apiUrl.replace(/\/$/, '') + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
      'X-Echo-Key': config.recoveryKey,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Echo returned ${response.status}`);
  return body;
}

async function syncCapture(capture, manual) {
  const config = await settings();
  if (!manual && config.captureMode !== 'automatic') return { skipped: 'Automatic sync is off' };
  if (!config.apiToken || !/^[0-9a-fA-F]{64}$/.test(config.recoveryKey)) {
    throw new Error('Connect the extension to Echo first');
  }
  const messages = EchoCapture.normalizeMessages(capture.messages);
  if (!messages.length) throw new Error('No conversation messages found');
  const normalized = { ...capture, messages };
  const id = EchoCapture.fingerprint(normalized);
  if (config.fingerprints[capture.url] === id) return { skipped: 'Already up to date' };

  await setStatus('Syncing…');
  const current = await echoRequest(config, '/v1/context');
  const context = EchoCapture.mergeContext(current.context, normalized);
  const saved = await echoRequest(config, '/v1/context', {
    method: 'POST',
    body: JSON.stringify({ context }),
  });
  const fingerprints = { ...config.fingerprints, [capture.url]: id };
  const lastSyncAt = new Date().toISOString();
  await setStatus('Synced successfully', { fingerprints, lastSyncAt });
  return { success: true, cid: saved.cid, lastSyncAt };
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ ...DEFAULTS, ...await chrome.storage.local.get(DEFAULTS) });
  chrome.alarms.create('echo-auto-sync', { periodInMinutes: 30 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('echo-auto-sync', { periodInMinutes: 30 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'echo-auto-sync') return;
  const config = await settings();
  if (config.captureMode !== 'automatic') return;
  const tabs = await chrome.tabs.query({ url: ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'ECHO_CAPTURE', manual: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ECHO_SYNC_CAPTURE') {
    syncCapture(message.capture, Boolean(message.manual))
      .then(sendResponse)
      .catch(async (error) => { await setStatus(error.message); sendResponse({ error: error.message }); });
    return true;
  }
  if (message.type === 'ECHO_TEST_CONNECTION') {
    settings().then(async (config) => {
      await echoRequest(config, '/v1/context');
      await setStatus('Connected to Echo');
      sendResponse({ success: true });
    }).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});
