const $ = (id) => document.getElementById(id);
const stored = await chrome.storage.local.get('host'); if (stored.host) $('host').value = stored.host;
$('pair').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const url = new URL($('host').value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('主机需要 HTTPS，本机可使用 HTTP');
    if (!await chrome.permissions.request({ origins: [url.origin + '/*'] })) throw new Error('未授权连接该主机');
    const response = await fetch(url.origin + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value.trim().toUpperCase(), kind: 'browser' }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    await chrome.storage.local.set({ host: url.origin, token: result.token }); $('code').value = ''; $('status').textContent = '已配对。请为要操作的网站单独授权。'; await chrome.runtime.sendMessage('paired');
  } catch (e) { $('status').textContent = e.message; }
};
$('allow').onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); const url = new URL(tab.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('当前页面不支持授权');
    const granted = await chrome.permissions.request({ origins: [url.origin + '/*'] }); $('status').textContent = granted ? `已允许 ${url.origin}` : '未授权';
  } catch (e) { $('status').textContent = e.message; }
};
$('disconnect').onclick = async () => { await chrome.storage.local.remove(['host', 'token']); $('status').textContent = '已断开'; };
