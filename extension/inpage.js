// Runs in the page's JS world so it can reach the user's wallet (window.ethereum).
// The isolated content script talks to it with window.postMessage — no wallet keys ever touch the extension.
(() => {
  if (window.__parlaykitBridge) return;
  window.__parlaykitBridge = true;
  const reply = (id, payload) => window.postMessage({ __parlaykit: 'res', id, ...payload }, '*');
  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.__parlaykit !== 'req') return;
    const eth = window.ethereum;
    if (!eth) return reply(m.id, { error: { code: -1, message: 'No browser wallet found. Install MetaMask or Rabby.' } });
    try {
      const result = await eth.request({ method: m.method, params: m.params || [] });
      reply(m.id, { result });
    } catch (e) {
      reply(m.id, { error: { code: e?.code ?? -1, message: e?.message || String(e) } });
    }
  });
  const hook = () => {
    const eth = window.ethereum;
    if (!eth?.on || eth.__parlaykitHooked) return;
    eth.__parlaykitHooked = true;
    eth.on('accountsChanged', (a) => window.postMessage({ __parlaykit: 'evt', name: 'accountsChanged', data: a }, '*'));
    eth.on('chainChanged', (c) => window.postMessage({ __parlaykit: 'evt', name: 'chainChanged', data: c }, '*'));
  };
  hook();
  window.addEventListener('load', hook);
  setTimeout(hook, 1500);
})();
