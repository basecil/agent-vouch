// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAgentIdRegistry
/// @notice Minimal interface for the Agent ID registry (ERC-721). Only the
/// function AgentVouch needs is declared; no other registry behaviour is used.
interface IAgentIdRegistry {
    /// @notice Returns the number of Agent ID tokens held by `account`.
    function balanceOf(address account) external view returns (uint256);
}

/// @title AgentVouch
/// @notice On-chain reputation for AI agents, gated by Agent ID.
///
/// @dev Agent ID is a non-transferable ERC-721, one per Binance account. That
/// property is the whole sybil story: a vouch can only come from an address
/// that holds an Agent ID, and each account can only ever hold one. One vouch
/// per (voucher, target) pair, revocable at any time.
///
/// This contract has ZERO privileged functions: no owner, no admin, no pause,
/// no fees, no token, no ETH handling (no receive/fallback). Once deployed,
/// nobody — including the deployer — can change its behaviour, censor a
/// vouch, or extract value from it. That is deliberate.
contract AgentVouch {
    /// @notice The Agent ID registry contract (immutable, set at deploy time).
    IAgentIdRegistry public immutable agentIdRegistry;

    /// @notice Total number of active vouches across all agents.
    uint256 public totalVouches;

    /// @notice Number of active vouches a target has received.
    mapping(address target => uint256 count) private _vouchCount;

    /// @notice Whether `voucher` currently vouches for `target`.
    mapping(address voucher => mapping(address target => bool)) private _hasVouched;

    /// @notice Targets a voucher currently vouches for (enumeration).
    mapping(address voucher => address[] targets) private _vouchesGiven;

    /// @notice 1-based index of `target` inside `_vouchesGiven[voucher]`.
    /// @dev 1-based so the default value 0 unambiguously means "not present".
    /// Enables O(1) swap-and-pop removal in {unvouch}.
    mapping(address voucher => mapping(address target => uint256)) private _vouchIndex;

    /// @notice Emitted when `voucher` vouches for `target`.
    event Vouched(address indexed voucher, address indexed target);

    /// @notice Emitted when `voucher` removes their vouch for `target`.
    event Unvouched(address indexed voucher, address indexed target);

    /// @notice Caller does not hold an Agent ID.
    error CallerHasNoAgentId();

    /// @notice Target does not hold an Agent ID.
    error TargetHasNoAgentId();

    /// @notice An agent cannot vouch for itself.
    error CannotVouchForSelf();

    /// @notice Caller already vouches for this target.
    error AlreadyVouched();

    /// @notice No vouch from caller to this target exists to remove.
    error NoVouchExists();

    /// @notice Registry address must not be the zero address.
    error InvalidRegistry();

    /// @param registry_ Address of the Agent ID registry contract.
    constructor(address registry_) {
        if (registry_ == address(0)) revert InvalidRegistry();
        agentIdRegistry = IAgentIdRegistry(registry_);
    }

    /// @notice Vouch for another Agent ID holder.
    /// @param target Address of the agent to vouch for.
    /// @dev Reverts unless the caller and the target both hold an Agent ID,
    /// the target is not the caller, and no vouch from caller to target
    /// already exists.
    function vouch(address target) external {
        if (!_holdsAgentId(msg.sender)) revert CallerHasNoAgentId();
        if (!_holdsAgentId(target)) revert TargetHasNoAgentId();
        if (target == msg.sender) revert CannotVouchForSelf();
        if (_hasVouched[msg.sender][target]) revert AlreadyVouched();

        // _hasVouched is the vouch registry itself, not access control, and
        // this function emits Vouched below.
        // forge-lint: disable-next-line(missing-events-access-control)
        _hasVouched[msg.sender][target] = true;
        _vouchesGiven[msg.sender].push(target);
        _vouchIndex[msg.sender][target] = _vouchesGiven[msg.sender].length;
        _vouchCount[target] += 1;
        totalVouches += 1;

        emit Vouched(msg.sender, target);
    }

    /// @notice Remove a previously given vouch.
    /// @param target Address of the agent to stop vouching for.
    /// @dev Removal is O(1): the target is swapped with the last element of
    /// the caller's list and the list is popped. This does NOT preserve the
    /// order of the remaining entries.
    function unvouch(address target) external {
        if (!_hasVouched[msg.sender][target]) revert NoVouchExists();

        // See vouch(): this function emits Unvouched below.
        // forge-lint: disable-next-line(missing-events-access-control)
        _hasVouched[msg.sender][target] = false;

        // Swap-and-pop on the caller's enumeration list.
        uint256 index = _vouchIndex[msg.sender][target] - 1; // 0-based
        uint256 lastIndex = _vouchesGiven[msg.sender].length - 1;
        if (index != lastIndex) {
            address lastTarget = _vouchesGiven[msg.sender][lastIndex];
            _vouchesGiven[msg.sender][index] = lastTarget;
            _vouchIndex[msg.sender][lastTarget] = index + 1;
        }
        _vouchesGiven[msg.sender].pop();
        delete _vouchIndex[msg.sender][target];

        _vouchCount[target] -= 1;
        totalVouches -= 1;

        emit Unvouched(msg.sender, target);
    }

    /// @notice Number of active vouches `target` has received.
    function vouchCount(address target) external view returns (uint256) {
        return _vouchCount[target];
    }

    /// @notice Whether `voucher` currently vouches for `target`.
    function hasVouched(address voucher, address target) external view returns (bool) {
        return _hasVouched[voucher][target];
    }

    /// @notice All targets `voucher` currently vouches for.
    /// @dev Order is insertion order except where swap-and-pop removal has
    /// moved the last element into a removed slot.
    function getVouchesGiven(address voucher) external view returns (address[] memory) {
        return _vouchesGiven[voucher];
    }

    /// @dev An address holds an Agent ID iff its registry balance is > 0.
    function _holdsAgentId(address account) private view returns (bool) {
        return agentIdRegistry.balanceOf(account) > 0;
    }
}
