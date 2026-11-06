// ParlayKit content script: detects markets on the page, offers a parlay, builds the slip,
// gets a signed quote from the quoter and sends the transaction through the user's own wallet.
(() => {
  const adapter = globalThis.PK_pickAdapter?.();
  if (!adapter || window.top !== window || document.getElementById('parlaykit-root')) return;

  // ================================================================ state
  const state = {
    open: false,
    tab: 'build',
    cfg: null,
    events: [],
    loadingEvents: false,
    slip: { venue: adapter.venue, legs: [] },
    stake: 10,
    preview: null,
    previewErr: null,
    account: null,
    busy: null,
    status: null, // { kind: 'ok'|'err', html }
    mine: null,
    vault: null,
    offerShown: false,
  };

  // ================================================================ utils
  const $ = (sel) => root.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cents = (p) => (p == null ? '–' : `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}¢`);
  const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const txLink = (hash) =>
    state.cfg?.explorer
      ? `<a href="${state.cfg.explorer}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`
      : `<code>${short(hash)}</code>`;

  // ================================================================ quoter API (via background worker)
  const api = (path, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'api', path, method, body }, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        r?.ok ? resolve(r.data) : reject(new Error(r?.error || 'Request failed'));
      });
    });

  // ================================================================ wallet bridge (inpage.js)
  let reqId = 0;
  const pending = new Map();
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || !m.__parlaykit) return;
    if (m.__parlaykit === 'res' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result);
    } else if (m.__parlaykit === 'evt' && m.name === 'accountsChanged') {
      state.account = m.data?.[0] || null;
      onAccountChanged();
    }
  });
  const wallet = (method, params = []) =>
    new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++reqId}`;
      pending.set(id, { resolve, reject });
      window.postMessage({ __parlaykit: 'req', id, method, params }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Wallet did not respond'));
        }
      }, 180_000);
    });

  async function connectWallet() {
    const accts = await wallet('eth_requestAccounts');
    state.account = accts?.[0] || null;
    onAccountChanged();
  }

  async function ensureChain() {
    const cfg = state.cfg;
    const cur = await wallet('eth_chainId');
    if (String(cur).toLowerCase() === cfg.chainIdHex) return;
    try {
      await wallet('wallet_switchEthereumChain', [{ chainId: cfg.chainIdHex }]);
    } catch (e) {
      if (e.code === 4902 || /unrecognized|not been added|unknown chain/i.test(e.message)) {
        const native = cfg.chainId === 80002 || cfg.chainId === 137 ? 'POL' : 'ETH';
        await wallet('wallet_addEthereumChain', [
          {
            chainId: cfg.chainIdHex,
            chainName: cfg.chainName,
            rpcUrls: [cfg.rpcUrl],
            nativeCurrency: { name: native, symbol: native, decimals: 18 },
            ...(cfg.explorer ? { blockExplorerUrls: [cfg.explorer] } : {}),
          },
        ]);
      } else throw e;
    }
  }

  async function sendTx(tx, label) {
    setBusy(`${label} — confirm in your wallet`);
    const hash = await wallet('eth_sendTransaction', [{ from: state.account, to: tx.to, data: tx.data }]);
    setBusy(`${label} — waiting for confirmation`);
    for (let i = 0; i < 200; i++) {
      const r = await wallet('eth_getTransactionReceipt', [hash]);
      if (r) {
        if (r.status !== '0x1' && r.status !== 1) throw new Error(`${label} failed on-chain (tx ${short(hash)})`);
        return hash;
      }
      await sleep(1500);
    }
    throw new Error(`${label}: timed out waiting for ${short(hash)}`);
  }

  // ================================================================ DOM
  const host = document.createElement('div');
  host.id = 'parlaykit-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:0;bottom:0;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const icon = chrome.runtime.getURL('icons/48.png');
  root.innerHTML = `
  <link rel="stylesheet" href="${chrome.runtime.getURL('panel.css')}">
  <div class="pk">
    <div class="offer" hidden>
      <img src="${icon}" alt="">
      <div class="offer-text"></div>
      <button class="btn primary sm offer-go">Build parlay</button>
      <button class="x offer-x" aria-label="Dismiss">×</button>
    </div>
    <button class="launcher" title="ParlayKit"><img src="${icon}" alt=""><span>Parlay</span><b class="badge">0</b></button>
    <aside class="panel" hidden>
      <header>
        <div class="brand"><img src="${icon}" alt=""><div><b>ParlayKit</b><small>on ${esc(adapter.label)}</small></div></div>
        <button class="btn ghost sm wallet"></button>
        <button class="x close" aria-label="Close">×</button>
      </header>
      <nav class="tabs">
        <button data-tab="build">Build</button><button data-tab="mine">My parlays</button><button data-tab="vault">Vault</button>
      </nav>
      <section class="tab tab-build">
        <div class="markets-head"><span>Markets on this page</span><button class="link refresh">Refresh</button></div>
        <div class="markets"></div>
        <div class="slip">
          <div class="slip-head"><b>Your parlay</b><span class="count"></span><button class="link clear">Clear</button></div>
          <div class="legs"></div>
          <div class="stake-row">
            <label for="pk-stake">Stake</label>
            <div class="stake"><span>$</span><input id="pk-stake" type="number" min="1" step="1" inputmode="decimal"></div>
            <div class="chips"><button data-chip="5">5</button><button data-chip="10">10</button><button data-chip="25">25</button><button data-chip="100">100</button></div>
          </div>
          <div class="summary"></div>
          <button class="btn primary cta"></button>
          <div class="status"></div>
        </div>
      </section>
      <section class="tab tab-mine"><div class="mine"></div></section>
      <section class="tab tab-vault"><div class="vault"></div></section>
      <footer>Legs priced at the venue's live ask · parlay = product of leg prices + house edge · backed by an on-chain LP vault</footer>
    </aside>
  </div>`;

  // ================================================================ rendering
  const legKey = (l) => `${l.conditionId.toLowerCase()}:${l.outcome}`;
  const inSlip = (cid, o) => state.slip.legs.some((l) => legKey(l) === `${cid.toLowerCase()}:${o}`);
  const slipEventIds = () => new Set(state.slip.legs.map((l) => l.eventId));

  function renderAll() {
    $('.panel').hidden = !state.open;
    $('.launcher').classList.toggle('active', state.open);
    $('.badge').textContent = state.slip.legs.length;
    $('.badge').hidden = state.slip.legs.length === 0;
    root.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    root.querySelectorAll('.tab').forEach((s) => (s.hidden = !s.classList.contains(`tab-${state.tab}`)));
    renderWallet();
    renderMarkets();
    renderSlip();
    if (state.tab === 'mine') renderMine();
    if (state.tab === 'vault') renderVault();
  }

  function renderWallet() {
    const b = $('.wallet');
    b.textContent = state.account ? short(state.account) : 'Connect wallet';
    b.classList.toggle('connected', !!state.account);
  }

  function renderMarkets() {
    const el = $('.markets');
    if (state.loadingEvents && !state.events.length) {
      el.innerHTML = `<div class="empty">Looking for markets on this page…</div>`;
      return;
    }
    if (!state.events.length) {
      el.innerHTML = `<div class="empty">No markets detected here yet. Open an event or a category page — ParlayKit picks up every market you can see.</div>`;
      return;
    }
    const used = slipEventIds();
    el.innerHTML = state.events
      .map((ev) => {
        const tradable = ev.markets.filter((m) => m.tradable);
        if (!tradable.length) return '';
        const legInEvent = state.slip.legs.find((l) => l.eventId === ev.markets[0]?.eventId);
        const rows = tradable
          .slice(0, 8)
          .map((m) => {
            const blockedEvent = used.has(m.eventId) && !state.slip.legs.some((l) => l.conditionId.toLowerCase() === m.conditionId.toLowerCase());
            const btn = (o) => {
              const p = m.prices[o];
              const outOfRange = p == null || p < 0.02 || p > 0.98;
              const sel = inSlip(m.conditionId, o);
              const dis = blockedEvent || outOfRange;
              const why = blockedEvent ? 'One leg per event in v1' : outOfRange ? 'Price outside 2¢–98¢' : '';
              return `<button class="pick ${o === 0 ? 'yes' : 'no'} ${sel ? 'sel' : ''}" data-cid="${m.conditionId}" data-o="${o}" data-ev="${esc(ev.slug)}" ${dis ? `disabled title="${why}"` : ''}>${esc(m.outcomes[o])} <b>${cents(p)}</b></button>`;
            };
            const label = m.groupItemTitle || (tradable.length > 1 || m.question !== ev.title ? m.question : '');
            return `<div class="mrow"><div class="q">${esc(label)}</div><div class="picks">${btn(0)}${btn(1)}</div></div>`;
          })
          .join('');
        return `<div class="event ${legInEvent ? 'has-leg' : ''}">
          <div class="ev-title">${esc(ev.title)}${ev.slug === adapter.currentSlug() ? '<span class="tag">this page</span>' : ''}${legInEvent ? '<span class="tag on">in slip</span>' : ''}</div>
          ${rows}${tradable.length > 8 ? `<div class="more">+${tradable.length - 8} more outcomes on the venue</div>` : ''}
        </div>`;
      })
      .join('');
  }

  function renderSlip() {
    const n = state.slip.legs.length;
    $('.count').textContent = n ? `${n} leg${n > 1 ? 's' : ''}` : '';
    $('.clear').hidden = !n;
    const livePrice = new Map((state.preview?.legs || []).map((l) => [legKey(l), l.price]));
    $('.legs').innerHTML = n
      ? state.slip.legs
          .map((l, i) => {
            const live = livePrice.get(legKey(l));
            return `<div class="leg"><span class="num">${i + 1}</span><div class="lq"><div>${esc(l.question)}</div>${l.eventTitle && l.eventTitle !== l.question ? `<small>${esc(l.eventTitle)}</small>` : ''}</div>
              <span class="lpick ${l.outcome === 0 ? 'yes' : 'no'}">${esc(l.outcomeLabel)} ${cents(live ?? l.price)}</span>
              <button class="x rm" data-i="${i}" aria-label="Remove">×</button></div>`;
          })
          .join('')
      : `<div class="empty small">Tap Yes / No on two or more markets above to build a parlay.</div>`;

    const stakeInput = $('#pk-stake');
    if (root.activeElement !== stakeInput) stakeInput.value = state.stake;

    const p = state.preview;
    const s = $('.summary');
    if (n < 2) s.innerHTML = '';
    else if (state.previewErr) s.innerHTML = `<div class="warn">${esc(state.previewErr)}</div>`;
    else if (!p) s.innerHTML = `<div class="muted">Pricing…</div>`;
    else {
      s.innerHTML = `
        <div class="kv"><span>Combined chance</span><b>${pct(p.fairProbability)}</b></div>
        <div class="kv"><span>Odds</span><b>×${p.multiplier.toFixed(2)}</b></div>
        <div class="kv"><span>House edge</span><b>${(p.edgeBps / 100).toFixed(1)}%</b></div>
        <div class="kv big"><span>Payout if all ${n} win</span><b>${usd(p.payout)}</b></div>
        ${p.risk && !p.risk.ok ? `<div class="warn">The vault can cover up to ${usd(p.risk.maxStake)} on this parlay right now.</div>` : ''}`;
    }

    const cta = $('.cta');
    let label = 'Place parlay';
    let disabled = false;
    if (state.busy) [label, disabled] = [state.busy, true];
    else if (n < 2) [label, disabled] = ['Add at least 2 legs', true];
    else if (!state.account) label = 'Connect wallet';
    else if (state.previewErr || !p) disabled = true;
    else if (p.risk && !p.risk.ok) [label, disabled] = ['Lower your stake', true];
    else label = `Place parlay · ${usd(p.stake)} → ${usd(p.payout)}`;
    cta.textContent = label;
    cta.disabled = disabled;
    cta.classList.toggle('busy', !!state.busy);

    const st = $('.status');
    st.className = `status ${state.status?.kind || ''}`;
    st.innerHTML = state.status?.html || '';
  }

  function renderMine() {
    const el = $('.mine');
    if (!state.account) {
      el.innerHTML = `<div class="empty">Connect your wallet to see your parlays.</div><button class="btn primary connect">Connect wallet</button>`;
      return;
    }
    if (!state.mine) {
      el.innerHTML = `<div class="empty">Loading…</div>`;
      return;
    }
    if (!state.mine.length) {
      el.innerHTML = `<div class="empty">No parlays yet. Build one from the markets on this page.</div>`;
      return;
    }
    const icon = { won: '✓', lost: '✗', pending: '…', partial: '½' };
    el.innerHTML = state.mine
      .map(
        (p) => `<div class="card">
        <div class="card-head"><b>Parlay #${p.id}</b><span class="chip ${p.status.toLowerCase()}">${p.status}</span></div>
        <div class="card-amt">${usd(p.stake)} → <b>${usd(p.status === 'Won' || p.status === 'Voided' ? p.paid : p.maxPayout)}</b></div>
        ${p.legs
          .map(
            (l) =>
              `<div class="cleg ${l.state}"><span class="st">${icon[l.state]}</span><span class="lq">${esc(l.question)}</span><span class="lpick ${l.outcome === 0 ? 'yes' : 'no'}">${esc(l.outcomeLabel)} ${cents(l.price)}</span></div>`
          )
          .join('')}
        ${
          p.settleable
            ? `<button class="btn ${p.settleOutcome === 'won' ? 'primary' : 'ghost'} settle" data-id="${p.id}">${p.settleOutcome === 'won' ? `Claim ${usd(p.settleAmount)}` : 'Settle (lost)'}</button>`
            : ''
        }
      </div>`
      )
      .join('');
  }

  function renderVault() {
    const el = $('.vault');
    const v = state.vault;
    if (!v) {
      el.innerHTML = `<div class="empty">Loading vault…</div>`;
      return;
    }
    const a = v.account;
    el.innerHTML = `
      <p class="muted">The vault is the counterparty to every parlay. LPs earn the house edge on losing parlays and pay out winners. Withdrawals are capped by liquidity reserved for open parlays.</p>
      <div class="stats">
        <div><small>TVL</small><b>${usd(v.tvl)}</b></div>
        <div><small>Share price</small><b>${v.sharePrice.toFixed(4)}</b></div>
        <div><small>Reserved for open parlays</small><b>${usd(v.lockedPayout)}</b></div>
        <div><small>Free liquidity</small><b>${usd(v.freeLiquidity)}</b></div>
      </div>
      <div class="util"><div style="width:${Math.min(100, v.utilizationPct)}%"></div></div>
      <div class="muted small">Utilization ${v.utilizationPct.toFixed(1)}% · cap ${(v.params.maxUtilBps / 100).toFixed(0)}% · max net risk per parlay ${usd(v.maxNetRisk)}</div>
      ${
        !state.account
          ? `<button class="btn primary connect">Connect wallet</button>`
          : `<div class="pos"><div><small>Your position</small><b>${usd(a?.assets)}</b></div><div><small>Withdrawable now</small><b>${usd(a?.maxWithdraw)}</b></div><div><small>Wallet USDC</small><b>${usd(a?.usdc)}</b></div></div>
             <div class="lp-row"><div class="stake"><span>$</span><input class="lp-amt" type="number" min="1" placeholder="Amount"></div>
             <button class="btn primary deposit">Deposit</button><button class="btn ghost withdraw">Withdraw</button></div>
             ${state.cfg?.mockUsdc ? `<button class="link faucet">Get 1,000 test USDC</button>` : ''}`
      }`;
  }

  function setBusy(msg) {
    state.busy = msg;
    renderSlip();
    const v = $('.vault .lp-row');
    if (v) v.classList.toggle('disabled', !!msg);
  }

  function setStatus(kind, html) {
    state.status = kind ? { kind, html } : null;
    renderSlip();
  }

  // ================================================================ data
  let lastSlugs = '';
  async function loadEvents(force = false) {
    const cur = adapter.currentSlug();
    const slugs = [...new Set([cur, ...adapter.visibleSlugs()].filter(Boolean))];
    const key = slugs.join('|');
    if (!force && key === lastSlugs) return;
    lastSlugs = key;
    if (!slugs.length) {
      state.events = [];
      renderMarkets();
      return;
    }
    state.loadingEvents = true;
    renderMarkets();
    try {
      const evs = await api('/events', 'POST', { venue: adapter.venue, slugs });
      evs.sort((a, b) => (a.slug === cur ? -1 : b.slug === cur ? 1 : 0));
      state.events = evs;
      maybeOffer();
    } catch (e) {
      state.events = [];
      $('.markets').innerHTML = `<div class="warn">${esc(e.message)}</div>`;
      state.loadingEvents = false;
      return;
    }
    state.loadingEvents = false;
    renderMarkets();
  }

  function maybeOffer() {
    const n = state.events.reduce((s, e) => s + e.markets.filter((m) => m.tradable).length, 0);
    const eventsWithMarkets = state.events.filter((e) => e.markets.some((m) => m.tradable)).length;
    if (state.open || state.offerShown || eventsWithMarkets < 1 || n < 2) return;
    if (sessionStorage.getItem('parlaykit-offer-dismissed')) return;
    state.offerShown = true;
    $('.offer-text').innerHTML =
      eventsWithMarkets > 1
        ? `<b>${eventsWithMarkets} events on this page can be combined.</b> Stack them into one parlay for a bigger payout.`
        : `<b>Want to parlay this?</b> Combine it with other markets for a bigger payout.`;
    $('.offer').hidden = false;
  }

  const refreshPreview = debounce(async () => {
    if (state.slip.legs.length < 2) {
      state.preview = null;
      state.previewErr = null;
      renderSlip();
      return;
    }
    try {
      state.preview = await api('/price', 'POST', { stake: state.stake, legs: state.slip.legs });
      state.previewErr = null;
    } catch (e) {
      state.preview = null;
      state.previewErr = e.message;
    }
    renderSlip();
  }, 250);

  async function loadMine() {
    if (!state.account) return renderMine();
    try {
      state.mine = await api(`/parlays?account=${state.account}`);
    } catch (e) {
      state.mine = [];
      setStatus('err', esc(e.message));
    }
    if (state.tab === 'mine') renderMine();
  }

  async function loadVault() {
    try {
      state.vault = await api(`/vault${state.account ? `?account=${state.account}` : ''}`);
    } catch (e) {
      $('.vault').innerHTML = `<div class="warn">${esc(e.message)}</div>`;
      return;
    }
    if (state.tab === 'vault') renderVault();
  }

  function onAccountChanged() {
    renderWallet();
    renderSlip();
    state.mine = null;
    if (state.tab === 'mine') loadMine();
    if (state.tab === 'vault') loadVault();
  }

  async function saveSlip() {
    await chrome.storage.local.set({ slip: state.slip, stake: state.stake });
  }

  // ================================================================ actions
  function toggleLeg(cid, outcome, evSlug) {
    const ev = state.events.find((e) => e.slug === evSlug);
    const m = ev?.markets.find((x) => x.conditionId === cid);
    if (!m) return;
    if (state.slip.venue !== adapter.venue) state.slip = { venue: adapter.venue, legs: [] };
    const idx = state.slip.legs.findIndex((l) => l.conditionId.toLowerCase() === cid.toLowerCase());
    if (idx >= 0 && state.slip.legs[idx].outcome === outcome) state.slip.legs.splice(idx, 1);
    else {
      const leg = {
        venue: adapter.venue,
        eventSlug: ev.slug,
        eventId: m.eventId,
        eventTitle: ev.title,
        conditionId: m.conditionId,
        question: m.groupItemTitle ? `${ev.title}: ${m.groupItemTitle}` : m.question,
        outcome,
        outcomeLabel: m.outcomes[outcome],
        price: m.prices[outcome],
      };
      if (idx >= 0) state.slip.legs[idx] = leg;
      else {
        if (state.slip.legs.length >= (state.cfg?.params?.maxLegs || 8)) {
          setStatus('err', `Max ${state.cfg?.params?.maxLegs || 8} legs per parlay`);
          return;
        }
        state.slip.legs.push(leg);
      }
    }
    setStatus(null);
    saveSlip();
    renderAll();
    refreshPreview();
  }

  async function placeParlay() {
    try {
      setStatus(null);
      if (!state.account) await connectWallet();
      if (!state.account) return;
      await ensureChain();
      setBusy('Getting a signed quote…');
      const q = await api('/quote', 'POST', { buyer: state.account, stake: state.stake, legs: state.slip.legs });
      if (q.balance < q.stake) {
        throw new Error(
          `Not enough USDC: you have ${usd(q.balance)}, stake is ${usd(q.stake)}.` +
            (state.cfg?.mockUsdc ? ' Grab test USDC in the Vault tab.' : '')
        );
      }
      if (q.approval) await sendTx(q.approval, 'Approve USDC');
      const hash = await sendTx(q.tx, 'Placing parlay');
      state.busy = null;
      state.slip.legs = [];
      state.preview = null;
      await saveSlip();
      setStatus('ok', `Parlay placed: ${usd(q.stake)} to win ${usd(q.payout)}. Tx ${txLink(hash)}`);
      renderAll();
      state.mine = null;
    } catch (e) {
      state.busy = null;
      const msg = e.code === 4001 ? 'You rejected the request in your wallet.' : e.message;
      setStatus('err', esc(msg));
    }
  }

  async function vaultAction(kind) {
    try {
      if (!state.account) await connectWallet();
      await ensureChain();
      if (kind === 'faucet') {
        const r = await api('/tx/faucet', 'POST', { account: state.account });
        await sendTx(r.tx, 'Minting test USDC');
      } else {
        const amount = Number($('.lp-amt')?.value);
        if (!(amount > 0)) throw new Error('Enter an amount');
        const r = await api(`/tx/${kind}`, 'POST', { account: state.account, amount });
        if (r.approval) await sendTx(r.approval, 'Approve USDC');
        await sendTx(r.tx, kind === 'deposit' ? 'Depositing' : 'Withdrawing');
      }
      state.busy = null;
      await loadVault();
    } catch (e) {
      state.busy = null;
      renderSlip();
      const el = $('.vault');
      el.insertAdjacentHTML('afterbegin', `<div class="warn">${esc(e.code === 4001 ? 'Rejected in wallet.' : e.message)}</div>`);
    }
  }

  async function settle(id) {
    const p = state.mine?.find((x) => x.id === id);
    if (!p?.settleTx) return;
    try {
      await ensureChain();
      const hash = await sendTx(p.settleTx, `Settling #${id}`);
      state.busy = null;
      await loadMine();
      setStatus('ok', `Parlay #${id} settled. Tx ${txLink(hash)}`);
    } catch (e) {
      state.busy = null;
      renderSlip();
      $('.mine').insertAdjacentHTML('afterbegin', `<div class="warn">${esc(e.message)}</div>`);
    }
  }

  // ================================================================ events
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.matches('.launcher, .offer-go')) {
      state.open = !state.open || t.matches('.offer-go');
      $('.offer').hidden = true;
      renderAll();
      if (state.open) loadEvents();
    } else if (t.matches('.offer-x')) {
      $('.offer').hidden = true;
      sessionStorage.setItem('parlaykit-offer-dismissed', '1');
    } else if (t.matches('.close')) {
      state.open = false;
      renderAll();
    } else if (t.matches('.tabs button')) {
      state.tab = t.dataset.tab;
      renderAll();
      if (state.tab === 'mine') loadMine();
      if (state.tab === 'vault') loadVault();
    } else if (t.matches('.pick')) toggleLeg(t.dataset.cid, Number(t.dataset.o), t.dataset.ev);
    else if (t.matches('.rm')) {
      state.slip.legs.splice(Number(t.dataset.i), 1);
      saveSlip();
      renderAll();
      refreshPreview();
    } else if (t.matches('.clear')) {
      state.slip.legs = [];
      saveSlip();
      setStatus(null);
      renderAll();
      refreshPreview();
    } else if (t.matches('[data-chip]')) {
      state.stake = Number(t.dataset.chip);
      saveSlip();
      renderSlip();
      refreshPreview();
    } else if (t.matches('.cta')) {
      if (!state.account) connectWallet().catch((err) => setStatus('err', esc(err.message)));
      else placeParlay();
    } else if (t.matches('.wallet, .connect')) connectWallet().catch((err) => setStatus('err', esc(err.message)));
    else if (t.matches('.refresh')) loadEvents(true);
    else if (t.matches('.deposit')) vaultAction('deposit');
    else if (t.matches('.withdraw')) vaultAction('withdraw');
    else if (t.matches('.faucet')) vaultAction('faucet');
    else if (t.matches('.settle')) settle(Number(t.dataset.id));
  });

  root.addEventListener('input', (e) => {
    if (e.target.id === 'pk-stake') {
      state.stake = Math.max(0, Number(e.target.value) || 0);
      saveSlip();
      refreshPreview();
    }
  });

  // SPA navigation + lazy-loaded feeds: rescan when the URL or the set of visible events changes.
  let lastHref = location.href;
  const rescan = debounce(() => loadEvents(), 1200);
  new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      state.offerShown = false;
    }
    rescan();
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => loadEvents(true));
  setInterval(() => state.slip.legs.length >= 2 && state.open && refreshPreview(), 10_000);
  setInterval(() => state.open && state.tab === 'build' && loadEvents(true), 30_000);

  // ================================================================ boot
  (async () => {
    const saved = await chrome.storage.local.get(['slip', 'stake']);
    if (saved.slip?.venue === adapter.venue) state.slip = saved.slip;
    if (saved.stake) state.stake = saved.stake;
    renderAll();
    try {
      state.cfg = await api('/config');
    } catch (e) {
      setStatus('err', esc(e.message));
    }
    try {
      const accts = await wallet('eth_accounts');
      state.account = accts?.[0] || null;
    } catch {}
    renderAll();
    await loadEvents(true);
    refreshPreview();
  })();
})();
