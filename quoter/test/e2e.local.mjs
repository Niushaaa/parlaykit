// End-to-end against a local anvil + quoter (DEMO=1). Run: node test/e2e.local.mjs
// Uses anvil's well-known dev account #1 as the bettor and #2 as an LP.
import { JsonRpcProvider, Wallet } from 'ethers';
const Q = process.env.QUOTER || 'http://127.0.0.1:8787';
const provider = new JsonRpcProvider(process.env.RPC_URL || 'http://127.0.0.1:8545', undefined, { cacheTimeout: -1 });
const bettor = new Wallet(process.env.BETTOR_PK, provider);
const lp = new Wallet(process.env.LP_PK, provider);
const j = async (path, body) => {
  const r = await fetch(Q + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${d.error}`);
  return d;
};
const send = async (w, tx) => (await w.sendTransaction(tx)).wait();
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓', m); };

const evs = await j('/demo/events');
const pick = (slug) => evs.find((e) => e.slug === slug).markets[0];
const legs = [
  { venue: 'demo', eventSlug: 'btc-above-150k-dec-31', conditionId: pick('btc-above-150k-dec-31').conditionId, outcome: 0 },
  { venue: 'demo', eventSlug: 'eth-above-6k-dec-31', conditionId: pick('eth-above-6k-dec-31').conditionId, outcome: 0 },
  { venue: 'demo', eventSlug: 'gas-below-5-gwei-nov', conditionId: pick('gas-below-5-gwei-nov').conditionId, outcome: 1 },
];

console.log('1. LP deposits 5,000 USDC');
await send(lp, (await j('/tx/faucet', { account: lp.address })).tx);
await send(lp, (await j('/tx/faucet', { account: lp.address })).tx);
await send(lp, (await j('/tx/faucet', { account: lp.address })).tx);
await send(lp, (await j('/tx/faucet', { account: lp.address })).tx);
await send(lp, (await j('/tx/faucet', { account: lp.address })).tx);
const dep = await j('/tx/deposit', { account: lp.address, amount: 5000 });
if (dep.approval) await send(lp, dep.approval);
await send(lp, dep.tx);
const v0 = await j(`/vault?account=${lp.address}`);
assert(v0.account.assets >= 4999.99, `LP position ${v0.account.assets} USDC`);

console.log('2. Same-event legs are rejected');
const ev = evs.find((e) => e.slug === 'monsoon-fc-vs-harbor-city');
try {
  await j('/price', { stake: 10, legs: ev.markets.map((m) => ({ venue: 'demo', eventSlug: ev.slug, conditionId: m.conditionId, outcome: 0 })) });
  assert(false, 'should reject');
} catch (e) { assert(/same event/.test(e.message), 'correlated legs rejected'); }

console.log('3. Bettor buys a 3-leg parlay for 20 USDC');
await send(bettor, (await j('/tx/faucet', { account: bettor.address })).tx);
const preview = await j('/price', { stake: 20, legs });
console.log(`   fair ${(preview.fairProbability * 100).toFixed(2)}%  offer ${(preview.offerProbability * 100).toFixed(2)}%  x${preview.multiplier}  payout ${preview.payout}`);
const q = await j('/quote', { buyer: bettor.address, stake: 20, legs });
if (q.approval) await send(bettor, q.approval);
await send(bettor, q.tx);
let mine = await j(`/parlays?account=${bettor.address}`);
assert(mine.length === 1 && mine[0].status === 'Open', 'parlay ticket minted, status Open');
assert(Math.abs(mine[0].maxPayout - q.payout) < 1e-6, `on-chain payout ${mine[0].maxPayout} == quoted ${q.payout}`);

console.log('4. Tampered quote is rejected on-chain');
const q2 = await j('/quote', { buyer: bettor.address, stake: 20, legs });
const sigHex = q2.signature.slice(2);
const forged = (parseInt(sigHex.slice(0, 8), 16) ^ 0xffffffff).toString(16).padStart(8, '0');
const bad = { ...q2.tx, data: q2.tx.data.replace(sigHex, forged + sigHex.slice(8)) };
assert(bad.data !== q2.tx.data, 'signature bytes modified');
let reverted = false;
try { await send(bettor, bad); } catch { reverted = true; }
assert(reverted, 'forged signature reverts on-chain');
assert((await j(`/parlays?account=${bettor.address}`)).length === 1, 'no second ticket minted');

console.log(`5. Markets resolve (run resolve.js) then settle`);
import { Contract } from 'ethers';
const cfg = await j('/config');
const admin = new Wallet(process.env.ADMIN_PK, provider);
const ctf = new Contract(cfg.ctf, ['function reportPayouts(bytes32,uint256[])'], admin);
const usdcBefore = (await j(`/vault?account=${bettor.address}`)).account.usdc;
await (await ctf.reportPayouts(legs[0].conditionId, [1, 0])).wait(); // YES
await (await ctf.reportPayouts(legs[1].conditionId, [1, 0])).wait(); // YES
mine = await j(`/parlays?account=${bettor.address}`);
assert(!mine[0].settleable, '2/3 legs won, still pending');
await (await ctf.reportPayouts(legs[2].conditionId, [0, 1])).wait(); // NO (we bet NO)
mine = await j(`/parlays?account=${bettor.address}`);
assert(mine[0].settleable && mine[0].settleOutcome === 'won', 'all legs won -> settleable');
await send(bettor, mine[0].settleTx);
mine = await j(`/parlays?account=${bettor.address}`);
const usdcAfter = (await j(`/vault?account=${bettor.address}`)).account.usdc;
assert(mine[0].status === 'Won', 'status Won');
assert(Math.abs(usdcAfter - usdcBefore - q.payout) < 1e-6, `bettor received ${(usdcAfter - usdcBefore).toFixed(6)} USDC`);
const v1 = await j(`/vault?account=${lp.address}`);
console.log(`   vault TVL ${v1.tvl}  locked ${v1.lockedPayout}  share price ${v1.sharePrice.toFixed(6)}`);
console.log('\nE2E OK');
