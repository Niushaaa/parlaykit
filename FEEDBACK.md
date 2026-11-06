# Developer feedback

Feedback for the ETHGlobal Mumbai partners whose tech is on ParlayKit's roadmap. ParlayKit v1 (built at this hackathon) does not integrate these yet. What follows comes from evaluating their docs and APIs while designing v2, and from the problems we hit in v1 that their tech solves.

---

## Uniswap

**Uniswap Developer Feedback Form:** submitted on 2026-11-06 by the ParlayKit team.

### How Uniswap fits ParlayKit v2

The ParlayKit LP vault (`contracts/src/ParlayVault.sol`) is an ERC-4626 vault that acts as the house for every parlay. It has a liquidity-planning problem:

- **Idle capital.** Most of the vault's USDC is free liquidity (`freeLiquidity()`) earning nothing between parlays.
- **Trapped exits.** LP withdrawals are capped (`maxWithdraw()`) while payouts for open parlays are reserved (`lockedPayout`), so LPs can be stuck at high utilization.

v2 uses Uniswap for both:

1. **Idle-capital planning.** Free liquidity above a utilization-based buffer is deployed into a concentrated USDC/stable Uniswap v4 position and pulled back automatically when reserved payouts rise.
2. **Instant LP exits.** A `pkUSDC/USDC` v4 pool with a NAV hook lets LPs sell vault shares when withdrawals are capped. The hook prices shares near NAV, with a discount that scales with vault utilization.
3. **Any-token entry.** Bettors and LPs fund stakes and deposits in any token, swapped to USDC through the Universal Router in the same transaction.

### What worked

- Concentrated liquidity plus v4 hooks map well onto vault designs. A hook that reads an ERC-4626 `convertToAssets()` lets a pool price a yield-bearing share without an external oracle.
- Permit2 at the same address on every chain makes multi-chain integration simpler.

### Friction / suggestions

- **Docs location.** The docs are split between `docs.uniswap.org` and `developers.uniswap.org`, and search results mix both. It wasn't always clear which page was current.
- **Per-chain addresses.** The docs warn that addresses differ per chain (correctly). For a hackathon team picking a testnet in minutes, a single machine-readable deployments feed linked from the top of the v4 docs, with testnets included and a "which testnets have real liquidity" note, would save a lot of time.
- **Missing template.** A v4 hook that prices an ERC-4626 share at NAV, with a configurable discount curve, would be a widely reused template for vault and LP-token builders.
- **Testnet liquidity.** Thin pools on testnets make swap-based demos unreliable. A documented faucet-plus-seeded-pool setup for one canonical testnet would help.

---

## Chainlink

### How Chainlink fits ParlayKit v2

ParlayEngine reads each leg's outcome through a minimal interface: `payoutNumerators` / `payoutDenominator` (`contracts/src/interfaces/IConditionalTokens.sol`). The source is swappable via `setCtf()`. In v1 the testnet resolver is updated by an admin script.

In v2 a **CRE workflow** replaces that script:

- It runs on a cron trigger. The nodes fetch each open leg's resolution from the venue's API, reach consensus, and write a signed report to a resolver contract that implements the same interface.
- The same report triggers `settle()` for finished parlays. Winners are paid automatically, and LPs can't time withdrawals around known-but-unsettled outcomes.
- The vault can live on any chain while markets settle elsewhere. CCIP is the follow-up for cross-chain resolution messages.

### Friction / suggestions

- We looked for prediction-market odds as a Chainlink feed. We found that Chainlink supplies asset prices *to* Polymarket for resolution, but there is no feed of Polymarket's own odds. Saying this explicitly in the docs would save teams time.
- A CRE template for "mirror an external market's resolution into an on-chain resolver interface" would be very reusable across prediction-market projects.
- Please state clearly which testnets support CRE write simulation (`--broadcast`), and whether `cre workflow simulate` needs `cre login`.

---

## Ethereum Foundation (CROPS)

See the [CROPS section in the README](README.md#crops).

### Feedback

- CROPS works well as a design checklist. Having to pick one lead property forced us to decide what must keep working if our own backend goes offline. For ParlayKit that is settlement.
- A short reference list of CROPS-compliant building blocks would help teams apply it quickly: private RPC options such as Anon-RPC, tracker-free analytics alternatives, permissionless-settlement patterns.
- A non-video way to prove the lead property would help, for example a scripted test that shuts down the backend and still settles.
