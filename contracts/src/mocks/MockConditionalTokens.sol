// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet stand-in for the Gnosis CTF resolution storage. Exposes the exact same getters
///         (payoutNumerators / payoutDenominator) so ParlayEngine works unchanged on mainnet CTF.
///         On testnet the team mirrors real Polymarket resolutions with reportPayouts().
contract MockConditionalTokens is Ownable {
    mapping(bytes32 => uint256[]) internal _numerators;
    mapping(bytes32 => uint256) public payoutDenominator;

    event ConditionResolution(bytes32 indexed conditionId, uint256[] payoutNumerators);

    constructor() Ownable(msg.sender) {}

    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256) {
        uint256[] storage n = _numerators[conditionId];
        return index < n.length ? n[index] : 0;
    }

    /// @param payouts e.g. [1,0] = YES won, [0,1] = NO won, [1,1] = 50/50
    function reportPayouts(bytes32 conditionId, uint256[] calldata payouts) external onlyOwner {
        require(payoutDenominator[conditionId] == 0, "already resolved");
        uint256 den;
        for (uint256 i; i < payouts.length; ++i) {
            den += payouts[i];
        }
        require(den > 0, "empty payout");
        _numerators[conditionId] = payouts;
        payoutDenominator[conditionId] = den;
        emit ConditionResolution(conditionId, payouts);
    }
}
