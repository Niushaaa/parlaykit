// Polymarket adapter: reads events/markets from the public Gamma API.
// Every Polymarket market settles on the Gnosis Conditional Tokens contract on Polygon, keyed by
// `conditionId` — the same id ParlayEngine reads at settlement.
//
// Pricing side: a parlay leg should cost what the user would pay to buy that outcome alone,
// i.e. the best ASK. Gamma exposes bestBid/bestAsk for the YES token, so
//   YES ask = bestAsk,  NO ask = 1 - bestBid.
// Falls back to outcomePrices (last/mid) when the book fields are missing.

const GAMMA = process.env.GAMMA_URL || 'https://gamma-api.polymarket.com';
const TTL_MS = 10_000;
const cache = new Map(); // slug -> { at, event }

function parseJSONField(v, fallback) {
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeMarket(m, ev) {
  const outcomes = parseJSONField(m.outcomes, ['Yes', 'No']);
  const outcomePrices = parseJSONField(m.outcomePrices, []).map(Number);
  const bestAsk = num(m.bestAsk);
  const bestBid = num(m.bestBid);
  const yesAsk = bestAsk && bestAsk > 0 && bestAsk < 1 ? bestAsk : outcomePrices[0];
  const noAsk = bestBid && bestBid > 0 && bestBid < 1 ? 1 - bestBid : outcomePrices[1];
  return {
    venue: 'polymarket',
    eventId: String(ev?.id ?? m.eventId ?? m.conditionId),
    eventSlug: ev?.slug,
    eventTitle: ev?.title,
    conditionId: m.conditionId,
    question: m.question,
    groupItemTitle: m.groupItemTitle || null,
    slug: m.slug,
    image: m.icon || m.image || ev?.icon || null,
    outcomes,
    prices: [round4(yesAsk), round4(noAsk)], // what a buyer pays per outcome, used for pricing
    mid: outcomePrices.map(round4),
    negRisk: Boolean(m.negRisk ?? ev?.negRisk),
    endDate: m.endDate || ev?.endDate || null,
    tradable: Boolean(m.active && !m.closed && m.acceptingOrders !== false) && outcomes.length === 2,
    url: ev?.slug ? `https://polymarket.com/event/${ev.slug}` : null,
  };
}

function round4(x) {
  return x == null || Number.isNaN(x) ? null : Math.round(x * 1e4) / 1e4;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'parlaykit-quoter/0.1' } });
  if (!res.ok) throw new Error(`Polymarket API ${res.status} for ${url}`);
  return res.json();
}

export async function getEvent(slug, { fresh = false } = {}) {
  const hit = cache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.event;
  const arr = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  const ev = Array.isArray(arr) ? arr[0] : arr;
  if (!ev) throw Object.assign(new Error(`No Polymarket event "${slug}"`), { status: 404 });
  const event = {
    venue: 'polymarket',
    id: String(ev.id),
    slug: ev.slug,
    title: ev.title,
    image: ev.icon || ev.image || null,
    negRisk: Boolean(ev.negRisk),
    endDate: ev.endDate || null,
    url: `https://polymarket.com/event/${ev.slug}`,
    markets: (ev.markets || []).map((m) => normalizeMarket(m, ev)).filter((m) => m.conditionId),
  };
  cache.set(slug, { at: Date.now(), event });
  return event;
}

export async function getMarketByCondition(conditionId) {
  const arr = await getJSON(`${GAMMA}/markets?condition_ids=${conditionId}`);
  const m = Array.isArray(arr) ? arr[0] : null;
  if (!m) throw Object.assign(new Error(`Unknown Polymarket market ${conditionId}`), { status: 404 });
  const ev = Array.isArray(m.events) ? m.events[0] : null;
  return normalizeMarket(m, ev);
}
