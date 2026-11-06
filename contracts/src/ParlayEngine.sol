// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ParlayVault} from "./ParlayVault.sol";
import {IConditionalTokens} from "./interfaces/IConditionalTokens.sol";

/// @title ParlayEngine
/// @notice Sells parlays on top of existing prediction markets, backed by ParlayVault.
///
/// Flow
///  1. The quoter reads live leg prices from the venue (e.g. Polymarket best ask) and signs an
///     EIP-712 quote binding buyer, stake, legs (conditionId, outcome, price) and a short deadline.
///  2. buyParlay() verifies the signature and prices the parlay ON-CHAIN:
///        fair  = Π price_i                       (v1: independence, product of marginals)
///        price = fair * (1 + edge)               edge = baseEdge + perLegEdge * (n - 1)
///        maxPayout = stake / price
///     Risk limits are checked against the vault, the stake moves into the vault, and the buyer
///     receives an ERC-721 ticket (transferable parlay position).
///  3. settle() is permissionless. It reads each leg's payout vector from the Conditional Tokens
///     contract the venue settles on (Polymarket: CTF on Polygon). Final payout is
///        maxPayout * Π (numerator_i / denominator_i)
///     so a clean win pays maxPayout, any losing leg pays 0 (and can be settled early), and a
///     50/50 or partially-resolved market is handled exactly like the underlying market pays.
///
/// v2 (ParlayMarket, Rana et al. 2026): replace `fair = Π price_i` with the joint marginal of a
/// pairwise exponential-family model learned from base and parlay trades, so correlated legs are
/// priced coherently from a single liquidity pool. The quote format already carries per-leg prices
/// and the engine's pricing is isolated in quotePayout(), so that swap is local.
contract ParlayEngine is ERC721Enumerable, EIP712, Ownable {
    using SafeERC20 for IERC20;

    struct Leg {
        bytes32 conditionId; // CTF condition id of the market
        uint8 outcome; // outcome index (Polymarket binary: 0 = Yes, 1 = No)
        uint32 priceE6; // price of that outcome in 1e6 (0.42 => 420_000)
    }

    enum Status {
        None,
        Open,
        Won,
        Lost,
        Voided
    }

    struct Parlay {
        uint128 stake;
        uint128 maxPayout;
        uint64 createdAt;
        uint64 settledAt;
        Status status;
        uint256 paid;
    }

    bytes32 public constant QUOTE_TYPEHASH =
        keccak256("Quote(address buyer,uint256 stake,bytes32 legsHash,uint256 deadline,uint256 nonce)");

    uint256 private constant ONE = 1e18;
    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdc;
    ParlayVault public immutable vault;
    IConditionalTokens public ctf;
    address public quoteSigner;

    // pricing + risk parameters
    uint16 public baseEdgeBps = 200; // 2% house edge on any parlay
    uint16 public perLegEdgeBps = 100; // +1% per extra leg (compounding correlation/model risk)
    uint16 public maxRiskBps = 500; // net risk of one parlay <= 5% of free liquidity
    uint16 public maxUtilBps = 8_000; // locked payouts <= 80% of vault balance
    uint8 public maxLegs = 8;
    uint32 public minPriceE6 = 20_000; // legs priced < 2c rejected (oracle / dust risk)
    uint32 public maxPriceE6 = 980_000; // legs priced > 98c rejected (no value in a parlay)
    uint256 public minStake = 1e6; // 1 USDC

    uint256 public nextId = 1;
    mapping(uint256 => Parlay) public parlays;
    mapping(uint256 => Leg[]) internal _legs;
    mapping(uint256 => bool) public nonceUsed;

    event ParlayOpened(uint256 indexed id, address indexed buyer, uint256 stake, uint256 maxPayout, Leg[] legs);
    event ParlaySettled(uint256 indexed id, Status status, uint256 paid);
    event ParamsUpdated();
    event QuoteSignerUpdated(address signer);

    error QuoteExpired();
    error NonceUsed();
    error BadSignature();
    error BadLegCount();
    error BadLeg(uint256 index);
    error DuplicateMarket(uint256 index);
    error LegAlreadyResolved(uint256 index);
    error StakeTooSmall();
    error RiskLimit();
    error UtilizationLimit();
    error NotOpen();
    error NotResolved();

    constructor(IERC20 usdc_, ParlayVault vault_, IConditionalTokens ctf_, address quoteSigner_)
        ERC721("ParlayKit Ticket", "PARLAY")
        EIP712("ParlayKit", "1")
        Ownable(msg.sender)
    {
        usdc = usdc_;
        vault = vault_;
        ctf = ctf_;
        quoteSigner = quoteSigner_;
    }

    // ================================================================ pricing

    function edgeBps(uint256 nLegs) public view returns (uint256) {
        return uint256(baseEdgeBps) + uint256(perLegEdgeBps) * (nLegs - 1);
    }

    /// @notice Prices a parlay. Pure function of signed leg prices + engine parameters.
    /// @return maxPayout   USDC paid if every leg wins
    /// @return fairPrice   Π price_i, 1e18 = 100%
    /// @return offerPrice  fairPrice * (1 + edge), 1e18 = 100%
    function quotePayout(Leg[] calldata legs, uint256 stake)
        public
        view
        returns (uint256 maxPayout, uint256 fairPrice, uint256 offerPrice)
    {
        uint256 n = legs.length;
        if (n < 2 || n > maxLegs) revert BadLegCount();
        fairPrice = ONE;
        for (uint256 i; i < n; ++i) {
            fairPrice = (fairPrice * legs[i].priceE6) / 1e6;
        }
        offerPrice = (fairPrice * (BPS + edgeBps(n))) / BPS;
        if (offerPrice == 0 || offerPrice >= ONE) revert BadLegCount();
        maxPayout = (stake * ONE) / offerPrice;
    }

    function hashLegs(Leg[] calldata legs) public pure returns (bytes32) {
        return keccak256(abi.encode(legs));
    }

    function quoteDigest(address buyer, uint256 stake, bytes32 legsHash, uint256 deadline, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, buyer, stake, legsHash, deadline, nonce)));
    }

    // ================================================================ buy

    function buyParlay(Leg[] calldata legs, uint256 stake, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        returns (uint256 id)
    {
        if (block.timestamp > deadline) revert QuoteExpired();
        if (nonceUsed[nonce]) revert NonceUsed();
        if (stake < minStake) revert StakeTooSmall();
        _validateLegs(legs);

        bytes32 digest = quoteDigest(msg.sender, stake, hashLegs(legs), deadline, nonce);
        if (ECDSA.recover(digest, signature) != quoteSigner) revert BadSignature();
        nonceUsed[nonce] = true;

        (uint256 maxPayout,,) = quotePayout(legs, stake);
        _checkRisk(stake, maxPayout);

        usdc.safeTransferFrom(msg.sender, address(vault), stake);
        vault.onParlayOpened(stake, maxPayout);

        id = nextId++;
        parlays[id] = Parlay({
            stake: uint128(stake),
            maxPayout: uint128(maxPayout),
            createdAt: uint64(block.timestamp),
            settledAt: 0,
            status: Status.Open,
            paid: 0
        });
        for (uint256 i; i < legs.length; ++i) {
            _legs[id].push(legs[i]);
        }
        _safeMint(msg.sender, id);
        emit ParlayOpened(id, msg.sender, stake, maxPayout, legs);
    }

    function _validateLegs(Leg[] calldata legs) internal view {
        uint256 n = legs.length;
        if (n < 2 || n > maxLegs) revert BadLegCount();
        for (uint256 i; i < n; ++i) {
            Leg calldata l = legs[i];
            if (l.outcome > 1 || l.priceE6 < minPriceE6 || l.priceE6 > maxPriceE6) revert BadLeg(i);
            for (uint256 j; j < i; ++j) {
                if (legs[j].conditionId == l.conditionId) revert DuplicateMarket(i);
            }
            if (ctf.payoutDenominator(l.conditionId) != 0) revert LegAlreadyResolved(i);
        }
    }

    /// @notice Max net risk (payout - stake) the vault will take on one parlay right now.
    function maxNetRisk() public view returns (uint256) {
        return (vault.freeLiquidity() * maxRiskBps) / BPS;
    }

    function _checkRisk(uint256 stake, uint256 maxPayout) internal view {
        if (maxPayout - stake > maxNetRisk()) revert RiskLimit();
        uint256 balAfter = vault.balance() + stake;
        if ((vault.lockedPayout() + maxPayout) * BPS > balAfter * maxUtilBps) revert UtilizationLimit();
    }

    // ================================================================ settle

    /// @return state 0 = pending, 1 = won (payout may be partial for 50/50 legs), 2 = lost
    /// @return amount USDC the ticket holder receives on settle()
    function previewSettlement(uint256 id) public view returns (uint8 state, uint256 amount) {
        Leg[] storage legs = _legs[id];
        amount = parlays[id].maxPayout;
        bool pending;
        for (uint256 i; i < legs.length; ++i) {
            uint256 den = ctf.payoutDenominator(legs[i].conditionId);
            if (den == 0) {
                pending = true;
                continue;
            }
            uint256 num = ctf.payoutNumerators(legs[i].conditionId, legs[i].outcome);
            if (num == 0) return (2, 0); // any losing leg kills the parlay, even before others resolve
            amount = (amount * num) / den;
        }
        if (pending) return (0, 0);
        return (1, amount);
    }

    /// @notice Permissionless: anyone (keeper, buyer, LP) can settle once the outcome is known.
    function settle(uint256 id) external {
        Parlay storage p = parlays[id];
        if (p.status != Status.Open) revert NotOpen();
        (uint8 state, uint256 amount) = previewSettlement(id);
        if (state == 0) revert NotResolved();

        p.settledAt = uint64(block.timestamp);
        if (state == 2) {
            p.status = Status.Lost;
            vault.onParlaySettled(p.stake, p.maxPayout, address(0), 0);
        } else {
            p.status = Status.Won;
            p.paid = amount;
            vault.onParlaySettled(p.stake, p.maxPayout, ownerOf(id), amount);
        }
        emit ParlaySettled(id, p.status, amount);
    }

    /// @notice MVP escape hatch: refund the stake if a market is cancelled / never resolves.
    function voidParlay(uint256 id) external onlyOwner {
        Parlay storage p = parlays[id];
        if (p.status != Status.Open) revert NotOpen();
        p.status = Status.Voided;
        p.settledAt = uint64(block.timestamp);
        p.paid = p.stake;
        vault.onParlaySettled(p.stake, p.maxPayout, ownerOf(id), p.stake);
        emit ParlaySettled(id, Status.Voided, p.stake);
    }

    // ================================================================ views for UIs

    function getLegs(uint256 id) external view returns (Leg[] memory) {
        return _legs[id];
    }

    function parlaysOf(address owner_) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner_);
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = tokenOfOwnerByIndex(owner_, i);
        }
    }

    // ================================================================ admin

    function setQuoteSigner(address s) external onlyOwner {
        quoteSigner = s;
        emit QuoteSignerUpdated(s);
    }

    function setCtf(IConditionalTokens ctf_) external onlyOwner {
        ctf = ctf_;
        emit ParamsUpdated();
    }

    function setParams(
        uint16 baseEdgeBps_,
        uint16 perLegEdgeBps_,
        uint16 maxRiskBps_,
        uint16 maxUtilBps_,
        uint8 maxLegs_,
        uint32 minPriceE6_,
        uint32 maxPriceE6_,
        uint256 minStake_
    ) external onlyOwner {
        require(maxUtilBps_ <= BPS && maxRiskBps_ <= BPS && maxLegs_ >= 2 && minPriceE6_ > 0 && maxPriceE6_ < 1e6);
        baseEdgeBps = baseEdgeBps_;
        perLegEdgeBps = perLegEdgeBps_;
        maxRiskBps = maxRiskBps_;
        maxUtilBps = maxUtilBps_;
        maxLegs = maxLegs_;
        minPriceE6 = minPriceE6_;
        maxPriceE6 = maxPriceE6_;
        minStake = minStake_;
        emit ParamsUpdated();
    }
}
