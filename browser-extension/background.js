let polling = false;
async function allowed(url) {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && await chrome.permissions.contains({ origins: [parsed.origin + '/*'] }); }
  catch { return false; }
}
async function perform(action) {
  if (action.action === 'tabs') {
    const tabs = await chrome.tabs.query({}); const results = [];
    for (const tab of tabs) if (await allowed(tab.url)) results.push({ id: tab.id, title: tab.title, url: tab.url });
    return results;
  }
  if (!Number.isSafeInteger(action.tabId)) throw new Error('A tab ID is required');
  const tab = await chrome.tabs.get(action.tabId);
  if (!await allowed(tab.url)) throw new Error('Grant access to this website from the extension popup first');
  if (action.action === 'navigate') {
    if (!await allowed(action.url)) throw new Error('Destination site is not authorized');
    await chrome.tabs.update(tab.id, { url: action.url }); return 'Navigated';
  }
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (command) => {
    if (command.action === 'read') {
      return { title: document.title, url: location.href, selection: window.getSelection()?.toString().slice(0, 8000), text: document.body.innerText.slice(0, 20000), controls: Array.from(document.querySelectorAll('a,button,input,textarea,select')).slice(0, 120).map((e) => ({ tag: e.tagName, id: e.id, name: e.getAttribute('name'), label: e.getAttribute('aria-label') || e.textContent?.slice(0, 100), type: e.getAttribute('type') })) };
    }
    if (typeof command.selector !== 'string' || command.selector.length > 2000) throw new Error('Invalid selector');
    const element = document.querySelector(command.selector); if (!element) throw new Error('Element not found');
    if (command.action === 'click') { element.click(); return 'Clicked'; }
    if (command.action === 'type') {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Choose a text input');
      if (typeof command.text !== 'string' || command.text.length > 32000) throw new Error('Invalid input text');
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, command.text);
      element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return 'Typed';
    }
    throw new Error('Unsupported browser action');
  }, args: [action] });
  return results[0]?.result;
}
async function poll() {
  if (polling) return; polling = true;
  try {
    const { host, token } = await chrome.storage.local.get(['host', 'token']); if (!host || !token) return;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (let i = 0; i < 20; i++) {
      const response = await fetch(host + '/browser/next', { headers }); if (!response.ok) break;
      const action = await response.json();
      if (action) {
        let result; try { result = { id: action.id, result: await perform(action) }; } catch (e) { result = { id: action.id, error: e.message }; }
        await fetch(host + '/browser/result', { method: 'POST', headers, body: JSON.stringify(result) });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (e) { console.warn('octopuses bridge:', e.message); }
  finally { polling = false; }
}
chrome.alarms.create('octopuses-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'octopuses-poll') void poll(); });
chrome.runtime.onMessage.addListener((message) => { if (message === 'paired') void poll(); });
void poll();
