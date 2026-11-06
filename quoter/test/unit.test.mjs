import test from 'node:test';
import assert from 'node:assert/strict';
import { quotePayout, DEFAULT_PARAMS, validateIndependence, validateLegPrices } from '../src/pricing.js';
import { normalizeMarket } from '../src/sources/polymarket.js';

test('pricing matches ParlayEngine.quotePayout exactly (same vector as the Foundry test)', () => {
  const legs = [{ priceE6: 500_000 }, { priceE6: 400_000 }, { priceE6: 800_000 }];
  const r = quotePayout(DEFAULT_PARAMS, legs, 10_000_000n);
  assert.equal(r.fairPrice, 160000000000000000n); // 0.16
  assert.equal(r.offerPrice, 166400000000000000n); // 0.1664 (4% edge on 3 legs)
  assert.equal(r.maxPayout, 60_096_153n);
  assert.equal(r.edgeBps, 400);
});

test('one leg per event; no duplicate markets', () => {
  assert.throws(() => validateIndependence([{ conditionId: '0x1', eventId: 'a' }, { conditionId: '0x2', eventId: 'a' }]), /same event/);
  assert.throws(() => validateIndependence([{ conditionId: '0x1', eventId: 'a' }, { conditionId: '0x1', eventId: 'b' }]), /repeats/);
  validateIndependence([{ conditionId: '0x1', eventId: 'a' }, { conditionId: '0x2', eventId: 'b' }]);
});

test('leg price bounds', () => {
  assert.throws(() => validateLegPrices(DEFAULT_PARAMS, [{ priceE6: 990_000 }]), /between/);
  validateLegPrices(DEFAULT_PARAMS, [{ priceE6: 500_000 }]);
});

test('Polymarket Gamma market normalizes to ask prices (stringified arrays, bestBid/bestAsk for YES)', () => {
  const ev = { id: '123', slug: 'some-event', title: 'Some event' };
  const m = normalizeMarket(
    {
      question: 'Will X happen?',
      conditionId: '0xabc',
      slug: 'will-x',
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.62", "0.38"]',
      bestBid: 0.61,
      bestAsk: 0.63,
      active: true,
      closed: false,
      acceptingOrders: true,
    },
    ev
  );
  assert.deepEqual(m.outcomes, ['Yes', 'No']);
  assert.deepEqual(m.prices, [0.63, 0.39]); // YES ask = bestAsk, NO ask = 1 - bestBid
  assert.deepEqual(m.mid, [0.62, 0.38]);
  assert.equal(m.tradable, true);
  assert.equal(m.eventId, '123');
  assert.equal(m.url, 'https://polymarket.com/event/some-event');
});

test('closed / non-binary markets are not tradable; missing book falls back to outcomePrices', () => {
  const m = normalizeMarket({ conditionId: '0x1', outcomes: '["A","B","C"]', outcomePrices: '["0.2","0.3","0.5"]', active: true, closed: false }, {});
  assert.equal(m.tradable, false);
  const m2 = normalizeMarket({ conditionId: '0x2', outcomes: '["Chiefs","Chargers"]', outcomePrices: '["0.55","0.45"]', active: true, closed: false }, {});
  assert.equal(m2.tradable, true);
  assert.deepEqual(m2.prices, [0.55, 0.45]);
});
