// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {Treasury} from "../src/Treasury.sol";
import {Obscura} from "../src/Obscura.sol";

/// @notice Redeploy ONLY the Obscura auction (now with sealed reserve, Vickrey
///         second-price, FHE-random tie-break, and the gas-compensation pool),
///         reusing the existing live token ecosystem so bidders keep their wrapped
///         cUSDC balances. Only NEXT_PUBLIC_AUCTION_ADDRESS changes afterwards.
///
///         Must be run by the Treasury owner (the original Boon deployer), since
///         it calls `treasury.authorizeContract(newAuction)`.
///
///         Run:
///           SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
///           forge script script/RedeployAuction.s.sol:RedeployAuctionScript \
///             --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY --slow
contract RedeployAuctionScript is Script {
    // Existing live deployment (Ethereum Sepolia) — reused as-is.
    address constant CUSDC = 0x7DDB59ad465Fc824BA6cAaD1848E8a34cDE63063;
    address constant TREASURY = 0x5b6fCb37Bc3106c76DD6C921cb049c84691b345A;

    function run() external {
        console2.log("Deployer:", msg.sender);
        console2.log("Reusing cUSDC:", CUSDC);
        console2.log("Reusing Treasury:", TREASURY);

        vm.startBroadcast();

        Obscura auction = new Obscura(CUSDC, TREASURY);
        console2.log("Obscura (new):", address(auction));

        Treasury(payable(TREASURY)).authorizeContract(address(auction));
        console2.log("Authorized new auction in Treasury");

        vm.stopBroadcast();

        console2.log("\n=== Update NEXT_PUBLIC_AUCTION_ADDRESS to ===");
        console2.log(address(auction));
    }
}
