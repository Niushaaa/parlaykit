// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ParlayEngine} from "../src/ParlayEngine.sol";
import {ParlayVault} from "../src/ParlayVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockConditionalTokens} from "../src/mocks/MockConditionalTokens.sol";
import {IConditionalTokens} from "../src/interfaces/IConditionalTokens.sol";

/// Env:
///   PRIVATE_KEY      deployer
///   QUOTE_SIGNER     address of the quoter's signing key
///   USDC             (optional) existing USDC. If unset, MockUSDC is deployed (testnet)
///   CTF              (optional) existing Conditional Tokens. If unset, MockConditionalTokens is deployed
///                    Polygon mainnet Polymarket CTF: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
///   SEED_LIQUIDITY   (optional) USDC (6 dp) the deployer deposits into the vault. Mock USDC is minted.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address quoteSigner = vm.envAddress("QUOTE_SIGNER");
        address usdcAddr = vm.envOr("USDC", address(0));
        address ctfAddr = vm.envOr("CTF", address(0));
        uint256 seed = vm.envOr("SEED_LIQUIDITY", uint256(50_000e6));

        vm.startBroadcast(pk);

        bool mockUsdc = usdcAddr == address(0);
        if (mockUsdc) usdcAddr = address(new MockUSDC());
        if (ctfAddr == address(0)) ctfAddr = address(new MockConditionalTokens());

        ParlayVault vault = new ParlayVault(IERC20(usdcAddr));
        ParlayEngine engine = new ParlayEngine(IERC20(usdcAddr), vault, IConditionalTokens(ctfAddr), quoteSigner);
        vault.setEngine(address(engine));

        if (seed > 0) {
            if (mockUsdc) MockUSDC(usdcAddr).mint(deployer, seed);
            IERC20(usdcAddr).approve(address(vault), seed);
            vault.deposit(seed, deployer);
        }
        vm.stopBroadcast();

        console2.log("USDC  ", usdcAddr);
        console2.log("CTF   ", ctfAddr);
        console2.log("VAULT ", address(vault));
        console2.log("ENGINE", address(engine));

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "usdc", usdcAddr);
        vm.serializeAddress(k, "ctf", ctfAddr);
        vm.serializeAddress(k, "vault", address(vault));
        vm.serializeBool(k, "mockUsdc", mockUsdc);
        string memory json = vm.serializeAddress(k, "engine", address(engine));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
