// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64, ebool, eaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IConfidentialUSDC {
    function transferFromAllowance(address from, address to) external returns (euint64);
    function transferEncrypted(address to, euint64 amount) external returns (euint64);
    function allowance(address owner, address spender) external view returns (euint64);
}

interface ITreasury {
    function feeBasisPoints() external view returns (uint16);
}

/// @title SilentBidAuction (Zama FHEVM)
/// @notice Sealed-bid auction supporting two modes:
///         - ITEM: single-winner. Highest bidder pays own bid in cUSDC.
///         - TOKEN: multi-winner uniform-clearing-price. Winners pay clearing
///           price * allocated quantity in cUSDC.
///         Settlement is two-step on Zama v0.11.1:
///           1. `endAuction` marks all relevant ciphertexts publicly decryptable.
///           2. Off-chain relayer fetches plaintext + KMS proof from the gateway.
///           3. `finalizeAuction*` calls verify the proof via FHE.checkSignatures,
///              then settle bids atomically.
contract SilentBidAuction is ZamaEthereumConfig, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Types ---

    enum Mode {
        ITEM,
        TOKEN
    }

    struct Auction {
        Mode mode;
        address seller;
        string itemName;
        string itemDescription;
        address tokenX;            // address(0) for ITEM
        uint256 totalSupply;       // 1 for ITEM (informational), units for TOKEN
        uint64 minBidPlain;
        euint64 minBidEnc;
        uint64 endTime;
        bool ended;
        bool finalized;
        // ITEM-only running winner state.
        euint64 runningHighestBid;
        eaddress runningHighestBidder;
        // Settlement results (plaintext, post-finalize).
        address winnerPlain;
        uint64 winningAmountPlain;
        uint64 clearingPricePlain;
        uint256 unsoldReturned;
        uint256 gasDeposit;
    }

    struct Bid {
        address bidder;
        euint64 encPrice;
        euint64 encQty;            // for ITEM mode this is the constant 1
        euint64 encEscrow;         // amount escrowed via cUSDC (for refunds)
        bool settled;
        uint256 allocatedTokenX;   // set on finalize for TOKEN mode
        uint64 refundedCUSDC;      // plaintext refund amount, if any
    }

    // --- Storage ---

    IConfidentialUSDC public immutable cUSDC;
    ITreasury public immutable treasury;

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) private _auctions;
    mapping(uint256 => Bid[]) private _bids;
    mapping(uint256 => mapping(address => bool)) public hasBid;

    // --- Events ---

    event AuctionCreatedItem(
        uint256 indexed auctionId,
        address indexed seller,
        string itemName,
        uint64 minBidPlain,
        uint64 endTime,
        uint256 gasDeposit
    );
    event AuctionCreatedToken(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed tokenX,
        uint256 supply,
        uint64 minBidPlain,
        uint64 endTime,
        uint256 gasDeposit
    );
    event BidPlaced(
        uint256 indexed auctionId,
        uint256 indexed bidIndex,
        address indexed bidder,
        bytes32 encPriceHandle,
        bytes32 encQtyHandle
    );
    event AuctionEnded(uint256 indexed auctionId);
    event AuctionFinalizedItem(uint256 indexed auctionId, address indexed winner, uint64 amount, uint64 fee);
    event AuctionFinalizedToken(
        uint256 indexed auctionId,
        uint64 clearingPrice,
        uint256 totalAllocated,
        uint256 unsoldReturned,
        uint64 fee
    );
    event BidSettled(
        uint256 indexed auctionId,
        uint256 indexed bidIndex,
        address indexed bidder,
        bool isWinner,
        uint256 allocatedTokenX,
        uint64 refundedCUSDC
    );

    // --- Errors ---

    error ZeroAddress();
    error ZeroAmount();
    error DurationTooShort();
    error AuctionNotFound();
    error AuctionAlreadyEnded();
    error AuctionNotEnded();
    error AuctionAlreadyFinalized();
    error AuctionNotFinalizedYet();
    error WrongMode();
    error SellerCannotBid();
    error AlreadyBid();
    error LengthMismatch();
    error TooEarly();

    constructor(address cusdc, address treasury_) {
        if (cusdc == address(0) || treasury_ == address(0)) revert ZeroAddress();
        cUSDC = IConfidentialUSDC(cusdc);
        treasury = ITreasury(treasury_);
    }

    // --- View getters ---

    function auctionCount() external view returns (uint256) {
        return nextAuctionId;
    }

    function bidCount(uint256 auctionId) external view returns (uint256) {
        return _bids[auctionId].length;
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    function getBid(uint256 auctionId, uint256 idx)
        external
        view
        returns (
            address bidder,
            bytes32 encPriceHandle,
            bytes32 encQtyHandle,
            bytes32 encEscrowHandle,
            bool settled,
            uint256 allocatedTokenX,
            uint64 refundedCUSDC
        )
    {
        Bid storage b = _bids[auctionId][idx];
        return (
            b.bidder,
            FHE.toBytes32(b.encPrice),
            FHE.toBytes32(b.encQty),
            FHE.toBytes32(b.encEscrow),
            b.settled,
            b.allocatedTokenX,
            b.refundedCUSDC
        );
    }

    // --- Creation ---

    function createAuctionItem(
        string calldata itemName,
        string calldata itemDescription,
        uint64 minBidPlain,
        uint64 durationSeconds
    ) external payable returns (uint256 auctionId) {
        if (durationSeconds < 60) revert DurationTooShort();

        auctionId = nextAuctionId++;
        Auction storage a = _auctions[auctionId];
        a.mode = Mode.ITEM;
        a.seller = msg.sender;
        a.itemName = itemName;
        a.itemDescription = itemDescription;
        a.tokenX = address(0);
        a.totalSupply = 1;
        a.minBidPlain = minBidPlain;
        a.endTime = uint64(block.timestamp) + durationSeconds;
        a.gasDeposit = msg.value;

        a.runningHighestBid = FHE.asEuint64(0);
        a.runningHighestBidder = FHE.asEaddress(address(0));
        FHE.allowThis(a.runningHighestBid);
        FHE.allowThis(a.runningHighestBidder);

        a.minBidEnc = FHE.asEuint64(minBidPlain);
        FHE.allowThis(a.minBidEnc);

        emit AuctionCreatedItem(auctionId, msg.sender, itemName, minBidPlain, a.endTime, msg.value);
    }

    function createAuctionToken(
        string calldata itemName,
        string calldata itemDescription,
        address tokenX,
        uint256 supply,
        uint64 minBidPlain,
        uint64 durationSeconds
    ) external payable returns (uint256 auctionId) {
        if (durationSeconds < 60) revert DurationTooShort();
        if (tokenX == address(0)) revert ZeroAddress();
        if (supply == 0) revert ZeroAmount();

        // Pull the auctionable supply from the seller into escrow.
        IERC20(tokenX).safeTransferFrom(msg.sender, address(this), supply);

        auctionId = nextAuctionId++;
        Auction storage a = _auctions[auctionId];
        a.mode = Mode.TOKEN;
        a.seller = msg.sender;
        a.itemName = itemName;
        a.itemDescription = itemDescription;
        a.tokenX = tokenX;
        a.totalSupply = supply;
        a.minBidPlain = minBidPlain;
        a.endTime = uint64(block.timestamp) + durationSeconds;
        a.gasDeposit = msg.value;

        a.minBidEnc = FHE.asEuint64(minBidPlain);
        FHE.allowThis(a.minBidEnc);

        emit AuctionCreatedToken(
            auctionId, msg.sender, tokenX, supply, minBidPlain, a.endTime, msg.value
        );
    }

    // --- Bid placement ---

    /// @param priceProof Proof binding `encExtPrice` to the bidder + this contract.
    /// @param qtyProof   Proof binding `encExtQty` to the bidder + this contract.
    ///                   Ignored for ITEM mode (qty is constant 1 internally).
    function placeBid(
        uint256 auctionId,
        externalEuint64 encExtPrice,
        externalEuint64 encExtQty,
        bytes calldata priceProof,
        bytes calldata qtyProof
    ) external returns (uint256 bidIndex) {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound();
        if (block.timestamp >= a.endTime) revert AuctionAlreadyEnded();
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (hasBid[auctionId][msg.sender]) revert AlreadyBid();

        euint64 encPrice = FHE.fromExternal(encExtPrice, priceProof);
        euint64 encQty;
        if (a.mode == Mode.ITEM) {
            encQty = FHE.asEuint64(1);
        } else {
            encQty = FHE.fromExternal(encExtQty, qtyProof);
        }

        // Pull cUSDC escrow from the bidder's allowance to the auction.
        euint64 encEscrow = cUSDC.transferFromAllowance(msg.sender, address(this));

        // ACL grants so we can later refund / pay the seller.
        FHE.allowThis(encPrice);
        FHE.allowThis(encQty);
        FHE.allowThis(encEscrow);
        FHE.allow(encEscrow, address(cUSDC));
        FHE.allow(encEscrow, msg.sender);
        FHE.allow(encPrice, msg.sender);
        FHE.allow(encQty, msg.sender);

        // Running-max for ITEM mode.
        if (a.mode == Mode.ITEM) {
            ebool isHigher = FHE.gt(encPrice, a.runningHighestBid);
            a.runningHighestBid = FHE.max(encPrice, a.runningHighestBid);
            a.runningHighestBidder = FHE.select(
                isHigher, FHE.asEaddress(msg.sender), a.runningHighestBidder
            );
            FHE.allowThis(a.runningHighestBid);
            FHE.allowThis(a.runningHighestBidder);
        }

        bidIndex = _bids[auctionId].length;
        _bids[auctionId].push(Bid({
            bidder: msg.sender,
            encPrice: encPrice,
            encQty: encQty,
            encEscrow: encEscrow,
            settled: false,
            allocatedTokenX: 0,
            refundedCUSDC: 0
        }));
        hasBid[auctionId][msg.sender] = true;

        emit BidPlaced(
            auctionId, bidIndex, msg.sender, FHE.toBytes32(encPrice), FHE.toBytes32(encQty)
        );
    }

    // --- End: mark handles publicly decryptable ---

    function endAuction(uint256 auctionId) external {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound();
        if (block.timestamp < a.endTime) revert TooEarly();
        if (a.ended) revert AuctionAlreadyEnded();
        a.ended = true;

        if (a.mode == Mode.ITEM) {
            FHE.makePubliclyDecryptable(a.runningHighestBid);
            FHE.makePubliclyDecryptable(a.runningHighestBidder);
        } else {
            uint256 n = _bids[auctionId].length;
            for (uint256 i = 0; i < n; i++) {
                Bid storage b = _bids[auctionId][i];
                FHE.makePubliclyDecryptable(b.encPrice);
                FHE.makePubliclyDecryptable(b.encQty);
            }
        }

        emit AuctionEnded(auctionId);
    }

    // --- Finalize: ITEM ---

    /// @notice ITEM-mode finalize. Verifies KMS signatures over the running
    ///         highest bidder + amount, then settles every bid: winner pays
    ///         seller (minus fee) from their own escrow, losers refunded fully.
    /// @dev    Caller supplies plaintexts fetched off-chain; checkSignatures
    ///         enforces correctness against the FHE handles.
    function finalizeAuctionItem(
        uint256 auctionId,
        address winner,
        uint64 winningAmount,
        bytes calldata decryptionProof
    ) external nonReentrant {
        Auction storage a = _auctions[auctionId];
        if (a.mode != Mode.ITEM) revert WrongMode();
        if (!a.ended) revert AuctionNotEnded();
        if (a.finalized) revert AuctionAlreadyFinalized();

        // Verify decryption proof against the two ITEM handles.
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(a.runningHighestBidder);
        handles[1] = FHE.toBytes32(a.runningHighestBid);
        // checkSignatures expects abi.encode of cleartexts in handle order.
        bytes memory cleartexts = abi.encode(uint256(uint160(winner)), uint256(winningAmount));
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        a.winnerPlain = winner;
        a.winningAmountPlain = winningAmount;
        a.clearingPricePlain = winningAmount;

        // Fee math: multiply-before-divide.
        uint16 feeBps = treasury.feeBasisPoints();
        uint64 feeAmount = uint64((uint256(winningAmount) * uint256(feeBps)) / 10_000);

        uint256 n = _bids[auctionId].length;
        for (uint256 i = 0; i < n; i++) {
            Bid storage b = _bids[auctionId][i];
            if (b.settled) continue;
            b.settled = true;

            if (b.bidder == winner) {
                // Winner: split escrow into (net to seller) + (fee to treasury).
                if (feeAmount > 0) {
                    euint64 feeEnc = FHE.asEuint64(feeAmount);
                    euint64 netEnc = FHE.sub(b.encEscrow, feeEnc);
                    FHE.allowThis(feeEnc);
                    FHE.allowThis(netEnc);
                    FHE.allow(feeEnc, address(cUSDC));
                    FHE.allow(netEnc, address(cUSDC));
                    cUSDC.transferEncrypted(a.seller, netEnc);
                    cUSDC.transferEncrypted(address(treasury), feeEnc);
                } else {
                    cUSDC.transferEncrypted(a.seller, b.encEscrow);
                }
                emit BidSettled(auctionId, i, b.bidder, true, 0, 0);
            } else {
                // Loser: full refund.
                cUSDC.transferEncrypted(b.bidder, b.encEscrow);
                emit BidSettled(auctionId, i, b.bidder, false, 0, 0);
            }
        }

        a.finalized = true;
        emit AuctionFinalizedItem(auctionId, winner, winningAmount, feeAmount);
    }

    // --- Finalize: TOKEN (uniform-clearing-price) ---

    /// @notice TOKEN-mode finalize. Caller supplies plaintext (price, qty) pairs
    ///         in bid-index order. Sigs are verified over all 2*N bid handles,
    ///         then the contract sorts bids descending by price and walks down
    ///         until supply is consumed; clearing price = last winning bid's
    ///         price; winners pay clearing*allocatedQty in cUSDC, losers refunded.
    function finalizeAuctionToken(
        uint256 auctionId,
        uint64[] calldata prices,
        uint64[] calldata qtys,
        bytes calldata decryptionProof
    ) external nonReentrant {
        Auction storage a = _auctions[auctionId];
        if (a.mode != Mode.TOKEN) revert WrongMode();
        if (!a.ended) revert AuctionNotEnded();
        if (a.finalized) revert AuctionAlreadyFinalized();

        Bid[] storage bidArr = _bids[auctionId];
        uint256 n = bidArr.length;
        if (prices.length != n || qtys.length != n) revert LengthMismatch();

        _verifyTokenDecryption(bidArr, prices, qtys, decryptionProof);

        // Determine winners + clearing price + per-winner allocation.
        (uint64 clearingPrice, uint256[] memory allocations, uint256 totalAllocated) =
            _computeClearing(prices, qtys, a.totalSupply, a.minBidPlain);

        a.clearingPricePlain = clearingPrice;
        uint64 totalFee = _settleAllTokenBids(auctionId, clearingPrice, prices, qtys, allocations);

        // Return unsold supply to the seller.
        uint256 unsold = a.totalSupply - totalAllocated;
        if (unsold > 0) {
            IERC20(a.tokenX).safeTransfer(a.seller, unsold);
        }
        a.unsoldReturned = unsold;

        a.finalized = true;
        emit AuctionFinalizedToken(auctionId, clearingPrice, totalAllocated, unsold, totalFee);
    }

    function _settleAllTokenBids(
        uint256 auctionId,
        uint64 clearingPrice,
        uint64[] calldata prices,
        uint64[] calldata qtys,
        uint256[] memory allocations
    ) internal returns (uint64 totalFee) {
        Auction storage a = _auctions[auctionId];
        Bid[] storage bidArr = _bids[auctionId];
        uint16 feeBps = treasury.feeBasisPoints();
        uint256 n = bidArr.length;
        for (uint256 i = 0; i < n; i++) {
            Bid storage b = bidArr[i];
            if (b.settled) continue;
            b.settled = true;
            uint256 alloc = allocations[i];
            if (alloc > 0) {
                uint64 fee = _settleWinner(
                    a.seller, b, clearingPrice, prices[i], qtys[i], alloc, feeBps
                );
                totalFee += fee;
                IERC20(a.tokenX).safeTransfer(b.bidder, alloc);
                emit BidSettled(auctionId, i, b.bidder, true, alloc, b.refundedCUSDC);
            } else {
                cUSDC.transferEncrypted(b.bidder, b.encEscrow);
                b.refundedCUSDC = uint64(uint256(prices[i]) * uint256(qtys[i]));
                emit BidSettled(auctionId, i, b.bidder, false, 0, b.refundedCUSDC);
            }
        }
    }

    function _settleWinner(
        address seller,
        Bid storage b,
        uint64 clearingPrice,
        uint64 price,
        uint64 qty,
        uint256 alloc,
        uint16 feeBps
    ) internal returns (uint64 fee) {
        uint256 chargeRaw = uint256(clearingPrice) * alloc;
        uint256 escrowExpected = uint256(price) * uint256(qty);
        uint64 charge = chargeRaw > escrowExpected ? uint64(escrowExpected) : uint64(chargeRaw);
        uint64 refund = uint64(escrowExpected - charge);

        // Multiply-before-divide on fee.
        fee = uint64((uint256(charge) * uint256(feeBps)) / 10_000);
        uint64 net = charge - fee;

        if (charge > 0) {
            if (fee > 0) {
                euint64 feeEnc = FHE.asEuint64(fee);
                FHE.allowThis(feeEnc);
                FHE.allow(feeEnc, address(cUSDC));
                cUSDC.transferEncrypted(address(treasury), feeEnc);
            }
            if (net > 0) {
                euint64 netEnc = FHE.asEuint64(net);
                FHE.allowThis(netEnc);
                FHE.allow(netEnc, address(cUSDC));
                cUSDC.transferEncrypted(seller, netEnc);
            }
        }
        if (refund > 0) {
            euint64 refEnc = FHE.asEuint64(refund);
            FHE.allowThis(refEnc);
            FHE.allow(refEnc, address(cUSDC));
            cUSDC.transferEncrypted(b.bidder, refEnc);
        }

        b.allocatedTokenX = alloc;
        b.refundedCUSDC = refund;
    }

    // --- Internals ---

    function _verifyTokenDecryption(
        Bid[] storage bidArr,
        uint64[] calldata prices,
        uint64[] calldata qtys,
        bytes calldata decryptionProof
    ) internal {
        uint256 n = bidArr.length;
        bytes32[] memory handles = new bytes32[](n * 2);
        // The KMS signs the cleartexts as a POSITIONAL abi.encode — each value a
        // fixed 32-byte word in handle order — exactly like finalizeAuctionItem's
        // `abi.encode(uint256(winner), uint256(amount))`. Using abi.encode(uint256[])
        // instead prepends a dynamic-array offset+length header the KMS never signed,
        // so checkSignatures always reverts. Concatenate each word to match.
        bytes memory cleartexts;
        for (uint256 i = 0; i < n; i++) {
            handles[i * 2] = FHE.toBytes32(bidArr[i].encPrice);
            handles[i * 2 + 1] = FHE.toBytes32(bidArr[i].encQty);
            cleartexts = bytes.concat(
                cleartexts,
                abi.encode(uint256(prices[i])),
                abi.encode(uint256(qtys[i]))
            );
        }
        FHE.checkSignatures(handles, cleartexts, decryptionProof);
    }

    /// @dev Sorts bids by price desc, walks down until supply is exhausted.
    ///      Bids with price < minBidPlain are excluded.
    ///      Returns (clearingPrice, allocations[i], totalAllocated).
    function _computeClearing(
        uint64[] calldata prices,
        uint64[] calldata qtys,
        uint256 supply,
        uint64 minBidPlain
    ) internal pure returns (uint64 clearingPrice, uint256[] memory allocations, uint256 totalAllocated) {
        uint256 n = prices.length;
        allocations = new uint256[](n);

        // Build an index array, then selection-sort by price desc (n is small in
        // practice for this auction style; keeps gas predictable without
        // recursive quicksort overhead).
        uint256[] memory idx = new uint256[](n);
        uint256 m = 0;
        for (uint256 i = 0; i < n; i++) {
            if (prices[i] >= minBidPlain && qtys[i] > 0) {
                idx[m++] = i;
            }
        }
        // Resize implicit: only iterate over [0, m).
        for (uint256 i = 0; i < m; i++) {
            uint256 best = i;
            for (uint256 j = i + 1; j < m; j++) {
                if (prices[idx[j]] > prices[idx[best]]) best = j;
            }
            if (best != i) {
                (idx[i], idx[best]) = (idx[best], idx[i]);
            }
        }

        // Walk down filling supply.
        uint256 remaining = supply;
        clearingPrice = 0;
        totalAllocated = 0;
        for (uint256 k = 0; k < m; k++) {
            if (remaining == 0) break;
            uint256 i = idx[k];
            uint256 want = uint256(qtys[i]);
            uint256 give = want <= remaining ? want : remaining;
            allocations[i] = give;
            remaining -= give;
            totalAllocated += give;
            clearingPrice = prices[i]; // last winning price
        }
    }
}
