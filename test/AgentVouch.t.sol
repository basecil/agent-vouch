// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AgentVouch} from "../src/AgentVouch.sol";

/// @title MockAgentIdRegistry
/// @notice Minimal stand-in for the Agent ID registry: only balanceOf, with
/// settable balances so tests can grant/revoke Agent IDs at will.
contract MockAgentIdRegistry {
    mapping(address => uint256) private _balances;

    function setBalance(address account, uint256 balance) external {
        _balances[account] = balance;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }
}

contract AgentVouchTest is Test {
    AgentVouch public vouch;
    MockAgentIdRegistry public registry;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public dave = makeAddr("dave");
    address public noId = makeAddr("noId");

    event Vouched(address indexed voucher, address indexed target);
    event Unvouched(address indexed voucher, address indexed target);

    function setUp() public {
        registry = new MockAgentIdRegistry();
        vouch = new AgentVouch(address(registry));

        // Everyone except `noId` holds an Agent ID.
        registry.setBalance(alice, 1);
        registry.setBalance(bob, 1);
        registry.setBalance(carol, 1);
        registry.setBalance(dave, 1);
    }

    // -- happy path ---------------------------------------------------------

    function test_VouchHappyPath() public {
        vm.prank(alice);
        vouch.vouch(bob);

        assertTrue(vouch.hasVouched(alice, bob));
        assertEq(vouch.vouchCount(bob), 1);
        assertEq(vouch.totalVouches(), 1);

        address[] memory given = vouch.getVouchesGiven(alice);
        assertEq(given.length, 1);
        assertEq(given[0], bob);
    }

    function test_VouchEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(vouch));
        emit Vouched(alice, bob);

        vm.prank(alice);
        vouch.vouch(bob);
    }

    function test_MultipleVouchersSameTarget() public {
        vm.prank(alice);
        vouch.vouch(bob);
        vm.prank(carol);
        vouch.vouch(bob);
        vm.prank(dave);
        vouch.vouch(bob);

        assertEq(vouch.vouchCount(bob), 3);
        assertEq(vouch.totalVouches(), 3);
    }

    function test_OneVoucherMultipleTargets() public {
        vm.startPrank(alice);
        vouch.vouch(bob);
        vouch.vouch(carol);
        vouch.vouch(dave);
        vm.stopPrank();

        assertEq(vouch.totalVouches(), 3);
        address[] memory given = vouch.getVouchesGiven(alice);
        assertEq(given.length, 3);
        assertEq(given[0], bob);
        assertEq(given[1], carol);
        assertEq(given[2], dave);
    }

    // -- revert cases -------------------------------------------------------

    function test_Revert_CallerHasNoAgentId() public {
        vm.prank(noId);
        vm.expectRevert(AgentVouch.CallerHasNoAgentId.selector);
        vouch.vouch(bob);
    }

    function test_Revert_TargetHasNoAgentId() public {
        vm.prank(alice);
        vm.expectRevert(AgentVouch.TargetHasNoAgentId.selector);
        vouch.vouch(noId);
    }

    function test_Revert_CannotVouchForSelf() public {
        vm.prank(alice);
        vm.expectRevert(AgentVouch.CannotVouchForSelf.selector);
        vouch.vouch(alice);
    }

    function test_Revert_DuplicateVouch() public {
        vm.prank(alice);
        vouch.vouch(bob);

        vm.prank(alice);
        vm.expectRevert(AgentVouch.AlreadyVouched.selector);
        vouch.vouch(bob);
    }

    function test_Revert_ZeroRegistry() public {
        vm.expectRevert(AgentVouch.InvalidRegistry.selector);
        new AgentVouch(address(0));
    }

    // -- unvouch ------------------------------------------------------------

    function test_UnvouchSuccess() public {
        vm.prank(alice);
        vouch.vouch(bob);

        vm.expectEmit(true, true, false, true, address(vouch));
        emit Unvouched(alice, bob);

        vm.prank(alice);
        vouch.unvouch(bob);

        assertFalse(vouch.hasVouched(alice, bob));
        assertEq(vouch.vouchCount(bob), 0);
        assertEq(vouch.totalVouches(), 0);
        assertEq(vouch.getVouchesGiven(alice).length, 0);
    }

    function test_Revert_UnvouchWithoutVouch() public {
        vm.prank(alice);
        vm.expectRevert(AgentVouch.NoVouchExists.selector);
        vouch.unvouch(bob);
    }

    function test_Revert_UnvouchTwice() public {
        vm.prank(alice);
        vouch.vouch(bob);
        vm.prank(alice);
        vouch.unvouch(bob);

        vm.prank(alice);
        vm.expectRevert(AgentVouch.NoVouchExists.selector);
        vouch.unvouch(bob);
    }

    function test_VouchAgainAfterUnvouch() public {
        vm.prank(alice);
        vouch.vouch(bob);
        vm.prank(alice);
        vouch.unvouch(bob);

        vm.prank(alice);
        vouch.vouch(bob);

        assertTrue(vouch.hasVouched(alice, bob));
        assertEq(vouch.vouchCount(bob), 1);
        assertEq(vouch.totalVouches(), 1);
    }

    // -- enumeration / swap-and-pop ----------------------------------------

    function test_SwapAndPop_RemovesMiddleElement() public {
        // alice vouches bob, carol, dave -> [bob, carol, dave]
        vm.startPrank(alice);
        vouch.vouch(bob);
        vouch.vouch(carol);
        vouch.vouch(dave);
        // Remove carol (middle): dave is swapped into carol's slot.
        vouch.unvouch(carol);
        vm.stopPrank();

        address[] memory given = vouch.getVouchesGiven(alice);
        assertEq(given.length, 2);
        assertEq(given[0], bob);
        assertEq(given[1], dave); // swapped into the removed slot

        assertFalse(vouch.hasVouched(alice, carol));
        assertTrue(vouch.hasVouched(alice, bob));
        assertTrue(vouch.hasVouched(alice, dave));
        assertEq(vouch.vouchCount(carol), 0);
        assertEq(vouch.totalVouches(), 2);
    }

    function test_SwapAndPop_RemovesLastElement() public {
        vm.startPrank(alice);
        vouch.vouch(bob);
        vouch.vouch(carol);
        vouch.vouch(dave);
        vouch.unvouch(dave); // last element: plain pop, no swap
        vm.stopPrank();

        address[] memory given = vouch.getVouchesGiven(alice);
        assertEq(given.length, 2);
        assertEq(given[0], bob);
        assertEq(given[1], carol);
    }

    function test_SwapAndPop_RemovedTargetCanBeVouchedAgain() public {
        // After swap-and-pop, the moved element's index must be correct, and
        // the removed target must be vouchable again.
        vm.startPrank(alice);
        vouch.vouch(bob);
        vouch.vouch(carol);
        vouch.vouch(dave);
        vouch.unvouch(carol); // dave moves into slot 1
        vouch.unvouch(dave); // dave removed via its updated index
        vouch.vouch(carol); // carol vouchable again
        vm.stopPrank();

        address[] memory given = vouch.getVouchesGiven(alice);
        assertEq(given.length, 2);
        assertEq(given[0], bob);
        assertEq(given[1], carol);
        assertEq(vouch.totalVouches(), 2);
    }

    function test_SwapAndPop_RemoveAllOneByOne() public {
        vm.startPrank(alice);
        vouch.vouch(bob);
        vouch.vouch(carol);
        vouch.vouch(dave);
        vouch.unvouch(bob);
        vouch.unvouch(dave);
        vouch.unvouch(carol);
        vm.stopPrank();

        assertEq(vouch.getVouchesGiven(alice).length, 0);
        assertEq(vouch.totalVouches(), 0);
        assertEq(vouch.vouchCount(bob), 0);
        assertEq(vouch.vouchCount(carol), 0);
        assertEq(vouch.vouchCount(dave), 0);
    }

    function test_CountsUnaffectedByOtherVouchersUnvouch() public {
        vm.prank(alice);
        vouch.vouch(bob);
        vm.prank(carol);
        vouch.vouch(bob);

        vm.prank(alice);
        vouch.unvouch(bob);

        assertEq(vouch.vouchCount(bob), 1);
        assertTrue(vouch.hasVouched(carol, bob));
        assertEq(vouch.totalVouches(), 1);
    }

    // -- registry wiring ----------------------------------------------------

    function test_RegistryAddressStored() public view {
        assertEq(address(vouch.agentIdRegistry()), address(registry));
    }

    function test_VouchFailsIfCallerLosesAgentId() public {
        vm.prank(alice);
        vouch.vouch(bob);

        // Alice's Agent ID is gone (non-transferable in reality, but the
        // contract must not assume it); new vouches must fail.
        registry.setBalance(alice, 0);

        vm.prank(alice);
        vm.expectRevert(AgentVouch.CallerHasNoAgentId.selector);
        vouch.vouch(carol);

        // Existing vouch is untouched and still removable.
        vm.prank(alice);
        vouch.unvouch(bob);
        assertEq(vouch.totalVouches(), 0);
    }
}
