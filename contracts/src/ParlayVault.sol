// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ParlayVault
/// @notice ERC-4626 liquidity vault that acts as the counterparty ("the house") for every parlay.
///         LPs deposit USDC and receive pkUSDC shares. Stakes flow in, winning payouts flow out.
///
/// Accounting
///  - pendingPremium: stakes of parlays that are still open. They sit in the vault but are not yet
///    earned, so they are excluded from totalAssets() (share price only moves on settlement).
///  - lockedPayout:   sum of the maximum payouts of open parlays. This much USDC must stay in the
///    vault, so LP withdrawals are capped at freeLiquidity() = balance - lockedPayout.
contract ParlayVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    address public engine;
    uint256 public lockedPayout;
    uint256 public pendingPremium;

    event EngineSet(address engine);
    event ParlayOpened(uint256 stake, uint256 maxPayout);
    event ParlaySettled(uint256 stake, uint256 maxPayout, address to, uint256 paid);

    error OnlyEngine();
    error InsufficientLiquidity();

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(IERC20 asset_) ERC20("ParlayKit LP USDC", "pkUSDC") ERC4626(asset_) Ownable(msg.sender) {}

    function setEngine(address engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(engine_);
    }

    // ---------------------------------------------------------------- views

    function balance() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice LP-owned assets: everything in the vault except unearned premium of open parlays.
    function totalAssets() public view override returns (uint256) {
        uint256 bal = balance();
        return bal > pendingPremium ? bal - pendingPremium : 0;
    }

    /// @notice USDC not reserved for potential payouts. Withdrawals and new risk come from here.
    function freeLiquidity() public view returns (uint256) {
        uint256 bal = balance();
        return bal > lockedPayout ? bal - lockedPayout : 0;
    }

    /// @notice Share of the vault balance currently reserved for open parlays, in bps.
    function utilizationBps() external view returns (uint256) {
        uint256 bal = balance();
        return bal == 0 ? 0 : (lockedPayout * 10_000) / bal;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 m = super.maxWithdraw(owner_);
        uint256 f = freeLiquidity();
        return m < f ? m : f;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 m = super.maxRedeem(owner_);
        uint256 f = convertToShares(freeLiquidity());
        return m < f ? m : f;
    }

    // ---------------------------------------------------------------- engine hooks

    /// @dev Called by the engine after it moved `stake` from the buyer into this vault.
    function onParlayOpened(uint256 stake, uint256 maxPayout) external onlyEngine {
        pendingPremium += stake;
        lockedPayout += maxPayout;
        if (lockedPayout > balance()) revert InsufficientLiquidity();
        emit ParlayOpened(stake, maxPayout);
    }

    /// @dev Releases the reservation and pays `amount` (0 for a losing parlay) to `to`.
    function onParlaySettled(uint256 stake, uint256 maxPayout, address to, uint256 amount) external onlyEngine {
        pendingPremium -= stake;
        lockedPayout -= maxPayout;
        if (amount > 0) IERC20(asset()).safeTransfer(to, amount);
        emit ParlaySettled(stake, maxPayout, to, amount);
    }
}
