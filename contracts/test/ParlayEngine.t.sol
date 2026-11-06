// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ParlayEngine} from "../src/ParlayEngine.sol";
import {ParlayVault} from "../src/ParlayVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockConditionalTokens} from "../src/mocks/MockConditionalTokens.sol";
import {IConditionalTokens} from "../src/interfaces/IConditionalTokens.sol";

contract ParlayEngineTest is Test {
    MockUSDC usdc;
    MockConditionalTokens ctf;
    ParlayVault vault;
    ParlayEngine engine;

    uint256 signerPk = 0xA11CE;
    address signer;
    address lp = address(0x1F);
    address alice = address(0xA1);
    address bob = address(0xB0);

    bytes32 constant C1 = keccak256("market-1");
    bytes32 constant C2 = keccak256("market-2");
    bytes32 constant C3 = keccak256("market-3");

    function setUp() public {
        signer = vm.addr(signerPk);
        usdc = new MockUSDC();
        ctf = new MockConditionalTokens();
        vault = new ParlayVault(usdc);
        engine = new ParlayEngine(usdc, vault, IConditionalTokens(address(ctf)), signer);
        vault.setEngine(address(engine));

        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6, lp);
        vm.stopPrank();

        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _legs3() internal pure returns (ParlayEngine.Leg[] memory legs) {
        legs = new ParlayEngine.Leg[](3);
        legs[0] = ParlayEngine.Leg(C1, 0, 500_000); // YES @ 0.50
        legs[1] = ParlayEngine.Leg(C2, 1, 400_000); // NO  @ 0.40
        legs[2] = ParlayEngine.Leg(C3, 0, 800_000); // YES @ 0.80
    }

    function _sign(address buyer, uint256 stake, ParlayEngine.Leg[] memory legs, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = engine.quoteDigest(buyer, stake, keccak256(abi.encode(legs)), deadline, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _buy(address buyer, uint256 stake, ParlayEngine.Leg[] memory legs, uint256 nonce)
        internal
        returns (uint256)
    {
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _sign(buyer, stake, legs, deadline, nonce);
        vm.prank(buyer);
        return engine.buyParlay(legs, stake, deadline, nonce, sig);
    }

    function _resolve(bytes32 c, uint256 yes, uint256 no) internal {
        uint256[] memory p = new uint256[](2);
        p[0] = yes;
        p[1] = no;
        ctf.reportPayouts(c, p);
    }

    // ------------------------------------------------------------ pricing

    function test_pricing_productOfPricesPlusEdge() public view {
        (uint256 payout, uint256 fair, uint256 offer) = engine.quotePayout(_legs3(), 10e6);
        // fair = 0.5 * 0.4 * 0.8 = 0.16
        assertEq(fair, 0.16e18);
        // edge = 2% + 1% * 2 = 4%  => offer = 0.1664
        assertEq(offer, 0.1664e18);
        // payout = 10 / 0.1664 = 60.096153 USDC
        assertEq(payout, 60_096_153);
    }

    // ------------------------------------------------------------ buy

    function test_buy_mintsTicketAndReserves() public {
        uint256 id = _buy(alice, 10e6, _legs3(), 1);
        assertEq(engine.ownerOf(id), alice);
        assertEq(usdc.balanceOf(alice), 990e6);
        assertEq(vault.pendingPremium(), 10e6);
        assertEq(vault.lockedPayout(), 60_096_153);
        // LP share value unchanged while the parlay is open
        assertEq(vault.totalAssets(), 100_000e6);
        assertEq(engine.getLegs(id).length, 3);
        assertEq(engine.parlaysOf(alice)[0], id);
    }

    function test_buy_revertsOnBadSignature() public {
        ParlayEngine.Leg[] memory legs = _legs3();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _sign(alice, 10e6, legs, deadline, 1);
        legs[0].priceE6 = 900_000; // tamper with a price after signing
        vm.prank(alice);
        vm.expectRevert(ParlayEngine.BadSignature.selector);
        engine.buyParlay(legs, 10e6, deadline, 1, sig);
    }

    function test_buy_revertsIfQuoteUsedByOtherBuyer() public {
        ParlayEngine.Leg[] memory legs = _legs3();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _sign(alice, 10e6, legs, deadline, 1);
        usdc.mint(bob, 100e6);
        vm.startPrank(bob);
        usdc.approve(address(engine), type(uint256).max);
        vm.expectRevert(ParlayEngine.BadSignature.selector);
        engine.buyParlay(legs, 10e6, deadline, 1, sig);
        vm.stopPrank();
    }

    function test_buy_revertsOnExpiredAndReplay() public {
        ParlayEngine.Leg[] memory legs = _legs3();
        _buy(alice, 10e6, legs, 7);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _sign(alice, 10e6, legs, deadline, 7);
        vm.prank(alice);
        vm.expectRevert(ParlayEngine.NonceUsed.selector);
        engine.buyParlay(legs, 10e6, deadline, 7, sig);

        sig = _sign(alice, 10e6, legs, deadline, 8);
        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(ParlayEngine.QuoteExpired.selector);
        engine.buyParlay(legs, 10e6, deadline, 8, sig);
    }

    function test_buy_revertsOnDuplicateMarketAndResolvedLeg() public {
        ParlayEngine.Leg[] memory legs = _legs3();
        legs[2].conditionId = C1;
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _sign(alice, 10e6, legs, deadline, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParlayEngine.DuplicateMarket.selector, 2));
        engine.buyParlay(legs, 10e6, deadline, 1, sig);

        legs = _legs3();
        _resolve(C3, 1, 0);
        sig = _sign(alice, 10e6, legs, deadline, 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParlayEngine.LegAlreadyResolved.selector, 2));
        engine.buyParlay(legs, 10e6, deadline, 2, sig);
    }

    function test_buy_respectsRiskLimit() public {
        // 5% of 100k free liquidity = 5k max net risk. 1000 USDC at ~6x => ~5k net risk -> reverts
        usdc.mint(alice, 10_000e6);
        ParlayEngine.Leg[] memory legs = _legs3();
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _sign(alice, 1_000e6, legs, deadline, 1);
        vm.prank(alice);
        vm.expectRevert(ParlayEngine.RiskLimit.selector);
        engine.buyParlay(legs, 1_000e6, deadline, 1, sig);
        // 500 USDC is fine
        _buy(alice, 500e6, legs, 2);
    }

    // ------------------------------------------------------------ settle

    function test_settle_win_paysHolderAndLPsLose() public {
        uint256 id = _buy(alice, 10e6, _legs3(), 1);
        _resolve(C1, 1, 0); // YES
        _resolve(C2, 0, 1); // NO
        (uint8 state,) = engine.previewSettlement(id);
        assertEq(state, 0); // still pending
        vm.expectRevert(ParlayEngine.NotResolved.selector);
        engine.settle(id);

        _resolve(C3, 1, 0); // YES
        engine.settle(id); // anyone can settle
        assertEq(usdc.balanceOf(alice), 990e6 + 60_096_153);
        assertEq(vault.lockedPayout(), 0);
        assertEq(vault.pendingPremium(), 0);
        assertEq(vault.totalAssets(), 100_000e6 + 10e6 - 60_096_153);
        (,,,, ParlayEngine.Status st, uint256 paid) = engine.parlays(id);
        assertEq(uint8(st), uint8(ParlayEngine.Status.Won));
        assertEq(paid, 60_096_153);
    }

    function test_settle_lossCanSettleEarly_LPsEarnStake() public {
        uint256 id = _buy(alice, 10e6, _legs3(), 1);
        _resolve(C2, 1, 0); // leg 2 wanted NO, YES won -> parlay lost immediately
        engine.settle(id);
        assertEq(vault.totalAssets(), 100_010e6);
        assertEq(vault.lockedPayout(), 0);
        (,,,, ParlayEngine.Status st,) = engine.parlays(id);
        assertEq(uint8(st), uint8(ParlayEngine.Status.Lost));
    }

    function test_settle_fiftyFiftyLegHalvesPayout() public {
        uint256 id = _buy(alice, 10e6, _legs3(), 1);
        _resolve(C1, 1, 1); // 50/50
        _resolve(C2, 0, 1);
        _resolve(C3, 1, 0);
        engine.settle(id);
        assertEq(usdc.balanceOf(alice), 990e6 + uint256(60_096_153) / 2);
    }

    function test_ticketIsTransferable_newOwnerGetsPaid() public {
        uint256 id = _buy(alice, 10e6, _legs3(), 1);
        vm.prank(alice);
        engine.transferFrom(alice, bob, id);
        _resolve(C1, 1, 0);
        _resolve(C2, 0, 1);
        _resolve(C3, 1, 0);
        engine.settle(id);
        assertEq(usdc.balanceOf(bob), 60_096_153);
    }

    function test_void_refundsStake() public {
        uint256 id = _buy(alice, 10e6, _legs3(), 1);
        engine.voidParlay(id);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(vault.totalAssets(), 100_000e6);
    }

    // ------------------------------------------------------------ vault

    function test_vault_withdrawCappedByLockedPayout() public {
        _buy(alice, 500e6, _legs3(), 1);
        uint256 locked = vault.lockedPayout();
        uint256 maxW = vault.maxWithdraw(lp);
        assertEq(maxW, 100_500e6 - locked);
        vm.prank(lp);
        vm.expectRevert();
        vault.withdraw(maxW + 1, lp, lp);
        vm.prank(lp);
        vault.withdraw(maxW, lp, lp);
    }

    function testFuzz_pricing_payoutNeverExceedsFair(uint32 p1, uint32 p2, uint96 stake) public view {
        p1 = uint32(bound(p1, 20_000, 980_000));
        p2 = uint32(bound(p2, 20_000, 980_000));
        stake = uint96(bound(stake, 1e6, 1e12));
        ParlayEngine.Leg[] memory legs = new ParlayEngine.Leg[](2);
        legs[0] = ParlayEngine.Leg(C1, 0, p1);
        legs[1] = ParlayEngine.Leg(C2, 0, p2);
        (uint256 payout, uint256 fair,) = engine.quotePayout(legs, stake);
        // house never offers more than the fair (independent) payout
        assertLe(payout, (uint256(stake) * 1e18) / fair);
    }
}
