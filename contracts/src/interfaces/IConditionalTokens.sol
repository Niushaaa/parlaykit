// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal read interface of the Gnosis Conditional Tokens Framework (CTF).
/// Polymarket settles every market on CTF (Polygon: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045),
/// so a parlay leg can be settled trustlessly by reading the reported payout vector.
/// For Polymarket binary markets outcome index 0 = "Yes", 1 = "No".
interface IConditionalTokens {
    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256);
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);
}
