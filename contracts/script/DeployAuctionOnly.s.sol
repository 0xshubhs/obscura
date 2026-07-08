// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {Treasury} from "../src/Treasury.sol";
import {Obscura} from "../src/Obscura.sol";

/// @notice Redeploy ONLY the Obscura auction — carrying the fixed TOKEN-mode
///         positional cleartext encoding in `_verifyTokenDecryption` — while
///         reusing the already-deployed ConfidentialUSDC + Treasury so existing
///         cUSDC balances and treasury config are preserved.
///         Run: forge script script/DeployAuctionOnly.s.sol:DeployAuctionOnly \
///                --rpc-url sepolia --broadcast --account default
contract DeployAuctionOnly is Script {
    // Existing live deployment on Ethereum Sepolia (chainId 11155111).
    address constant CUSDC = 0x0a229d9E8CB39C4724deBFFF376acD23D102Fa83;
    address constant TREASURY = 0x10692e22152330eF971A18129247CDbF776aA068;

    function run() external {
        console2.log("Deployer:", msg.sender);

        vm.startBroadcast();

        Obscura auction = new Obscura(CUSDC, TREASURY);
        console2.log("New Obscura:", address(auction));

        // Treasury.authorizeContract is onlyOwner; the deployer is the owner.
        Treasury(payable(TREASURY)).authorizeContract(address(auction));
        console2.log("Authorized new auction in Treasury");

        vm.stopBroadcast();

        console2.log("\n=== Update frontend .env.local ===");
        console2.log("NEXT_PUBLIC_AUCTION_ADDRESS=", address(auction));
    }
}
