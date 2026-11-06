// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet USDC with a public faucet. 6 decimals like the real thing.
contract MockUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Faucet: anyone can mint up to 10,000 USDC per call.
    function faucet(address to, uint256 amount) external {
        require(amount <= 10_000e6, "max 10k per call");
        _mint(to, amount);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
