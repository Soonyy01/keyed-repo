// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/Keyed.sol";

contract Reenterer {
    Keyed k;
    address creator;
    bool attacking;

    constructor(Keyed _k, address _creator) {
        k = _k;
        creator = _creator;
    }

    function buy() external payable {
        k.buyKeys{value: msg.value}(creator, 1);
    }

    function sell() external {
        attacking = true;
        k.sellKeys(creator, 1, 0);
    }

    receive() external payable {
        if (attacking) {
            attacking = false;
            k.sellKeys(creator, 1, 0); // must revert
        }
    }
}

contract RevertingCreator {
    function launch(Keyed k) external {
        k.launchClub("Bad", "", "", "", 100, 0);
    }
    receive() external payable {
        revert("no");
    }
}

contract KeyedTest is Test {
    Keyed k;
    address owner = address(this);
    address alice = makeAddr("alice"); // creator
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    receive() external payable {}

    function setUp() public {
        k = new Keyed();
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
        vm.prank(alice);
        k.launchClub("Alice", "@alice", "", "hi", 100, 5000); // 50% of creator fee to holders
    }

    function _buy(address who, address creator, uint256 amt) internal {
        uint256 cost = k.getBuyPriceAfterFee(creator, amt);
        vm.prank(who);
        k.buyKeys{value: cost}(creator, amt);
    }

    function test_launchGivesFreeKey() public view {
        assertEq(k.balanceOf(alice, alice), 1);
        Keyed.ClubView memory v = k.getClub(alice);
        assertEq(v.supply, 1);
        assertEq(v.holderCount, 1);
        assertEq(v.name, "Alice");
        assertEq(k.clubCount(), 1);
    }

    function test_cannotLaunchTwice() public {
        vm.prank(alice);
        vm.expectRevert("Club already exists");
        k.launchClub("A", "", "", "", 100, 0);
    }

    function test_launchValidation() public {
        vm.startPrank(bob);
        vm.expectRevert("Bad max supply");
        k.launchClub("B", "", "", "", 1, 0);
        vm.expectRevert("Bad max supply");
        k.launchClub("B", "", "", "", 5001, 0);
        vm.expectRevert("Bad holder share");
        k.launchClub("B", "", "", "", 10, 10001);
        vm.expectRevert("Name: 1-40 chars");
        k.launchClub("", "", "", "", 10, 0);
        vm.stopPrank();
    }

    function test_priceCurve() public view {
        assertEq(k.getPrice(0, 1), 0);
        assertEq(k.getPrice(1, 1), 1 ether / 16000);
        assertEq(k.getPrice(2, 1), 4 ether / 16000);
        assertEq(k.getPrice(1, 2), 5 ether / 16000);
        assertEq(k.getPrice(0, 3), 5 ether / 16000);
    }

    function test_buyFeesAndRefund() public {
        uint256 value = k.getPrice(1, 2);
        uint256 cost = k.getBuyPriceAfterFee(alice, 2);
        assertEq(cost, value + (value * 400) / 10000);
        uint256 before = bob.balance;
        vm.prank(bob);
        k.buyKeys{value: cost + 1 ether}(alice, 2);
        assertEq(before - bob.balance, cost, "refund excess");
        assertEq(k.balanceOf(alice, bob), 2);
        assertEq(k.credits(owner), (value * 100) / 10000);
        uint256 creatorTotal = (value * 300) / 10000;
        assertEq(k.credits(alice), creatorTotal - creatorTotal / 2);
        // only alice held before the buy, so she receives the whole holder fee
        assertEq(k.pendingRewards(alice, alice), creatorTotal / 2);
        assertEq(k.pendingRewards(alice, bob), 0);
    }

    function test_notEnoughEth() public {
        uint256 cost = k.getBuyPriceAfterFee(alice, 1);
        vm.prank(bob);
        vm.expectRevert("Not enough ETH");
        k.buyKeys{value: cost - 1}(alice, 1);
    }

    function test_soldOut() public {
        vm.prank(bob);
        k.launchClub("Bob", "", "", "", 3, 0);
        _buy(carol, bob, 2);
        uint256 cost = 10 ether;
        vm.prank(carol);
        vm.expectRevert("Sold out");
        k.buyKeys{value: cost}(bob, 1);
        assertEq(k.getBuyPriceAfterFee(bob, 1), 0);
    }

    function test_sellPaysCurveMinusFees() public {
        _buy(bob, alice, 3);
        uint256 value = k.getPrice(3, 1);
        uint256 expected = value - (value * 400) / 10000;
        assertEq(k.getSellPriceAfterFee(alice, 1), expected);
        uint256 before = bob.balance;
        vm.prank(bob);
        k.sellKeys(alice, 1, expected);
        assertEq(bob.balance - before, expected);
        assertEq(k.balanceOf(alice, bob), 2);
    }

    function test_slippageGuard() public {
        _buy(bob, alice, 2);
        uint256 quote = k.getSellPriceAfterFee(alice, 1);
        _buy(carol, alice, 1); // price moves up, fine
        vm.prank(bob);
        k.sellKeys(alice, 1, quote);
        // now someone sells ahead, price drops below a stale quote
        uint256 q2 = k.getSellPriceAfterFee(alice, 1);
        vm.prank(carol);
        k.sellKeys(alice, 1, 0);
        vm.prank(bob);
        vm.expectRevert("Price moved");
        k.sellKeys(alice, 1, q2);
    }

    function test_cannotSellLastKey() public {
        vm.prank(alice);
        vm.expectRevert("Cannot sell the last key");
        k.sellKeys(alice, 1, 0);
    }

    function test_cannotSellMoreThanHeld() public {
        _buy(bob, alice, 1);
        vm.prank(carol);
        vm.expectRevert("Not enough keys");
        k.sellKeys(alice, 1, 0);
    }

    function test_holderRewardsSplitByKeys() public {
        _buy(bob, alice, 3); // supply 4: alice 1, bob 3
        uint256 aBefore = k.pendingRewards(alice, alice);
        uint256 bBefore = k.pendingRewards(alice, bob);
        uint256 value = k.getPrice(4, 1);
        uint256 hFee = ((value * 300) / 10000) / 2;
        _buy(carol, alice, 1);
        uint256 aGain = k.pendingRewards(alice, alice) - aBefore;
        uint256 bGain = k.pendingRewards(alice, bob) - bBefore;
        assertApproxEqAbs(aGain, hFee / 4, 1);
        assertApproxEqAbs(bGain, (hFee * 3) / 4, 1);
        assertEq(k.pendingRewards(alice, carol), 0, "new buyer earns nothing from own buy");
    }

    function test_claimRewards() public {
        _buy(bob, alice, 3);
        _buy(carol, alice, 2);
        uint256 pending = k.pendingRewards(alice, bob);
        assertGt(pending, 0);
        address[] memory list = new address[](1);
        list[0] = alice;
        uint256 before = bob.balance;
        vm.prank(bob);
        k.claimRewards(list);
        assertEq(bob.balance - before, pending);
        assertEq(k.pendingRewards(alice, bob), 0);
        vm.prank(bob);
        vm.expectRevert("Nothing to claim");
        k.claimRewards(list);
    }

    function test_rewardsSurviveSellingAll() public {
        _buy(bob, alice, 2);
        _buy(carol, alice, 2);
        uint256 pending = k.pendingRewards(alice, bob);
        vm.prank(bob);
        k.sellKeys(alice, 2, 0);
        assertEq(k.balanceOf(alice, bob), 0);
        assertGe(k.pendingRewards(alice, bob), pending);
        (address[] memory clubs,,) = k.getHoldings(bob);
        assertEq(clubs.length, 1, "still listed while rewards unclaimed");
    }

    function test_withdrawCredits() public {
        _buy(bob, alice, 5);
        uint256 c = k.credits(alice);
        uint256 before = alice.balance;
        vm.prank(alice);
        k.withdraw();
        assertEq(alice.balance - before, c);
        vm.prank(alice);
        vm.expectRevert("Nothing to withdraw");
        k.withdraw();
        // protocol fees
        uint256 p = k.credits(owner);
        before = address(this).balance;
        k.withdraw();
        assertEq(address(this).balance - before, p);
    }

    function test_holderShareOnlyUp() public {
        vm.startPrank(alice);
        vm.expectRevert("Share can only go up");
        k.raiseHolderShare(4000);
        k.raiseHolderShare(6000);
        vm.expectRevert("Share can only go up");
        k.raiseHolderShare(6000);
        vm.stopPrank();
        assertEq(k.getClub(alice).holderShareBps, 6000);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(bob);
        vm.expectRevert("Not owner");
        k.setProtocolFeeDestination(bob);
        k.setProtocolFeeDestination(carol);
        _buy(bob, alice, 2);
        assertGt(k.credits(carol), 0);
    }

    function test_holdersList() public {
        _buy(bob, alice, 1);
        _buy(carol, alice, 1);
        (address[] memory a,) = k.getHolders(alice, 0, 10);
        assertEq(a.length, 3);
        vm.prank(bob);
        k.sellKeys(alice, 1, 0);
        (a,) = k.getHolders(alice, 0, 10);
        assertEq(a.length, 2);
        assertEq(k.getClub(alice).holderCount, 2);
    }

    function test_tradeHistory() public {
        _buy(bob, alice, 2);
        vm.prank(bob);
        k.sellKeys(alice, 1, 0);
        Keyed.TradeRecord[] memory t = k.getClubTrades(alice, 10);
        assertEq(t.length, 3); // launch, buy, sell
        assertEq(t[0].isBuy, false);
        assertEq(t[0].trader, bob);
        assertEq(t[1].amount, 2);
        assertEq(k.getRecentTrades(2).length, 2);
    }

    function test_getClubsNewestFirst() public {
        vm.prank(bob);
        k.launchClub("Bob", "", "", "", 50, 0);
        Keyed.ClubView[] memory v = k.getClubs(0, 10);
        assertEq(v.length, 2);
        assertEq(v[0].creator, bob);
        assertEq(k.getClubs(5, 10).length, 0);
    }

    function test_reentrancyBlocked() public {
        Reenterer r = new Reenterer(k, alice);
        vm.deal(address(r), 0);
        r.buy{value: 1 ether}();
        _buy(bob, alice, 2);
        vm.expectRevert("ETH transfer failed");
        r.sell();
    }

    function test_revertingCreatorCannotBlockTrades() public {
        RevertingCreator rc = new RevertingCreator();
        rc.launch(k);
        _buy(bob, address(rc), 3);
        vm.prank(bob);
        k.sellKeys(address(rc), 1, 0);
        assertGt(k.credits(address(rc)), 0);
    }

    // ------------------------------------------------------------ solvency fuzz

    function _owed() internal view returns (uint256 owed) {
        uint256 n = k.clubCount();
        for (uint256 i; i < n; ++i) {
            Keyed.ClubView memory v = k.getClub(k.creators(i));
            owed += k.getPrice(0, v.supply);
            owed += k.credits(v.creator);
        }
        owed += k.credits(owner) + k.rewardPool();
    }

    function testFuzz_solvent(uint256 seed) public {
        address[3] memory users = [alice, bob, carol];
        address[] memory list = new address[](1);
        list[0] = alice;
        for (uint256 i; i < 40; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address u = users[seed % 3];
            uint256 op = (seed >> 8) % 4;
            uint256 amt = 1 + ((seed >> 16) % 4);
            if (op <= 1) {
                uint256 cost = k.getBuyPriceAfterFee(alice, amt);
                if (cost == 0) continue;
                vm.prank(u);
                k.buyKeys{value: cost}(alice, amt);
            } else if (op == 2) {
                uint256 bal = k.balanceOf(alice, u);
                if (bal < amt || k.getClub(alice).supply <= amt) continue;
                vm.prank(u);
                k.sellKeys(alice, amt, 0);
            } else {
                if (k.pendingRewards(alice, u) == 0) continue;
                vm.prank(u);
                k.claimRewards(list);
            }
            assertGe(address(k).balance, _owed(), "insolvent");
        }
        // everyone exits: all holders except the last key can sell and claim
        for (uint256 j; j < 3; ++j) {
            address u = users[j];
            uint256 bal = k.balanceOf(alice, u);
            uint256 supply = k.getClub(alice).supply;
            uint256 sellable = bal < supply - 1 ? bal : supply - 1;
            while (sellable > 0) {
                uint256 a = sellable > 100 ? 100 : sellable;
                vm.prank(u);
                k.sellKeys(alice, a, 0);
                sellable -= a;
            }
        }
        for (uint256 j; j < 3; ++j) {
            if (k.pendingRewards(alice, users[j]) == 0) continue;
            vm.prank(users[j]);
            k.claimRewards(list);
        }
        if (k.credits(alice) > 0) {
            vm.prank(alice);
            k.withdraw();
        }
        if (k.credits(owner) > 0) k.withdraw();
        assertGe(address(k).balance, k.rewardPool());
    }
}
