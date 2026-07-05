/**
 * Contract address registry + ABIs for Obscura (Zama sealed-bid auction).
 * Mirrors the FHENIX `lib/fhenix-contracts.ts` export shape, adapted for the
 * relayer-sdk calling convention (bytes32 handle + bytes inputProof) and the
 * dual ITEM/TOKEN auction modes.
 */
import { type Abi, type Address } from "viem"

// Next.js webpack only replaces *literal* property access on process.env at
// compile time. Dynamic keys like process.env[k] do NOT get replaced and return
// undefined in the browser bundle. Always reference each var by literal name.
// The hardcoded fallback is the live Ethereum Sepolia deployment (2026-07-05,
// with the TOKEN-mode fix) so the app works without a .env.local; env still
// overrides when present.
export const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x284f2a7c89FE5Ac3245108091d86A05e36c4a111") as Address
export const CUSDC_ADDRESS = (process.env.NEXT_PUBLIC_CUSDC_ADDRESS || "0x7DDB59ad465Fc824BA6cAaD1848E8a34cDE63063") as Address
export const AUCTION_ADDRESS = (process.env.NEXT_PUBLIC_AUCTION_ADDRESS || "0x5e053a9952c7bBc56332692e8848871a96584933") as Address
export const TREASURY_ADDRESS = (process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "0x5b6fCb37Bc3106c76DD6C921cb049c84691b345A") as Address
export const TOKENX_ADDRESS = (process.env.NEXT_PUBLIC_TOKENX_ADDRESS || "0xc96A124100AA66159892047039aD1b60fB3558Cc") as Address

export const USDC_DECIMALS = 6
export const SCALE = 1_000_000n
export const USDC_SCALE = SCALE

export function formatUsdc(raw: bigint | undefined | null, dp = 2): string {
  if (raw === undefined || raw === null) return "—"
  const whole = raw / SCALE
  const frac = raw % SCALE
  const fracStr = frac.toString().padStart(6, "0").slice(0, dp)
  return dp === 0 ? whole.toString() : `${whole.toString()}.${fracStr}`
}

// MockUSDC (plain ERC-20 with mint).
export const USDC_ABI: Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
]

// ConfidentialUSDC — wrapper that escrows underlying USDC and exposes encrypted
// balances + approve/transfer over (handle, proof).
export const CUSDC_ABI: Abi = [
  { type: "function", name: "wrap", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint64" }], outputs: [] },
  {
    type: "function", name: "requestUnwrap", stateMutability: "nonpayable",
    inputs: [
      { name: "encExtAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "claimUnwrap", stateMutability: "nonpayable",
    inputs: [
      { name: "unwrapId", type: "uint256" },
      { name: "plainAmount", type: "uint64" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "encExtAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "event", name: "Wrapped", inputs: [{ name: "from", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  {
    type: "event", name: "UnwrapRequested",
    inputs: [
      { name: "unwrapId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "encAmountHandle", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event", name: "UnwrapClaimed",
    inputs: [
      { name: "unwrapId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint64", indexed: false },
    ],
  },
]

export const TREASURY_ABI: Abi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeBasisPoints", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "setFeeBasisPoints", stateMutability: "nonpayable", inputs: [{ name: "newFeeBps", type: "uint16" }], outputs: [] },
  { type: "function", name: "authorizeContract", stateMutability: "nonpayable", inputs: [{ name: "contractAddr", type: "address" }], outputs: [] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
]

// SilentBidAuction — see contracts/src/SilentBidAuction.sol for the canonical
// definition. The struct returned by `getAuction` is exposed as a tuple so the
// shape matches what we build into `AuctionData` below.
const AUCTION_STRUCT_FIELDS = [
  { name: "mode", type: "uint8" },
  { name: "seller", type: "address" },
  { name: "itemName", type: "string" },
  { name: "itemDescription", type: "string" },
  { name: "tokenX", type: "address" },
  { name: "totalSupply", type: "uint256" },
  { name: "minBidPlain", type: "uint64" },
  { name: "minBidEnc", type: "bytes32" },
  { name: "endTime", type: "uint64" },
  { name: "ended", type: "bool" },
  { name: "finalized", type: "bool" },
  { name: "runningHighestBid", type: "bytes32" },
  { name: "runningHighestBidder", type: "bytes32" },
  { name: "winnerPlain", type: "address" },
  { name: "winningAmountPlain", type: "uint64" },
  { name: "clearingPricePlain", type: "uint64" },
  { name: "unsoldReturned", type: "uint256" },
  { name: "gasDeposit", type: "uint256" },
] as const

export const AUCTION_ABI: Abi = [
  {
    type: "function", name: "createAuctionItem", stateMutability: "payable",
    inputs: [
      { name: "itemName", type: "string" },
      { name: "itemDescription", type: "string" },
      { name: "minBidPlain", type: "uint64" },
      { name: "durationSeconds", type: "uint64" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "createAuctionToken", stateMutability: "payable",
    inputs: [
      { name: "itemName", type: "string" },
      { name: "itemDescription", type: "string" },
      { name: "tokenX", type: "address" },
      { name: "supply", type: "uint256" },
      { name: "minBidPlain", type: "uint64" },
      { name: "durationSeconds", type: "uint64" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "placeBid", stateMutability: "payable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "encExtPrice", type: "bytes32" },
      { name: "encExtQty", type: "bytes32" },
      { name: "priceProof", type: "bytes" },
      { name: "qtyProof", type: "bytes" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "endAuction", stateMutability: "nonpayable", inputs: [{ name: "auctionId", type: "uint256" }], outputs: [] },
  {
    type: "function", name: "finalizeAuctionItem", stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "winner", type: "address" },
      { name: "winningAmount", type: "uint64" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "finalizeAuctionToken", stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      { name: "prices", type: "uint64[]" },
      { name: "qtys", type: "uint64[]" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "auctionCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextAuctionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bidCount", stateMutability: "view", inputs: [{ name: "auctionId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getAuction", stateMutability: "view",
    inputs: [{ name: "auctionId", type: "uint256" }],
    outputs: [{ name: "v", type: "tuple", components: AUCTION_STRUCT_FIELDS as unknown as { name: string; type: string }[] }],
  },
  {
    type: "function", name: "getBid", stateMutability: "view",
    inputs: [{ name: "auctionId", type: "uint256" }, { name: "idx", type: "uint256" }],
    outputs: [
      { name: "bidder", type: "address" },
      { name: "encPriceHandle", type: "bytes32" },
      { name: "encQtyHandle", type: "bytes32" },
      { name: "encEscrowHandle", type: "bytes32" },
      { name: "settled", type: "bool" },
      { name: "allocatedTokenX", type: "uint256" },
      { name: "refundedCUSDC", type: "uint64" },
    ],
  },
  {
    type: "event", name: "AuctionCreatedItem",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "itemName", type: "string", indexed: false },
      { name: "minBidPlain", type: "uint64", indexed: false },
      { name: "endTime", type: "uint64", indexed: false },
      { name: "gasDeposit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "AuctionCreatedToken",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "tokenX", type: "address", indexed: true },
      { name: "supply", type: "uint256", indexed: false },
      { name: "minBidPlain", type: "uint64", indexed: false },
      { name: "endTime", type: "uint64", indexed: false },
      { name: "gasDeposit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "BidPlaced",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "bidIndex", type: "uint256", indexed: true },
      { name: "bidder", type: "address", indexed: true },
      { name: "encPriceHandle", type: "bytes32", indexed: false },
      { name: "encQtyHandle", type: "bytes32", indexed: false },
    ],
  },
  { type: "event", name: "AuctionEnded", inputs: [{ name: "auctionId", type: "uint256", indexed: true }] },
  {
    type: "event", name: "AuctionFinalizedItem",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "amount", type: "uint64", indexed: false },
      { name: "fee", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event", name: "AuctionFinalizedToken",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true },
      { name: "clearingPrice", type: "uint64", indexed: false },
      { name: "totalAllocated", type: "uint256", indexed: false },
      { name: "unsoldReturned", type: "uint256", indexed: false },
      { name: "fee", type: "uint64", indexed: false },
    ],
  },
]

export type AuctionMode = "ITEM" | "TOKEN"

/**
 * Front-end shape for the `Auction` struct returned by `getAuction()`. We use
 * a string mode tag for ergonomics and add an `id` we attach client-side; the
 * raw on-chain tuple has `mode: 0|1` which we coerce on read.
 */
export type AuctionData = {
  id: bigint
  mode: AuctionMode
  seller: Address
  itemName: string
  itemDescription: string
  tokenX: Address
  totalSupply: bigint
  minBidPlain: bigint
  endTime: bigint
  ended: boolean
  finalized: boolean
  highestBidHandle: string
  highestBidderHandle: string
  winnerPlain: Address
  winningAmountPlain: bigint
  clearingPricePlain: bigint
  unsoldReturned: bigint
  gasDeposit: bigint
  // numBids is read separately via `bidCount` — included on AuctionData for
  // convenience to the UI that already mutates it post-fetch.
  numBids: bigint
}

export type AuctionStatus = "live" | "ended" | "finalized"

/**
 * Pure status helper — pass an explicit `nowSec` so callers that derive their
 * UI clock from a state-driven timer (vs `Date.now()`) get deterministic
 * re-renders. Falls back to wall-clock when omitted.
 */
export function auctionStatus(a: AuctionData, nowSec?: number): AuctionStatus {
  if (a.finalized) return "finalized"
  const now = nowSec ?? Math.floor(Date.now() / 1000)
  if (a.ended || now >= Number(a.endTime)) return "ended"
  return "live"
}

export function decryptPending(a: AuctionData): boolean {
  return a.ended && !a.finalized
}

/**
 * Coerce the raw tuple returned by `getAuction()` into the typed AuctionData
 * shape used throughout the UI. Adds `id` (which the contract doesn't return)
 * and translates the numeric mode + augments with `numBids` (default 0n;
 * callers should backfill via `bidCount`).
 */
export function parseAuctionTuple(raw: unknown, id: bigint): AuctionData {
  const v = raw as {
    mode: number | bigint
    seller: Address
    itemName: string
    itemDescription: string
    tokenX: Address
    totalSupply: bigint
    minBidPlain: bigint
    endTime: bigint
    ended: boolean
    finalized: boolean
    runningHighestBid: string
    runningHighestBidder: string
    winnerPlain: Address
    winningAmountPlain: bigint
    clearingPricePlain: bigint
    unsoldReturned: bigint
    gasDeposit: bigint
  }
  return {
    id,
    mode: Number(v.mode) === 1 ? "TOKEN" : "ITEM",
    seller: v.seller,
    itemName: v.itemName,
    itemDescription: v.itemDescription,
    tokenX: v.tokenX,
    totalSupply: v.totalSupply,
    minBidPlain: v.minBidPlain,
    endTime: v.endTime,
    ended: v.ended,
    finalized: v.finalized,
    highestBidHandle: v.runningHighestBid,
    highestBidderHandle: v.runningHighestBidder,
    winnerPlain: v.winnerPlain,
    winningAmountPlain: v.winningAmountPlain,
    clearingPricePlain: v.clearingPricePlain,
    unsoldReturned: v.unsoldReturned,
    gasDeposit: v.gasDeposit,
    numBids: 0n,
  }
}
