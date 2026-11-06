const q = document.getElementById('q');
const st = document.getElementById('st');
chrome.storage.sync.get({ quoterUrl: 'http://127.0.0.1:8787' }, (s) => { q.value = s.quoterUrl; test(); });
document.getElementById('save').onclick = async () => {
  await chrome.storage.sync.set({ quoterUrl: q.value.trim().replace(/\/$/, '') });
  test();
};
function test() {
  st.textContent = 'Checking quoter…';
  st.className = 'st';
  chrome.runtime.sendMessage({ type: 'api', path: '/config' }, (r) => {
    if (r?.ok) {
      st.className = 'st ok';
      st.textContent = `Connected · ${r.data.chainName} (${r.data.chainId}) · engine ${r.data.engine.slice(0, 8)}…`;
    } else {
      st.className = 'st err';
      st.textContent = r?.error || 'Not reachable';
    }
  });
}
