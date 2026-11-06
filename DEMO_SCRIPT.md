# Demo video script (target 3:15, hard limits 2:00–4:00)

**ETHGlobal rules that will get the video rejected:**
- ≥720p export
- 2–4 minutes
- no speed-up
- no music-with-captions instead of talking
- no phone recording
- **no AI voiceover / text-to-speech: record your own voice**

Use a screen recorder (OBS, QuickTime, Loom) at 1080p, in a quiet room, with a headset mic.

## Before you hit record

- Stack running (`./scripts/dev.sh` for local, or quoter on Amoy).
- Extension loaded, wallet on the right network with test USDC (or use `?devwallet=1` on the demo venue).
- Prepare 3 browser tabs:
  1. polymarket.com category page (e.g. Crypto)
  2. the demo venue
  3. a terminal for `resolve.js`
- Clear the slip and make sure the vault has liquidity.
- Close notifications. Zoom the browser to 110% so the panel text is readable.

## Script

| Time | Screen | Say (in your own words) |
|---|---|---|
| 0:00–0:15 | Title slide: *ParlayKit: parlays for prediction markets* | "Prediction markets are one-event-at-a-time. If you believe three things, you get three small payouts. ParlayKit adds parlays to Polymarket, with no changes needed from the venue." |
| 0:15–0:40 | Polymarket category page. Wait for the pop-up | "I'm just browsing Polymarket. The extension found every event on the screen and offers to combine them. I'll click Build parlay." |
| 0:40–1:15 | Tap Yes/No on 3 markets from **different** events. Try a second market from the same event to show it's disabled | "Each leg is priced at the live best ask, what buying it alone costs. Combined chance is the product of the legs plus a small house edge, so I see the odds and payout live. Legs from the same event are blocked, because they're correlated and v1 prices independent legs." |
| 1:15–1:50 | Set stake to 25. Click **Place parlay**. Show the wallet popup, approve, confirm | "When I place it, our quoter re-reads prices, signs an EIP-712 quote and dry-runs the transaction. The contract re-prices it on-chain, checks the vault's risk limits and mints me an NFT ticket. One transaction from my own wallet." |
| 1:50–2:15 | **Vault** tab: TVL, reserved, free liquidity, utilization | "Who's on the other side? An ERC-4626 vault anyone can LP into. Open stakes don't count toward share price until they settle, and payouts for open parlays are reserved, so withdrawals can never make a winner unpayable." |
| 2:15–2:50 | Terminal: `resolve.js` legs → **My parlays** shows ✓ ✓ ✓ → **Claim** | "Settlement reads the same Conditional Tokens payout vector Polymarket pays out from. Anyone can call it. All three legs won, so I claim. If any leg loses, it settles immediately. A 50/50 market pays half, exactly like the underlying." |
| 2:50–3:15 | Slide: *Roadmap* (≤4 bullets) | "Next is ParlayMarket pricing, a pairwise model so correlated legs are priced coherently from the same pool. Then more venues through adapters, multi-signer quotes, and hedging large parlays on the venue." |

**Roadmap slide (4 bullets max):**
- ParlayMarket pairwise pricing for correlated legs
- Adapters for more CTF venues (1inch, Kalshi-style)
- Multi-signer quotes and on-chain price checks
- Vault hedging on the underlying venue

## Live judging (4 min demo + 3 min Q&A)

Run the same flow live on the **demo venue** (it doesn't depend on venue wifi or geo-restrictions). Have the Polymarket version recorded as backup.

### Likely questions and crisp answers

- **"What stops someone gaming your prices?"** The quoter signs prices and the contract re-prices and enforces 2–98¢ legs, per-parlay risk (5% of free liquidity) and utilization (80%). Quotes last 90s, use a single-use nonce and are bound to the buyer. Remaining risk: a compromised signer. Next: multi-signer plus an on-chain deviation check.
- **"Isn't independence wrong for correlated markets?"** Yes. That's why v1 blocks same-event legs and charges +1% per leg. ParlayMarket learns pairwise correlations from parlay flow, and parlay trades are exactly what identify those correlations.
- **"Why would LPs deposit?"** The house edge is 2% + 1% per extra leg on every parlay, and risk limits are enforced on-chain. LP P&L is the spread between offered and true odds.
- **"Why not just list parlays on Polymarket?"** Combinatorial listings fragment liquidity. One vault backs every combination with no new markets.
- **"What did you build vs. reuse?"** Built: engine, vault, quoter, extension, demo venue. Reused: OpenZeppelin, ethers, Polymarket public APIs.
- **Inspiration / tools / challenges:** sportsbook parlays meet prediction markets. Hardest parts: settlement that handles partial resolutions, and keeping off-chain and on-chain pricing bit-identical.
