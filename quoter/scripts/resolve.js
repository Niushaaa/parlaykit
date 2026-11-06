// Testnet helper: mirror a market's resolution onto MockConditionalTokens so parlays can settle.
// On Polygon mainnet this is unnecessary — Polymarket's own resolution lands in the real CTF.
//
//   node scripts/resolve.js <conditionId | demo-market-slug> <yes|no|split>
//   e.g. node scripts/resolve.js btc-150k yes
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, isHexString } from 'ethers';
import { loadConfig, CTF_ABI } from '../src/chain.js';
import { demoConditionId } from '../src/sources/demo.js';

const [, , target, result] = process.argv;
if (!target || !['yes', 'no', 'split'].includes(result)) {
  console.error('usage: node scripts/resolve.js <conditionId|demo-slug> <yes|no|split>');
  process.exit(1);
}
const cfg = loadConfig();
const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
const admin = new Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
const ctf = new Contract(cfg.ctf, CTF_ABI, admin);
const cid = isHexString(target, 32) ? target : demoConditionId(target);
const payouts = result === 'yes' ? [1, 0] : result === 'no' ? [0, 1] : [1, 1];
const tx = await ctf.reportPayouts(cid, payouts);
await tx.wait();
console.log(`resolved ${cid} -> ${result} (tx ${tx.hash})`);
