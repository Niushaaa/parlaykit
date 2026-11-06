// Service worker: proxies quoter API calls (avoids page CSP/CORS) and stores settings.
const DEFAULTS = { quoterUrl: 'http://127.0.0.1:8787' };

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'api') return;
  (async () => {
    const { quoterUrl } = await settings();
    try {
      const res = await fetch(quoterUrl.replace(/\/$/, '') + msg.path, {
        method: msg.method || 'GET',
        headers: { 'content-type': 'application/json' },
        body: msg.body ? JSON.stringify(msg.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      sendResponse(res.ok ? { ok: true, data } : { ok: false, error: data.error || `HTTP ${res.status}` });
    } catch (e) {
      sendResponse({ ok: false, error: `Can't reach the ParlayKit quoter at ${quoterUrl} (${e.message})` });
    }
  })();
  return true; // async response
});
