const $ = (selector) => document.querySelector(selector);
const defaults = { apiUrl: 'https://echo-api-zivt.onrender.com', apiToken: '', recoveryKey: '', captureMode: 'review', lastStatus: 'Not connected', lastSyncAt: '' };

function renderStatus(data) {
  $('#status').textContent = data.lastStatus || 'Not connected';
  $('#lastSync').textContent = data.lastSyncAt ? `Last sync ${new Date(data.lastSyncAt).toLocaleString()}` : 'Never synced';
  $('#dot').classList.toggle('on', /connected|success/i.test(data.lastStatus || ''));
}

chrome.storage.local.get(defaults).then((data) => {
  for (const key of ['apiUrl', 'apiToken', 'recoveryKey', 'captureMode']) $('#' + key).value = data[key];
  renderStatus(data);
});

chrome.storage.onChanged.addListener((changes) => {
  chrome.storage.local.get(defaults).then(renderStatus);
});

$('#save').onclick = async () => {
  const values = {
    apiUrl: $('#apiUrl').value.trim().replace(/\/$/, ''),
    apiToken: $('#apiToken').value.trim(),
    recoveryKey: $('#recoveryKey').value.trim(),
    captureMode: $('#captureMode').value,
  };
  if (!/^https:\/\//.test(values.apiUrl) || !values.apiToken || !/^[0-9a-fA-F]{64}$/.test(values.recoveryKey)) {
    renderStatus({ lastStatus: 'Check your Echo credentials', lastSyncAt: '' });
    return;
  }
  $('#save').disabled = true;
  $('#save').textContent = 'Testing…';
  await chrome.storage.local.set(values);
  const result = await chrome.runtime.sendMessage({ type: 'ECHO_TEST_CONNECTION' });
  $('#save').disabled = false;
  $('#save').textContent = result.error ? 'Try again' : 'Connected ✓';
  renderStatus({ lastStatus: result.error || 'Connected to Echo', lastSyncAt: '' });
};
