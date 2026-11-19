// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AgentVouch} from "../src/AgentVouch.sol";

/// @title Deploy AgentVouch
/// @notice Deploys AgentVouch against the Agent ID registry on BSC mainnet.
/// @dev The deployer private key comes from the AGENT_VOUCH_DEPLOYER_KEY
/// environment variable. It is NEVER hardcoded and NEVER read from any file
/// by this script. Run with --broadcast only when the deployer is funded.
///
///   AGENT_VOUCH_DEPLOYER_KEY=0x... forge script script/Deploy.s.sol \
///       --rpc-url https://bsc-dataseed.bnbchain.org --broadcast
contract Deploy is Script {
    /// @notice Agent ID registry (SPACE ID Agent ID, ERC-721) on BSC mainnet.
    address public constant AGENT_ID_REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    function run() external returns (AgentVouch deployed) {
        uint256 deployerKey = vm.envUint("AGENT_VOUCH_DEPLOYER_KEY");

        vm.startBroadcast(deployerKey);
        deployed = new AgentVouch(AGENT_ID_REGISTRY);
        vm.stopBroadcast();

        console.log("AgentVouch deployed at:", address(deployed));
        console.log("Agent ID registry:   ", AGENT_ID_REGISTRY);
    }
}
