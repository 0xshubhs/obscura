// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, euint32, externalEuint64, ebool, eaddress} from "@fhevm/solidity/lib/FHE.sol";
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

/// @title Obscura (Zama FHEVM)
/// @notice Sealed-bid auction supporting two modes:
///         - ITEM: single-winner. Highest bidder pays own bid in cUSDC.
///         - TOKEN: multi-winner uniform-clearing-price. Winners pay clearing
///           price * allocated quantity in cUSDC.
///         Settlement is two-step on Zama v0.11.1:
///           1. `endAuction` marks all relevant ciphertexts publicly decryptable.
///           2. Off-chain relayer fetches plaintext + KMS proof from the gateway.
///           3. `finalizeAuction*` calls verify the proof via FHE.checkSignatures,
///              then settle bids atomically.
///
/// @dev Sealed-auction extensions (opt-in per auction via `createSealedAuctionItem`,
///      so the plain ITEM/TOKEN flows above are byte-for-byte unchanged):
///        - Sealed reserve: the floor is supplied as an encrypted input and
///          enforced on-chain via FHE.gt/FHE.select — bids at/below it are zeroed
///          inside FHE and can never win (they get a full refund at settlement).
///          The reserve value is never revealed.
///        - Vickrey (sealed second-price): the winner pays the runner-up's bid
///          (`secondHighestBid`, seeded at the reserve so a single bidder pays the
///          reserve). Only the second price is decrypted; the winner's real bid
///          stays sealed and the overbid is refunded in encrypted cUSDC.
///        - FHE-random tie-break: equal top bids are broken by an on-chain
///          FHE.randEuint32 score instead of first-come-wins (anti-MEV).
///        - Gas pool: the ETH a creator escrows at create time (and any ETH a
///          bidder attaches) reimburses whoever pays to finalize; the remainder
///          returns to the seller.
contract Obscura is ZamaEthereumConfig, ReentrancyGuard {
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
        // --- Sealed / Vickrey / tie-break (opt-in via createSealedAuctionItem) ---
        uint256 bidGasPool;        // ETH attached by bidders, added to the finalize reimbursement
        bool reserveHidden;        // true => minBidEnc is a secret reserve, enforced on-chain
        bool useVickrey;           // true => winner pays the runner-up's price (second-price)
        bool useTieBreak;          // true => equal top bids broken by an FHE random score
        euint64 secondHighestBid;  // Vickrey runner-up; seeded at the reserve
        euint32 tieBreakScore;     // FHE-random score of the current top bid; higher wins ties
    }

    struct Bid {
        address bidder;
        euint64 encPrice;
        euint64 encQty;            // for ITEM mode this is the constant 1
        euint64 encEscrow;         // amount escrowed via cUSDC (for refunds)
        bool settled;
        uint256 allocatedTokenX;   // set on finalize for TOKEN mode
        uint64 refundedCUSDC;      // plaintext refund amount, if any
        bool revealed;             // bidder opt-in reveal marker (see revealMyBid)
    }

    // --- Storage ---

    IConfidentialUSDC public immutable cUSDC;
    ITreasury public immutable treasury;

    // Transient (EIP-1153) slot holding gasleft() at finalize start. Kept off the
    // stack so the gas metering adds no stack-resident local to the (deliberately
    // stack-heavy) finalize functions — a plain `startGas` local overflowed via-IR.
    // Value = keccak256("silentbid.auction.gasStart") (inline asm needs a literal).
    uint256 private constant _GAS_START_SLOT =
        0x01cda4bee0f68c8e3097058a78382fba2e374c53eb477464bca65fd2eef7339b;

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
    event SealedAuctionCreated(
        uint256 indexed auctionId,
        bool useVickrey,
        bool useTieBreak,
        uint64 displayHint
    );
    event AuctionEnded(uint256 indexed auctionId);
    event AuctionFinalizedItem(uint256 indexed auctionId, address indexed winner, uint64 amount, uint64 fee);
    event AuctionFinalizedVickrey(uint256 indexed auctionId, address indexed winner, uint64 paidAmount, uint64 fee);
    event BidRevealed(uint256 indexed auctionId, uint256 indexed bidIndex, address indexed bidder, bytes32 encPriceHandle);
    event GasCompensated(uint256 indexed auctionId, address indexed caller, uint256 payout);
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
    error NotYourBid();

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

    /// @notice Single-winner ITEM auction with a SEALED reserve. The floor is
    ///         supplied as an encrypted input (`encReserve` + `reserveProof`) so
    ///         bidders never learn it; the contract enforces it inside FHE.
    /// @param  displayHint   Cosmetic floor shown in the UI only (0 => "—"). NOT
    ///                        the enforced reserve.
    /// @param  useVickrey    true => winner pays the runner-up's bid (second-price).
    /// @param  useTieBreak   true => equal top bids broken by an FHE random score.
    ///                        Live-network only (the mock task manager does not tag
    ///                        random outputs with type metadata).
    function createSealedAuctionItem(
        string calldata itemName,
        string calldata itemDescription,
        uint64 displayHint,
        externalEuint64 encReserve,
        bytes calldata reserveProof,
        uint64 durationSeconds,
        bool useVickrey,
        bool useTieBreak
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
        a.minBidPlain = displayHint; // cosmetic; the real floor is minBidEnc
        a.endTime = uint64(block.timestamp) + durationSeconds;
        a.gasDeposit = msg.value;
        a.reserveHidden = true;
        a.useVickrey = useVickrey;
        a.useTieBreak = useTieBreak;

        a.runningHighestBid = FHE.asEuint64(0);
        a.runningHighestBidder = FHE.asEaddress(address(0));
        FHE.allowThis(a.runningHighestBid);
        FHE.allowThis(a.runningHighestBidder);

        // Secret reserve, enforced on-chain in _updateRunning, never revealed.
        a.minBidEnc = FHE.fromExternal(encReserve, reserveProof);
        FHE.allowThis(a.minBidEnc);

        // Runner-up seeds at the reserve so a lone Vickrey bidder pays the reserve.
        a.secondHighestBid = a.minBidEnc;
        FHE.allowThis(a.secondHighestBid);

        if (useTieBreak) {
            a.tieBreakScore = FHE.asEuint32(0);
            FHE.allowThis(a.tieBreakScore);
        }

        emit AuctionCreatedItem(auctionId, msg.sender, itemName, displayHint, a.endTime, msg.value);
        emit SealedAuctionCreated(auctionId, useVickrey, useTieBreak, displayHint);
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
    ) external payable returns (uint256 bidIndex) {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound();
        if (block.timestamp >= a.endTime) revert AuctionAlreadyEnded();
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (hasBid[auctionId][msg.sender]) revert AlreadyBid();

        // Optional ETH toward the finalize-reimbursement pool. Never required, so
        // existing zero-value bid flows keep working unchanged.
        if (msg.value > 0) a.bidGasPool += msg.value;

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

        // Running-winner update for ITEM mode (plain, sealed, Vickrey, tie-break).
        if (a.mode == Mode.ITEM) {
            _updateRunning(auctionId, encPrice, msg.sender);
        }

        bidIndex = _bids[auctionId].length;
        _bids[auctionId].push(Bid({
            bidder: msg.sender,
            encPrice: encPrice,
            encQty: encQty,
            encEscrow: encEscrow,
            settled: false,
            allocatedTokenX: 0,
            refundedCUSDC: 0,
            revealed: false
        }));
        hasBid[auctionId][msg.sender] = true;

        emit BidPlaced(
            auctionId, bidIndex, msg.sender, FHE.toBytes32(encPrice), FHE.toBytes32(encQty)
        );
    }

    /// @dev Single-winner running-winner update. `encPrice` is passed by value,
    ///      so the reserve-zeroing here does NOT alter the original bid handle the
    ///      caller stores in the Bid (revealMyBid still shows the true bid).
    ///
    ///      Plain auctions (reserveHidden=false) reduce to the original
    ///      "strictly higher wins, first-come ties" — select(isHigher, new, old)
    ///      is identical to max(new, old) for the amount and keeps the prior
    ///      bidder on a tie. Sealed auctions additionally: enforce the encrypted
    ///      reserve, (opt-in) break ties with an FHE random score, and (opt-in)
    ///      maintain the runner-up for Vickrey settlement.
    function _updateRunning(uint256 auctionId, euint64 encPrice, address bidder) internal {
        Auction storage a = _auctions[auctionId];

        // Enforce the hidden reserve: a bid at/below it is zeroed so it can never
        // become the running max. The bidder is refunded in full at settlement.
        ebool meetsMin;
        if (a.reserveHidden) {
            meetsMin = FHE.gt(encPrice, a.minBidEnc);
            encPrice = FHE.select(meetsMin, encPrice, FHE.asEuint64(0));
        }

        euint64 oldHighest = a.runningHighestBid;
        ebool isHigher = FHE.gt(encPrice, oldHighest);

        ebool shouldReplace;
        if (a.useTieBreak) {
            // A tie only counts if the bid also cleared the reserve, otherwise a
            // zeroed sub-reserve bid could "tie" an empty highestBid==0 and win.
            ebool isTied = FHE.and(meetsMin, FHE.eq(encPrice, oldHighest));
            euint32 r = FHE.randEuint32();
            ebool randWins = FHE.gt(r, a.tieBreakScore);
            shouldReplace = FHE.or(isHigher, FHE.and(isTied, randWins));
            a.tieBreakScore = FHE.select(shouldReplace, r, a.tieBreakScore);
            FHE.allowThis(a.tieBreakScore);
        } else {
            shouldReplace = isHigher;
        }

        a.runningHighestBid = FHE.select(shouldReplace, encPrice, oldHighest);
        a.runningHighestBidder = FHE.select(shouldReplace, FHE.asEaddress(bidder), a.runningHighestBidder);
        FHE.allowThis(a.runningHighestBid);
        FHE.allowThis(a.runningHighestBidder);

        // Runner-up tracking (Vickrey only, to avoid burning FHE gas otherwise).
        // On replace, the prior max becomes the runner-up (clamped to the reserve
        // so an empty pre-state floors correctly). On no-replace, the runner-up is
        // max(thisBid, oldSecond).
        if (a.useVickrey) {
            euint64 clampedOldHighest = FHE.max(oldHighest, a.minBidEnc);
            euint64 maxAmountOldSecond = FHE.max(encPrice, a.secondHighestBid);
            a.secondHighestBid = FHE.select(shouldReplace, clampedOldHighest, maxAmountOldSecond);
            FHE.allowThis(a.secondHighestBid);
        }
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
            // Vickrey settles on the runner-up price, so expose it too.
            if (a.useVickrey) {
                FHE.makePubliclyDecryptable(a.secondHighestBid);
            }
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
        _markGasStart();
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
        _payGasCompensation(auctionId);
    }

    // --- Finalize: ITEM Vickrey (sealed second-price) ---

    /// @notice Vickrey finalize. The winner is the top bidder, but the price they
    ///         pay is the runner-up's bid (`secondHighestBid`, clamped to the
    ///         reserve). The winner's true bid is never revealed; the overbid
    ///         (escrow − second price) is refunded to them in encrypted cUSDC.
    /// @param  paidAmount  decrypted plaintext of `secondHighestBid` — what the
    ///                     winner actually pays.
    function finalizeSealedAuctionItem(
        uint256 auctionId,
        address winner,
        uint64 paidAmount,
        bytes calldata decryptionProof
    ) external nonReentrant {
        _markGasStart();
        Auction storage a = _auctions[auctionId];
        if (a.mode != Mode.ITEM) revert WrongMode();
        if (!a.useVickrey) revert WrongMode();
        if (!a.ended) revert AuctionNotEnded();
        if (a.finalized) revert AuctionAlreadyFinalized();

        // Verify the winner identity + the second price against their handles.
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(a.runningHighestBidder);
        handles[1] = FHE.toBytes32(a.secondHighestBid);
        bytes memory cleartexts = abi.encode(uint256(uint160(winner)), uint256(paidAmount));
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        a.winnerPlain = winner;
        a.winningAmountPlain = paidAmount;
        a.clearingPricePlain = paidAmount;

        uint16 feeBps = treasury.feeBasisPoints();
        uint64 feeAmount = uint64((uint256(paidAmount) * uint256(feeBps)) / 10_000);

        uint256 n = _bids[auctionId].length;
        for (uint256 i = 0; i < n; i++) {
            Bid storage b = _bids[auctionId][i];
            if (b.settled) continue;
            b.settled = true;

            if (b.bidder == winner) {
                // Winner pays the second price; overbid (escrow − paid) refunded.
                euint64 paidEnc = FHE.asEuint64(paidAmount);
                FHE.allowThis(paidEnc);
                FHE.allow(paidEnc, address(cUSDC));
                euint64 refundEnc = FHE.sub(b.encEscrow, paidEnc);
                FHE.allowThis(refundEnc);
                FHE.allow(refundEnc, address(cUSDC));

                if (feeAmount > 0) {
                    euint64 feeEnc = FHE.asEuint64(feeAmount);
                    euint64 netEnc = FHE.sub(paidEnc, feeEnc);
                    FHE.allowThis(feeEnc);
                    FHE.allowThis(netEnc);
                    FHE.allow(feeEnc, address(cUSDC));
                    FHE.allow(netEnc, address(cUSDC));
                    cUSDC.transferEncrypted(a.seller, netEnc);
                    cUSDC.transferEncrypted(address(treasury), feeEnc);
                } else {
                    cUSDC.transferEncrypted(a.seller, paidEnc);
                }
                // Refund the overbid. transferEncrypted clamps to balance, so a
                // no-overbid case (paid == bid) is effectively a no-op.
                cUSDC.transferEncrypted(b.bidder, refundEnc);
                emit BidSettled(auctionId, i, b.bidder, true, 0, 0);
            } else {
                // Loser: full refund.
                cUSDC.transferEncrypted(b.bidder, b.encEscrow);
                emit BidSettled(auctionId, i, b.bidder, false, 0, 0);
            }
        }

        a.finalized = true;
        emit AuctionFinalizedVickrey(auctionId, winner, paidAmount, feeAmount);
        _payGasCompensation(auctionId);
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
        _markGasStart();
        Auction storage a = _auctions[auctionId];
        if (a.mode != Mode.TOKEN) revert WrongMode();
        if (!a.ended) revert AuctionNotEnded();
        if (a.finalized) revert AuctionAlreadyFinalized();

        // Note: `_bids[auctionId]` is referenced inline rather than via a local
        // `bidArr` so that the extra `startGas` local stays within via-IR's stack
        // headroom for this (deliberately stack-heavy) settlement function.
        uint256 n = _bids[auctionId].length;
        if (prices.length != n || qtys.length != n) revert LengthMismatch();

        _verifyTokenDecryption(_bids[auctionId], prices, qtys, decryptionProof);

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
        _payGasCompensation(auctionId);
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

    /// @dev Snapshot gasleft() into transient storage at the start of a finalize.
    function _markGasStart() internal {
        assembly {
            tstore(_GAS_START_SLOT, gas())
        }
    }

    /// @dev Reimburse the finalizer from the auction's ETH pool (creator deposit
    ///      + any bidder contributions), refunding the remainder to the seller.
    ///      Effects (zeroing the pool) happen before the external calls, and every
    ///      finalize path is nonReentrant, so this is reentrancy-safe.
    function _payGasCompensation(uint256 auctionId) internal {
        Auction storage a = _auctions[auctionId];
        uint256 pool = a.gasDeposit + a.bidGasPool;
        if (pool == 0) return;
        a.gasDeposit = 0;
        a.bidGasPool = 0;

        uint256 startGas;
        assembly {
            startGas := tload(_GAS_START_SLOT)
        }
        uint256 gasUsed = startGas - gasleft() + 40_000; // +40k for the transfer itself
        uint256 comp = gasUsed * tx.gasprice;
        uint256 payout = comp > pool ? pool : comp;

        if (payout > 0) {
            (bool ok, ) = payable(msg.sender).call{value: payout}("");
            if (!ok) payout = 0; // don't revert settlement on a refund failure
        }
        uint256 remaining = pool - payout;
        if (remaining > 0) {
            (bool ok2, ) = payable(a.seller).call{value: remaining}("");
            ok2; // if the seller can't receive, the ETH stays in the contract
        }
        emit GasCompensated(auctionId, msg.sender, payout);
    }

    // --- Post-auction: bidder opt-in reveal ---

    /// @notice Bidder opts in to marking their own bid as revealed (UX/audit).
    /// @dev    Does NOT change any ACL — only the bidder can decrypt their bid,
    ///         because access was granted at bid time. This is a marker only.
    function revealMyBid(uint256 auctionId, uint256 bidIndex) external {
        Bid storage b = _bids[auctionId][bidIndex];
        if (b.bidder != msg.sender) revert NotYourBid();
        if (!_auctions[auctionId].ended) revert AuctionNotEnded();
        b.revealed = true;
        emit BidRevealed(auctionId, bidIndex, msg.sender, FHE.toBytes32(b.encPrice));
    }

    /// @notice Whether a bid has been marked revealed by its owner.
    function bidRevealed(uint256 auctionId, uint256 bidIndex) external view returns (bool) {
        return _bids[auctionId][bidIndex].revealed;
    }
}
