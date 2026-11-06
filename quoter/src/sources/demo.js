// Demo venue: fictional events served when DEMO=1 (offline demos, judging-room wifi, local tests).
// Same normalized shape as the Polymarket adapter. Prices drift slowly so the slip looks live.
import { keccak256, toUtf8Bytes } from 'ethers';

const EVENTS = [
  {
    slug: 'btc-above-150k-dec-31',
    title: 'Bitcoin above $150k on Dec 31?',
    markets: [{ slug: 'btc-150k', question: 'Bitcoin above $150k on Dec 31?', yes: 0.34 }],
  },
  {
    slug: 'eth-above-6k-dec-31',
    title: 'ETH above $6,000 on Dec 31?',
    markets: [{ slug: 'eth-6k', question: 'ETH above $6,000 on Dec 31?', yes: 0.41 }],
  },
  {
    slug: 'l2-10b-tvl-2026',
    title: 'Will a new L2 pass $10B TVL in 2026?',
    markets: [{ slug: 'l2-10b', question: 'Will a new L2 pass $10B TVL in 2026?', yes: 0.22 }],
  },
  {
    slug: 'monsoon-fc-vs-harbor-city',
    title: 'Monsoon FC vs Harbor City (fictional demo match)',
    markets: [
      { slug: 'monsoon-win', question: 'Monsoon FC win?', yes: 0.48 },
      { slug: 'over-2-5', question: 'Over 2.5 goals?', yes: 0.57 },
    ],
  },
  {
    slug: 'gas-below-5-gwei-nov',
    title: 'Ethereum average gas below 5 gwei in November?',
    markets: [{ slug: 'gas-5', question: 'Average gas below 5 gwei in November?', yes: 0.63 }],
  },
  {
    slug: 'demo-cup-winner',
    title: 'Demo Cup winner (fictional)',
    negRisk: true,
    markets: [
      { slug: 'team-aurora', question: 'Team Aurora wins the Demo Cup?', group: 'Aurora', yes: 0.45 },
      { slug: 'team-basalt', question: 'Team Basalt wins the Demo Cup?', group: 'Basalt', yes: 0.35 },
      { slug: 'team-cobalt', question: 'Team Cobalt wins the Demo Cup?', group: 'Cobalt', yes: 0.2 },
    ],
  },
];

export function demoConditionId(marketSlug) {
  return keccak256(toUtf8Bytes(`parlaykit-demo:${marketSlug}`));
}

function wobble(base, seed) {
  const t = Date.now() / 60_000; // one cycle every ~6 min
  const p = base + 0.015 * Math.sin(t + seed);
  return Math.min(0.97, Math.max(0.03, p));
}

function build(ev, idx) {
  const markets = ev.markets.map((m, j) => {
    const yes = wobble(m.yes, idx * 3 + j);
    const spread = 0.01;
    const yesAsk = Math.round((yes + spread / 2) * 1e4) / 1e4;
    const noAsk = Math.round((1 - yes + spread / 2) * 1e4) / 1e4;
    return {
      venue: 'demo',
      eventId: `demo-${idx}`,
      eventSlug: ev.slug,
      eventTitle: ev.title,
      conditionId: demoConditionId(m.slug),
      question: m.question,
      groupItemTitle: m.group || null,
      slug: m.slug,
      image: null,
      outcomes: ['Yes', 'No'],
      prices: [yesAsk, noAsk],
      mid: [Math.round(yes * 1e4) / 1e4, Math.round((1 - yes) * 1e4) / 1e4],
      negRisk: Boolean(ev.negRisk),
      endDate: '2026-12-31T23:59:59Z',
      tradable: true,
      url: null,
    };
  });
  return {
    venue: 'demo',
    id: `demo-${idx}`,
    slug: ev.slug,
    title: ev.title,
    image: null,
    negRisk: Boolean(ev.negRisk),
    endDate: '2026-12-31T23:59:59Z',
    url: null,
    markets,
  };
}

export async function getEvent(slug) {
  const idx = EVENTS.findIndex((e) => e.slug === slug);
  if (idx < 0) throw Object.assign(new Error(`No demo event "${slug}"`), { status: 404 });
  return build(EVENTS[idx], idx);
}

export async function listEvents() {
  return EVENTS.map(build);
}

export async function getMarketByCondition(conditionId) {
  for (const [i, ev] of EVENTS.entries()) {
    const e = build(ev, i);
    const m = e.markets.find((x) => x.conditionId.toLowerCase() === conditionId.toLowerCase());
    if (m) return m;
  }
  throw Object.assign(new Error(`Unknown demo market ${conditionId}`), { status: 404 });
}
