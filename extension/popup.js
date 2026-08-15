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

$('#importConfig').onclick = () => {
  try {
    const config = JSON.parse($('#connectionConfig').value.trim());
    const token = String(config.authorization || '').replace(/^Bearer\s+/i, '');
    const recoveryKey = config['x-echo-key'] || config.recoveryKey || '';
    const apiUrl = config.echo_api_url || config.apiUrl || defaults.apiUrl;
    if (!token || !/^[0-9a-fA-F]{64}$/.test(recoveryKey)) throw new Error('Invalid configuration');
    $('#apiUrl').value = apiUrl;
    $('#apiToken').value = token;
    $('#recoveryKey').value = recoveryKey;
    renderStatus({ lastStatus: 'Connection imported — save to verify', lastSyncAt: '' });
  } catch {
    renderStatus({ lastStatus: 'Paste the full Developer API JSON', lastSyncAt: '' });
  }
};

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
