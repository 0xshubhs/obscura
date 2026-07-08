// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockTokenX} from "../src/MockTokenX.sol";
import {Treasury} from "../src/Treasury.sol";
import {ConfidentialUSDC} from "../src/ConfidentialUSDC.sol";
import {Obscura} from "../src/Obscura.sol";

/// @notice Deploy script for SilentBID-ZAMA on Sepolia FHEVM (chainId 11155111).
///         Run: `forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY`
///         Outputs deployed addresses to stdout — copy them to the frontend's `.env.local`.
contract DeployScript is Script {
    function run() external {
        console2.log("Deployer:", msg.sender);

        vm.startBroadcast();

        MockUSDC usdc = new MockUSDC();
        console2.log("MockUSDC:", address(usdc));

        MockTokenX tokenX = new MockTokenX("TokenX", "TKX", 1_000_000 ether);
        console2.log("MockTokenX:", address(tokenX));

        ConfidentialUSDC cusdc = new ConfidentialUSDC(address(usdc));
        console2.log("ConfidentialUSDC:", address(cusdc));

        Treasury treasury = new Treasury(250); // 2.5% fee
        console2.log("Treasury:", address(treasury));

        Obscura auction = new Obscura(address(cusdc), address(treasury));
        console2.log("Obscura:", address(auction));

        treasury.authorizeContract(address(auction));
        console2.log("Authorized auction in Treasury");

        vm.stopBroadcast();

        console2.log("\n=== Add to frontend .env.local ===");
        console2.log("NEXT_PUBLIC_NETWORK=sepolia");
        console2.log("NEXT_PUBLIC_USDC_ADDRESS=", address(usdc));
        console2.log("NEXT_PUBLIC_TOKENX_ADDRESS=", address(tokenX));
        console2.log("NEXT_PUBLIC_CUSDC_ADDRESS=", address(cusdc));
        console2.log("NEXT_PUBLIC_TREASURY_ADDRESS=", address(treasury));
        console2.log("NEXT_PUBLIC_AUCTION_ADDRESS=", address(auction));
    }
}
