import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, Interface } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LEG_TUPLE = 'tuple(bytes32 conditionId,uint8 outcome,uint32 priceE6)';

export const ENGINE_ABI = [
  `function quotePayout(${LEG_TUPLE}[] legs,uint256 stake) view returns (uint256 maxPayout,uint256 fairPrice,uint256 offerPrice)`,
  `function buyParlay(${LEG_TUPLE}[] legs,uint256 stake,uint256 deadline,uint256 nonce,bytes signature) returns (uint256)`,
  'function baseEdgeBps() view returns (uint16)',
  'function perLegEdgeBps() view returns (uint16)',
  'function maxRiskBps() view returns (uint16)',
  'function maxUtilBps() view returns (uint16)',
  'function maxLegs() view returns (uint8)',
  'function minPriceE6() view returns (uint32)',
  'function maxPriceE6() view returns (uint32)',
  'function minStake() view returns (uint256)',
  'function maxNetRisk() view returns (uint256)',
  'function quoteSigner() view returns (address)',
  'function parlaysOf(address) view returns (uint256[])',
  'function parlays(uint256) view returns (uint128 stake,uint128 maxPayout,uint64 createdAt,uint64 settledAt,uint8 status,uint256 paid)',
  `function getLegs(uint256) view returns (${LEG_TUPLE}[])`,
  'function previewSettlement(uint256) view returns (uint8 state,uint256 amount)',
  'function settle(uint256)',
  'function ownerOf(uint256) view returns (address)',
  'error QuoteExpired()',
  'error NonceUsed()',
  'error BadSignature()',
  'error BadLegCount()',
  'error BadLeg(uint256 index)',
  'error DuplicateMarket(uint256 index)',
  'error LegAlreadyResolved(uint256 index)',
  'error StakeTooSmall()',
  'error RiskLimit()',
  'error UtilizationLimit()',
  'error NotOpen()',
  'error NotResolved()',
  'event ParlayOpened(uint256 indexed id,address indexed buyer,uint256 stake,uint256 maxPayout,' + LEG_TUPLE + '[] legs)',
];

export const VAULT_ABI = [
  'function totalAssets() view returns (uint256)',
  'function balance() view returns (uint256)',
  'function lockedPayout() view returns (uint256)',
  'function pendingPremium() view returns (uint256)',
  'function freeLiquidity() view returns (uint256)',
  'function utilizationBps() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function deposit(uint256 assets,address receiver) returns (uint256)',
  'function redeem(uint256 shares,address receiver,address owner) returns (uint256)',
];

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function faucet(address,uint256)',
];

export const CTF_ABI = [
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32,uint256) view returns (uint256)',
  'function reportPayouts(bytes32,uint256[])',
];

export const iface = {
  engine: new Interface(ENGINE_ABI),
  vault: new Interface(VAULT_ABI),
  erc20: new Interface(ERC20_ABI),
};

export function loadConfig() {
  const chainId = Number(process.env.CHAIN_ID || 31337);
  let dep = {};
  const depFile = path.resolve(__dirname, '../../contracts/deployments', `${chainId}.json`);
  if (fs.existsSync(depFile)) dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const cfg = {
    chainId,
    rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
    engine: process.env.ENGINE || dep.engine,
    vault: process.env.VAULT || dep.vault,
    usdc: process.env.USDC || dep.usdc,
    ctf: process.env.CTF || dep.ctf,
    mockUsdc: process.env.MOCK_USDC ? process.env.MOCK_USDC === '1' : Boolean(dep.mockUsdc),
    explorer: process.env.EXPLORER || (chainId === 80002 ? 'https://amoy.polygonscan.com' : chainId === 137 ? 'https://polygonscan.com' : ''),
    chainName: process.env.CHAIN_NAME || (chainId === 80002 ? 'Polygon Amoy' : chainId === 137 ? 'Polygon' : 'Local Anvil'),
    quoteTtlSec: Number(process.env.QUOTE_TTL || 90),
    demo: process.env.DEMO === '1',
  };
  for (const k of ['engine', 'vault', 'usdc', 'ctf']) {
    if (!cfg[k]) throw new Error(`Missing ${k.toUpperCase()} address (env or contracts/deployments/${chainId}.json)`);
  }
  if (!process.env.QUOTER_PRIVATE_KEY) throw new Error('Missing QUOTER_PRIVATE_KEY');
  return cfg;
}

export function connect(cfg) {
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  const signer = new Wallet(process.env.QUOTER_PRIVATE_KEY);
  return {
    provider,
    signer,
    engine: new Contract(cfg.engine, ENGINE_ABI, provider),
    vault: new Contract(cfg.vault, VAULT_ABI, provider),
    usdc: new Contract(cfg.usdc, ERC20_ABI, provider),
    ctf: new Contract(cfg.ctf, CTF_ABI, provider),
  };
}

export async function readParams(engine) {
  const [baseEdgeBps, perLegEdgeBps, maxRiskBps, maxUtilBps, maxLegs, minPriceE6, maxPriceE6, minStake] =
    await Promise.all([
      engine.baseEdgeBps(),
      engine.perLegEdgeBps(),
      engine.maxRiskBps(),
      engine.maxUtilBps(),
      engine.maxLegs(),
      engine.minPriceE6(),
      engine.maxPriceE6(),
      engine.minStake(),
    ]);
  return {
    baseEdgeBps: Number(baseEdgeBps),
    perLegEdgeBps: Number(perLegEdgeBps),
    maxRiskBps: Number(maxRiskBps),
    maxUtilBps: Number(maxUtilBps),
    maxLegs: Number(maxLegs),
    minPriceE6: Number(minPriceE6),
    maxPriceE6: Number(maxPriceE6),
    minStake: BigInt(minStake),
  };
}
