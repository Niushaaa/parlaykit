// Parlay pricing. Mirrors ParlayEngine.quotePayout() bit-for-bit (BigInt integer math), so the
// number the extension shows is exactly what the contract will pay.
//
// v1 (MVP): independence assumption — the parlay's fair price is the product of leg prices.
//   fair  = Π p_i
//   offer = fair * (1 + edge),  edge = baseEdge + perLegEdge * (n - 1)
//   payout = stake / offer
//
// v2 (ParlayMarket, Rana/Nadkarni/Moshrefi/Viswanath 2026): replace `fair` with the joint marginal
// of a pairwise exponential-family model whose parameters are updated online from base-market and
// parlay trades. `correlationAdjust` below is the hook: today it returns 1 (independence).

const ONE = 10n ** 18n;
const BPS = 10_000n;

export const DEFAULT_PARAMS = {
  baseEdgeBps: 200,
  perLegEdgeBps: 100,
  maxRiskBps: 500,
  maxUtilBps: 8000,
  maxLegs: 8,
  minPriceE6: 20_000,
  maxPriceE6: 980_000,
  minStake: 1_000_000n,
};

export function toPriceE6(p) {
  return Math.round(Number(p) * 1e6);
}

export function edgeBps(params, n) {
  return BigInt(params.baseEdgeBps) + BigInt(params.perLegEdgeBps) * BigInt(n - 1);
}

/** Hook for the ParlayMarket pairwise model (v2). v1 = independence. */
export function correlationAdjust(/* legs */) {
  return 1;
}

/**
 * @param legs   [{ priceE6 }]
 * @param stake  bigint, USDC base units (6 dp)
 */
export function quotePayout(params, legs, stake) {
  const n = legs.length;
  if (n < 2 || n > params.maxLegs) throw new PricingError(`A parlay needs 2-${params.maxLegs} legs`);
  let fair = ONE;
  for (const l of legs) fair = (fair * BigInt(l.priceE6)) / 1_000_000n;
  const e = edgeBps(params, n);
  const offer = (fair * (BPS + e)) / BPS;
  if (offer === 0n || offer >= ONE) throw new PricingError('Parlay price out of range');
  const maxPayout = (stake * ONE) / offer;
  return {
    fairPrice: fair,
    offerPrice: offer,
    edgeBps: Number(e),
    maxPayout,
    multiplier: Number((maxPayout * 10_000n) / (stake === 0n ? 1n : stake)) / 10_000,
    fairProbability: Number(fair) / 1e18,
    offerProbability: Number(offer) / 1e18,
  };
}

export function validateLegPrices(params, legs) {
  legs.forEach((l, i) => {
    if (l.priceE6 < params.minPriceE6 || l.priceE6 > params.maxPriceE6) {
      throw new PricingError(
        `Leg ${i + 1} is priced at ${(l.priceE6 / 1e4).toFixed(1)}¢ — legs must be between ` +
          `${params.minPriceE6 / 1e4}¢ and ${params.maxPriceE6 / 1e4}¢`
      );
    }
  });
}

/** One leg per event: legs inside the same event are usually mutually exclusive or correlated. */
export function validateIndependence(legs) {
  const seenEvent = new Map();
  const seenCond = new Set();
  legs.forEach((l, i) => {
    if (seenCond.has(l.conditionId)) throw new PricingError(`Leg ${i + 1} repeats a market already in the slip`);
    seenCond.add(l.conditionId);
    if (l.eventId != null) {
      if (seenEvent.has(l.eventId)) {
        throw new PricingError(
          `Legs ${seenEvent.get(l.eventId) + 1} and ${i + 1} come from the same event — v1 only prices ` +
            `independent legs (correlated legs arrive with the ParlayMarket model in v2)`
        );
      }
      seenEvent.set(l.eventId, i);
    }
  });
}

export class PricingError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}
