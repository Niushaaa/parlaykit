# ETHGlobal Mumbai: submission answers (copy/paste)

Deadline: **Sat Nov 7, 09:00 IST** (Fri Nov 6, 10:30 PM ET). Submit from the Hacker Dashboard.

---

## Project name

**ParlayKit**

## Short description (≤100 chars)

One-click parlays on Polymarket: a browser extension, live pricing, and an LP vault as the house.

## Description

Prediction markets only let you bet on one event at a time. If you believe three things will happen, you buy three positions and get three small payouts. Sportsbooks solved this long ago with parlays, but prediction markets don't offer them, because listing every combination fragments liquidity and multiplies market-maker risk.

ParlayKit adds parlays to the prediction markets people already use, without the venue changing anything. It is a browser extension that runs on Polymarket. When you browse an event or a category page, it detects every market on screen and pops up an offer to combine them. You tap Yes/No on two or more markets and see the combined probability, odds and payout update live from the venue's order book. Then you place the parlay from your own wallet in one transaction.

The parlay's counterparty is an ERC-4626 vault anyone can deposit USDC into. LPs earn the house edge on losing parlays and pay out winners. Each parlay is minted as a transferable ERC-721 ticket. Settlement is permissionless and trust-minimized: the contract reads the same Conditional Tokens payout vector that Polymarket itself pays out from. A losing leg settles the parlay immediately, a 50/50 market pays half, and a full win pays the holder.

Pricing in v1 is the product of the live leg prices plus a per-leg house edge. That is the independence special case of the ParlayMarket automated market maker (Rana et al., 2026), which v2 plugs in to price correlated legs coherently from the same pool. Risk limits (max net risk per parlay, a vault utilization cap, withdrawal caps for reserved payouts) keep LPs solvent by construction.

## How it's made

**Contracts (Solidity 0.8.26, Foundry, OpenZeppelin v5).** `ParlayEngine` verifies an EIP-712 quote (buyer, stake, legs as `{conditionId, outcome, priceE6}`, deadline, nonce), then **re-prices the parlay on-chain** (`Π price × (1 + edge)`) and enforces risk limits against the vault. It moves the stake into the vault and mints an ERC-721 ticket. `settle()` is permissionless: it reads `payoutNumerators`/`payoutDenominator` from the Gnosis Conditional Tokens contract (Polymarket's settlement layer on Polygon) and pays `maxPayout × Π(num/den)`. That one formula handles wins, early losses and 50/50 resolutions. `ParlayVault` is ERC-4626 with two extra ledgers: `pendingPremium`, which keeps open stakes out of share price until settlement, and `lockedPayout`, which caps LP withdrawals so winners can always be paid. There are 14 Foundry tests, including a fuzz test that the house never pays more than the fair independent payout.

**Quoter (Node + ethers v6).** Reads Polymarket's Gamma API and prices each leg at the outcome's **best ask** (YES = `bestAsk`, NO = `1 − bestBid`), i.e. what buying that leg alone would cost. Its BigInt math is bit-for-bit identical to the contract's, so the payout shown is exactly the payout paid. It never trusts client prices. It re-reads them, rejects resolved markets and correlated same-event legs, signs the quote, **dry-runs the exact transaction** with `eth_call`, and returns ready-to-send calldata.

**Extension (Chrome MV3, zero-dependency vanilla JS).** Site adapters find the event slugs visible on the page (Polymarket event and listing pages, a 1inch stub, and a demo venue). The UI lives in a Shadow DOM so it never clashes with the host site. A tiny MAIN-world script bridges to the user's own wallet (`window.ethereum`) over `postMessage`, so the extension never holds keys. It handles chain switching, USDC approval, buying, claiming, and LP deposit/withdraw.

**Hacky bit:** because the quoter returns encoded calldata, the extension needs no ABI library or bundler. Load it unpacked and it runs. We also built a fictional demo venue page plus a dev-wallet shim that routes to anvil, so the entire flow can be tested end to end in headless Chrome without MetaMask.

**Testnet setup:** Polygon Amoy with MockUSDC (public faucet) and a MockConditionalTokens that exposes the exact CTF getters. On mainnet you only swap two addresses to point at Polymarket's real CTF and USDC.e.

## AI tools used (required by the rules)

We used Claude (Anthropic) as an agentic coding assistant to generate the contracts, quoter, extension and docs from our product spec, and to run the tests. Full breakdown, including the original prompt and which parts the team built or changed, is in `AI_USAGE.md` in the repo.

> ⚠️ **Team:** fill in the "What the team did" section of AI_USAGE.md with your real contributions before submitting.

## Links

- GitHub: `https://github.com/<you>/parlaykit` ← push the repo and paste the link
- Demo video: upload the 2–4 min recording (see DEMO_SCRIPT.md)
- Live contracts (Amoy): paste the addresses from `contracts/deployments/80002.json` after you deploy

## Tech tags

Solidity · Foundry · OpenZeppelin · ERC-4626 · ERC-721 · EIP-712 · Polygon · Polymarket · Conditional Tokens · ethers.js · Node.js · Chrome Extension (MV3)

## Partner prizes (choose up to 3)

The prize list on your dashboard is the source of truth. We couldn't see the Mumbai partner list. Pick the partners whose tech you **actually integrated**, because you'll have to explain the integration and give feedback. Good fits for this build, if they're sponsors:

1. **Polygon**: contracts deployed on Polygon Amoy, settlement designed around Polymarket's CTF on Polygon PoS.
2. **1inch**: only if you finish a real 1inch integration during the event (e.g. a 1inch prediction-market adapter, or using 1inch swap so users can fund a parlay with any token). Today it is a stub, so don't claim it as-is.
3. A prediction-market, oracle or DeFi-vault sponsor whose SDK/API you wire in before the deadline.

Each partner form asks *"how did you use our tool"* and *"feedback"*. Answer concretely with file paths.
