// ParlayKit quoter: the off-chain half of the pricing oracle.
//  - reads live leg prices from the venue (Polymarket Gamma API, or the demo venue)
//  - prices the parlay with the same integer math as ParlayEngine
//  - signs an EIP-712 quote the engine verifies on-chain
//  - returns ready-to-send calldata so the browser extension needs no ABI library
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AbiCoder, keccak256, MaxUint256, getAddress, isAddress, formatUnits, parseUnits } from 'ethers';
import { loadConfig, connect, readParams, iface, LEG_TUPLE } from './chain.js';
import { quotePayout, toPriceE6, validateLegPrices, validateIndependence, PricingError } from './pricing.js';
import * as polymarket from './sources/polymarket.js';
import * as demo from './sources/demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const chain = connect(cfg);
const venues = { polymarket, demo };
let params = await readParams(chain.engine);
setInterval(async () => {
  try {
    params = await readParams(chain.engine);
  } catch {}
}, 60_000);

const onchainSigner = await chain.engine.quoteSigner();
if (onchainSigner.toLowerCase() !== chain.signer.address.toLowerCase()) {
  console.warn(`⚠️  QUOTER key ${chain.signer.address} != engine.quoteSigner ${onchainSigner}. Quotes will be rejected.`);
}

// ------------------------------------------------------------------ leg metadata (names for "My parlays")
const META_FILE = path.resolve(__dirname, '../data/legs.json');
fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
const legMeta = new Map(fs.existsSync(META_FILE) ? Object.entries(JSON.parse(fs.readFileSync(META_FILE, 'utf8'))) : []);
function rememberMarkets(markets) {
  let changed = false;
  for (const m of markets) {
    const k = m.conditionId.toLowerCase();
    if (!legMeta.has(k)) changed = true;
    legMeta.set(k, {
      question: m.question,
      eventTitle: m.eventTitle,
      eventId: m.eventId,
      eventSlug: m.eventSlug,
      venue: m.venue,
      outcomes: m.outcomes,
      url: m.url,
    });
  }
  if (changed) fs.writeFile(META_FILE, JSON.stringify(Object.fromEntries(legMeta), null, 1), () => {});
}

// ------------------------------------------------------------------ helpers
const domain = { name: 'ParlayKit', version: '1', chainId: cfg.chainId, verifyingContract: cfg.engine };
const types = {
  Quote: [
    { name: 'buyer', type: 'address' },
    { name: 'stake', type: 'uint256' },
    { name: 'legsHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const coder = AbiCoder.defaultAbiCoder();
const usd = (v) => Number(formatUnits(v, 6));

function parseStake(s) {
  if (s == null || s === '') throw new PricingError('Enter a stake');
  const v = typeof s === 'string' && /^\d+$/.test(s) && s.length > 8 ? BigInt(s) : parseUnits(String(s), 6);
  return v;
}

function requireAddress(a, name = 'address') {
  if (!a || !isAddress(a)) throw new PricingError(`Missing or invalid ${name}`);
  return getAddress(a);
}

// conditionId -> resolved? (read from the CTF the engine settles against). Resolved markets can't be legs.
const resolvedCache = new Map();
async function isResolved(conditionId, { fresh = false } = {}) {
  const k = conditionId.toLowerCase();
  const hit = resolvedCache.get(k);
  if (!fresh && hit && (hit.resolved || Date.now() - hit.at < 30_000)) return hit.resolved;
  let resolved = false;
  try {
    resolved = (await chain.ctf.payoutDenominator(conditionId)) > 0n;
  } catch {}
  resolvedCache.set(k, { at: Date.now(), resolved });
  return resolved;
}

async function venueEvent(venue, slug, fresh) {
  const src = venues[venue];
  if (!src) throw new PricingError(`Unsupported venue "${venue}"`);
  const ev = await src.getEvent(slug, { fresh });
  rememberMarkets(ev.markets);
  const flags = await Promise.all(ev.markets.map((m) => isResolved(m.conditionId)));
  ev.markets = ev.markets.map((m, i) => (flags[i] ? { ...m, tradable: false, resolved: true } : m));
  return ev;
}

/** Re-reads live prices for the selected legs. Never trusts prices sent by the client. */
async function freshLegs(rawLegs) {
  if (!Array.isArray(rawLegs) || rawLegs.length === 0) throw new PricingError('Add at least two legs');
  const bySlug = new Map();
  const out = [];
  for (const [i, l] of rawLegs.entries()) {
    const venue = l.venue || 'polymarket';
    const outcome = Number(l.outcome);
    if (outcome !== 0 && outcome !== 1) throw new PricingError(`Leg ${i + 1}: outcome must be 0 (Yes) or 1 (No)`);
    let market;
    if (l.eventSlug) {
      const key = `${venue}:${l.eventSlug}`;
      if (!bySlug.has(key)) bySlug.set(key, await venueEvent(venue, l.eventSlug, true));
      market = bySlug.get(key).markets.find((m) => m.conditionId.toLowerCase() === String(l.conditionId).toLowerCase());
    }
    if (!market) {
      market = await venues[venue].getMarketByCondition(l.conditionId);
      rememberMarkets([market]);
    }
    if (!market.tradable || (await isResolved(market.conditionId, { fresh: true }))) {
      throw new PricingError(`Leg ${i + 1} (“${market.question}”) is closed or already resolved`);
    }
    const price = market.prices[outcome];
    if (price == null) throw new PricingError(`Leg ${i + 1} has no live price`);
    out.push({
      conditionId: market.conditionId,
      outcome,
      priceE6: toPriceE6(price),
      eventId: market.eventId,
      question: market.question,
      outcomeLabel: market.outcomes[outcome],
      eventTitle: market.eventTitle,
    });
  }
  validateIndependence(out);
  validateLegPrices(params, out);
  return out;
}

async function riskView(stake, maxPayout) {
  const [maxNetRisk, locked, bal] = await Promise.all([
    chain.engine.maxNetRisk(),
    chain.vault.lockedPayout(),
    chain.vault.balance(),
  ]);
  const netRisk = maxPayout - stake;
  const mult = Number(maxPayout) / Number(stake || 1n);
  const maxStakeByRisk = mult > 1 ? BigInt(Math.floor(Number(maxNetRisk) / (mult - 1))) : 0n;
  const utilOk = (locked + maxPayout) * 10_000n <= (bal + stake) * BigInt(params.maxUtilBps);
  return {
    ok: netRisk <= maxNetRisk && utilOk,
    reason: netRisk > maxNetRisk ? 'risk' : !utilOk ? 'utilization' : null,
    maxNetRisk: usd(maxNetRisk),
    maxStake: usd(maxStakeByRisk),
  };
}

async function buildQuote(body, { sign }) {
  const stake = parseStake(body.stake);
  if (stake < params.minStake) throw new PricingError(`Minimum stake is ${usd(params.minStake)} USDC`);
  const legs = await freshLegs(body.legs);
  const p = quotePayout(params, legs, stake);
  const risk = await riskView(stake, p.maxPayout);
  const result = {
    legs: legs.map((l) => ({ ...l, price: l.priceE6 / 1e6 })),
    stake: usd(stake),
    stakeRaw: stake.toString(),
    payout: usd(p.maxPayout),
    payoutRaw: p.maxPayout.toString(),
    multiplier: p.multiplier,
    fairProbability: p.fairProbability,
    offerProbability: p.offerProbability,
    edgeBps: p.edgeBps,
    risk,
  };
  if (!sign) return result;
  if (!risk.ok) {
    throw new PricingError(
      risk.reason === 'risk'
        ? `Vault can cover at most ${risk.maxStake.toFixed(2)} USDC stake on this parlay right now`
        : 'Vault utilization limit reached — try a smaller stake'
    );
  }
  const buyer = requireAddress(body.buyer, 'buyer');
  const chainLegs = legs.map((l) => [l.conditionId, l.outcome, l.priceE6]);
  const legsHash = keccak256(coder.encode([`${LEG_TUPLE}[]`], [chainLegs]));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + cfg.quoteTtlSec);
  const nonce = BigInt('0x' + crypto.randomBytes(16).toString('hex'));
  const signature = await chain.signer.signTypedData(domain, types, { buyer, stake, legsHash, deadline, nonce });
  const data = iface.engine.encodeFunctionData('buyParlay', [chainLegs, stake, deadline, nonce, signature]);

  const [allowance, balance] = await Promise.all([chain.usdc.allowance(buyer, cfg.engine), chain.usdc.balanceOf(buyer)]);
  // Dry-run the exact transaction so the user never signs something that will revert.
  if (allowance >= stake && balance >= stake) {
    try {
      await chain.provider.call({ from: buyer, to: cfg.engine, data });
    } catch (e) {
      const reason = e.revert?.name || e.reason || e.shortMessage || 'reverted';
      throw new PricingError(`This parlay would fail on-chain (${reason}). Refresh prices and try again.`);
    }
  }
  return {
    ...result,
    deadline: Number(deadline),
    nonce: nonce.toString(),
    signature,
    buyer,
    balance: usd(balance),
    approval:
      allowance >= stake
        ? null
        : { to: cfg.usdc, data: iface.erc20.encodeFunctionData('approve', [cfg.engine, MaxUint256]) },
    tx: { to: cfg.engine, data },
  };
}

const STATUS = ['None', 'Open', 'Won', 'Lost', 'Voided'];
async function listParlays(account) {
  const ids = await chain.engine.parlaysOf(account);
  const items = await Promise.all(
    [...ids].reverse().map(async (idBig) => {
      const id = Number(idBig);
      const [p, legs, prev] = await Promise.all([
        chain.engine.parlays(id),
        chain.engine.getLegs(id),
        chain.engine.previewSettlement(id),
      ]);
      const legViews = await Promise.all(
        legs.map(async (l) => {
          const den = await chain.ctf.payoutDenominator(l.conditionId);
          let state = 'pending';
          if (den > 0n) {
            const n = await chain.ctf.payoutNumerators(l.conditionId, l.outcome);
            state = n === 0n ? 'lost' : n === den ? 'won' : 'partial';
          }
          const meta = legMeta.get(l.conditionId.toLowerCase()) || {};
          return {
            conditionId: l.conditionId,
            outcome: Number(l.outcome),
            outcomeLabel: meta.outcomes?.[Number(l.outcome)] || (Number(l.outcome) === 0 ? 'Yes' : 'No'),
            price: Number(l.priceE6) / 1e6,
            question: meta.question || l.conditionId.slice(0, 10) + '…',
            eventTitle: meta.eventTitle || null,
            url: meta.url || null,
            state,
          };
        })
      );
      const status = STATUS[Number(p.status)];
      const settleable = status === 'Open' && Number(prev.state) !== 0;
      return {
        id,
        status,
        stake: usd(p.stake),
        maxPayout: usd(p.maxPayout),
        paid: usd(p.paid),
        createdAt: Number(p.createdAt),
        settleable,
        settleOutcome: settleable ? (Number(prev.state) === 1 ? 'won' : 'lost') : null,
        settleAmount: usd(prev.amount),
        settleTx: settleable ? { to: cfg.engine, data: iface.engine.encodeFunctionData('settle', [id]) } : null,
        legs: legViews,
      };
    })
  );
  return items;
}

async function vaultView(account) {
  const v = chain.vault;
  const [tvl, balance, locked, pending, free, util, supply, maxNetRisk] = await Promise.all([
    v.totalAssets(),
    v.balance(),
    v.lockedPayout(),
    v.pendingPremium(),
    v.freeLiquidity(),
    v.utilizationBps(),
    v.totalSupply(),
    chain.engine.maxNetRisk(),
  ]);
  const out = {
    tvl: usd(tvl),
    balance: usd(balance),
    lockedPayout: usd(locked),
    pendingPremium: usd(pending),
    freeLiquidity: usd(free),
    utilizationPct: Number(util) / 100,
    sharePrice: supply === 0n ? 1 : Number(tvl) / Number(supply),
    maxNetRisk: usd(maxNetRisk),
    params,
  };
  if (account && isAddress(account)) {
    const [shares, maxW, maxR, usdcBal, allowance] = await Promise.all([
      v.balanceOf(account),
      v.maxWithdraw(account),
      v.maxRedeem(account),
      chain.usdc.balanceOf(account),
      chain.usdc.allowance(account, cfg.vault),
    ]);
    const assets = shares === 0n ? 0n : await v.convertToAssets(shares);
    out.account = {
      shares: Number(formatUnits(shares, 6)),
      sharesRaw: shares.toString(),
      assets: usd(assets),
      maxWithdraw: usd(maxW),
      maxRedeemRaw: maxR.toString(),
      usdc: usd(usdcBal),
      allowance: usd(allowance),
    };
  }
  return out;
}

// ------------------------------------------------------------------ routes
const routes = {
  'GET /health': async () => ({ ok: true, signer: chain.signer.address, chainId: cfg.chainId, demo: cfg.demo }),

  'GET /config': async () => ({
    chainId: cfg.chainId,
    chainIdHex: '0x' + cfg.chainId.toString(16),
    chainName: cfg.chainName,
    rpcUrl: process.env.PUBLIC_RPC_URL || cfg.rpcUrl,
    explorer: cfg.explorer,
    engine: cfg.engine,
    vault: cfg.vault,
    usdc: cfg.usdc,
    ctf: cfg.ctf,
    mockUsdc: cfg.mockUsdc,
    demo: cfg.demo,
    params: { ...params, minStake: usd(params.minStake) },
  }),

  // GET /event?venue=polymarket&slug=<event-slug>
  'GET /event': async (q) => venueEvent(q.venue || 'polymarket', q.slug),

  // POST /events { venue, slugs: [...] } -> events found on a listing page
  'POST /events': async (_q, b) => {
    const venue = b.venue || 'polymarket';
    const slugs = [...new Set((b.slugs || []).filter(Boolean))].slice(0, 30);
    const res = await Promise.allSettled(slugs.map((s) => venueEvent(venue, s)));
    return res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  },

  'GET /demo/events': async () => {
    const evs = await demo.listEvents();
    evs.forEach((e) => rememberMarkets(e.markets));
    return evs;
  },

  // POST /price { stake, legs:[{venue,eventSlug,conditionId,outcome}] } -> live preview, unsigned
  'POST /price': async (_q, b) => buildQuote(b, { sign: false }),

  // POST /quote { buyer, stake, legs } -> signed quote + calldata
  'POST /quote': async (_q, b) => buildQuote(b, { sign: true }),

  'GET /parlays': async (q) => listParlays(requireAddress(q.account, 'account')),

  'GET /vault': async (q) => vaultView(q.account),

  // POST /tx/deposit { account, amount }
  'POST /tx/deposit': async (_q, b) => {
    const account = requireAddress(b.account, 'account');
    const amount = parseUnits(String(b.amount), 6);
    const allowance = await chain.usdc.allowance(account, cfg.vault);
    return {
      approval:
        allowance >= amount ? null : { to: cfg.usdc, data: iface.erc20.encodeFunctionData('approve', [cfg.vault, MaxUint256]) },
      tx: { to: cfg.vault, data: iface.vault.encodeFunctionData('deposit', [amount, account]) },
    };
  },

  // POST /tx/withdraw { account, amount }  (amount in USDC; "max" = everything withdrawable)
  'POST /tx/withdraw': async (_q, b) => {
    const account = requireAddress(b.account, 'account');
    const maxR = await chain.vault.maxRedeem(account);
    let shares = maxR;
    if (b.amount !== 'max') {
      const supply = await chain.vault.totalSupply();
      const tvl = await chain.vault.totalAssets();
      shares = tvl === 0n ? 0n : (parseUnits(String(b.amount), 6) * supply) / tvl;
      if (shares > maxR) shares = maxR;
    }
    if (shares === 0n) throw new PricingError('Nothing withdrawable right now (liquidity is reserved for open parlays)');
    return { tx: { to: cfg.vault, data: iface.vault.encodeFunctionData('redeem', [shares, account, account]) } };
  },

  // POST /tx/faucet { account } (testnet MockUSDC only)
  'POST /tx/faucet': async (_q, b) => {
    if (!cfg.mockUsdc) throw new PricingError('Faucet only exists on testnet');
    const account = requireAddress(b.account, 'account');
    return { tx: { to: cfg.usdc, data: iface.erc20.encodeFunctionData('faucet', [account, parseUnits('1000', 6)]) } };
  },
};

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'not found' });
  try {
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    }
    send(res, 200, await handler(Object.fromEntries(url.searchParams), body));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.shortMessage || e.message });
  }
});

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log(`ParlayKit quoter on :${PORT}  chain=${cfg.chainName} (${cfg.chainId})  engine=${cfg.engine}`);
  console.log(`signer=${chain.signer.address}  demo=${cfg.demo}`);
});
