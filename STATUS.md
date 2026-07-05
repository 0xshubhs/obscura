# SilentBID-ZAMA — Project Status

Last updated: 2026-05-06

## ✅ Done

### Contracts (live on Sepolia) — REDEPLOYED 2026-07-05 with the TOKEN-mode fix
- `MockUSDC` — `0x284f2a7c89FE5Ac3245108091d86A05e36c4a111`
- `MockTokenX` — `0xc96A124100AA66159892047039aD1b60fB3558Cc`
- `ConfidentialUSDC` — `0x7DDB59ad465Fc824BA6cAaD1848E8a34cDE63063`
- `Treasury` — `0x5b6fCb37Bc3106c76DD6C921cb049c84691b345A`
- `SilentBidAuction` — `0x5e053a9952c7bBc56332692e8848871a96584933` (positional-encoding TOKEN fix; `forge test` 15/15)
- Deployer EOA: `0x08e187b4751D4D6B67C093aFC1B5d1843dC38163` (Foundry keystore `meow`, password `meow`)
- Not yet Etherscan-verified. Prior set is orphaned (old auction `0xa10314F70e90F8e12a8C6C6e5A2fbdb0f398D84c`).
- Foundry test suite: passing (Treasury, USDC/TokenX, ConfidentialUSDC w/ forge-fhevm)

### Frontend (Next.js 16 + wagmi + Zama relayer-sdk)
- Pages: `/`, `/auctions`, `/auctions/[id]`, `/auctions/new`, `/my-bids`, `/wallet`, `/admin/treasury`
- Wallet flow: mint USDC → approve → wrap to cUSDC → unwrap (request + claim)
- Auction flow: create ITEM/TOKEN → place encrypted bid → end → reveal + finalize
- Manual finalize button kept as fallback in `app/auctions/[id]/reveal-panel.tsx`
- All ABI / addresses pulled from `.env.local` via static `process.env.X` literals (webpack-replaceable)
- Tenderly Sepolia gateway (`sepolia.gateway.tenderly.co`) used to bypass publicnode's ~10M gas-estimate cap
- Explicit `gas:` caps on every `writeContract` to skip RPC `eth_estimateGas`

### Auto-finalize keeper (the new bit)

Two-layer scheduler: precise per-auction one-shots primary, periodic sweep secondary.

- `app/api/cron/finalize/route.ts` — keeper executor (Vercel function)
  - `?auctionId=N` mode: aggressively run BOTH transitions in one call (endAuction → 30s wait → publicDecrypt → finalize)
  - no-param mode: sweep all auctions, one transition per call (safety-net path)
  - Time check uses on-chain `block.timestamp`, never `Date.now()` — immune to scheduler clock skew
- `app/api/scheduler/route.ts` — POST {auctionId}; re-reads auction from chain, validates state, registers TWO cron-job.org one-shots: `endTime + 30s` (drives endAuction) and `endTime + 90s` (drives finalize). Two-shot split keeps every Vercel invocation under the Hobby 60s cap.
- `lib/scheduler.ts` — cron-job.org REST wrapper (one PUT to `/jobs`, schedules a one-shot fire with auto-expiry 10 min after fire window)
- `.github/workflows/keeper.yml` — GitHub Actions sweep `*/30 * * * *` (safety net only)
- `vercel.json` — function-level `maxDuration: 60` only (Hobby cron is useless: 1/day cap)
- `next.config.ts` — `serverExternalPackages: [node-tfhe, node-tkms, @zama-fhe/relayer-sdk]` so the WASM blobs aren't broken by webpack
- `app/auctions/new/create-auction-form.tsx` — fires a non-blocking POST to `/api/scheduler` after createAuction is mined

State machine per auction (chain is the source of truth, no DB):
  - `live` (chainNow < endTime) → skip
  - `endTime` reached, `!ended` → call `endAuction`
  - `ended && !finalized` → `relayer.publicDecrypt(handles)` → `finalizeAuctionItem(id, winner, amount, proof)`
  - `finalized` → skip

Verified live (sweep mode, the original implementation): 3 keeper invocations finalized auctions #0 and #1 with no manual intervention
  - `0xaa7a3a7be21e65872258456ed1cd3b13532a79f14569fe841d96f26388dc71ed` (finalize #0)
  - `0x9f61a65d67342984dd33dcc7f6b9e811a8e6e7792df5595baf7a311dbe98d161` (finalize #1)

**One-shot path verified live (2026-05-06)** — local E2E run via cloudflared tunnel + dev server, two zero-bid auctions:

| Auction | Duration | endTime → ENDED | endTime → FINALIZED | Finalize tx |
|---|---|---|---|---|
| #3 | 3-min | +87s | +149s | `0x13e05adb832eb6aa46e43aa22330ef36c96b4f4bc3a7b8c83e2e66c68f4f9a91` |
| #4 | 15-min | +102s | +180s | `0x6ee737527e310f6e2e0544903e23522cdacbb3b2029e19d6d0c75d0ebdac7c6b` |

Settlement landed in **~2.5–3 min after endTime** for both, all driven by a single cron-job.org one-shot per auction with no human in the loop. The /api/cron/finalize?auctionId=N route ran for 71s (auction #3) / 103s (auction #4) and chained both transitions in one invocation.

## 🟡 Partial / Caveats

- **Keeper supports ITEM mode only.** TOKEN mode is gated behind a contract bug — see Remaining.
- **One-shot precision (two-shot architecture):** `endAuction` lands ~30-50s after endTime, `finalize` lands ~90-110s after endTime. Each invocation runs in ~15-20s — well under the Vercel Hobby 60s cap.
- **Safety-net latency = ~30 min worst case** (GH Actions cron `*/30` + small jitter). This is the fallback when cron-job.org missed the auction.
- **Total cron-job.org slot usage = 2 active jobs per pending auction** (endAuction one-shot + finalize one-shot). Free tier caps at 50, so up to ~25 simultaneously-pending auctions before the limit bites. Auto-expiry (10 min after fire window) keeps the pool fresh.
- **First version tried doing both transitions in one call.** Worked in `next dev` (no time limit) but was risky on Vercel Hobby (~57s of work on a 60s cap, prod observed `ended=true && !finalized` on at least one auction before the manual finalize button was clicked). Split-into-two solves it.
- **Privacy of TOKEN-mode losers.** `endAuction` makes every bid's `(encPrice, encQty)` publicly decryptable — every loser's bid leaks at settlement. ITEM mode losers stay private.
- **Bid count, bidder address, and participation flag** are plaintext on-chain (event topics + `hasBid` mapping). This is unchanged from the original architecture.

## ❌ Remaining

### ✅ RESOLVED 2026-07-05 — TOKEN-mode auto-finalize
**Status**: fixed in `_verifyTokenDecryption` (positional `bytes.concat` encoding), `forge test` 15/15, redeployed (auction `0x5e053a9952c7bBc56332692e8848871a96584933`), keeper TOKEN branch re-enabled. Not yet validated by a live TOKEN e2e against the real KMS. Original diagnosis below for reference.

**Bug**: `SilentBidAuction.sol:545` calls
```solidity
FHE.checkSignatures(handles, abi.encode(cleartexts), decryptionProof);
```
where `cleartexts` is `uint256[]`. This produces a *dynamic-array* encoding (offset + length + elements), but the Zama KMS signs a *positional* encoding (`abi.encode(uint256, uint256, …)`). Verification will fail every time.

**Fix**: build positional encoding manually, e.g.:
```solidity
bytes memory packed = "";
for (uint i = 0; i < n; i++) {
    packed = bytes.concat(packed, abi.encode(uint256(prices[i])), abi.encode(uint256(qtys[i])));
}
FHE.checkSignatures(handles, packed, decryptionProof);
```
Then redeploy and update `NEXT_PUBLIC_AUCTION_ADDRESS`. Re-enable TOKEN branch in `app/api/cron/finalize/route.ts`.

### Project is NOT a Uniswap CCA port (renaming or scope honesty)
Audit found ~5% mechanism fidelity. SilentBID is a **single-round sealed-bid auction** (running-max ITEM / sort-and-clear UCP TOKEN), not continuous + tick-based. To genuinely port CCA you'd need:
1. Tick book (`TickStorage`) + price-time priority
2. Checkpoints + step schedule (`CheckpointStorage`/`StepStorage`)
3. Partial fills + early exit (`exitPartiallyFilledBid`)
4. UCP computation entirely inside FHE so only clearing price decrypts (the genuinely hard part)
5. Factory + graduation + claim block

For now, pitch as: *"Sealed-bid auction with Zama FHE, inspired by CCA's clearing-price idea."* — not a port.

### Smaller follow-ups
- [ ] Generate a dedicated keeper EOA (separate from deployer) and fund with ~0.05 ETH; rotate `KEEPER_PRIVATE_KEY` in Vercel env
- [ ] Add `npm run keeper` script for local always-on operation as alternative to Vercel cron
- [ ] Auction #2 (live, has 1 bid) will be the first non-trivial keeper test once it expires (~2026-05-07 06:34 UTC)
- [ ] Add winner/clearing display to UI once `finalized=true` (read `winnerPlain` / `winningAmountPlain`)
- [ ] Consider Chainlink Automation upkeep as keeper alternative (decentralized infra, ~$0.50/finalize)

## File map for new contributors

```
contracts/src/SilentBidAuction.sol     — ITEM + TOKEN modes; check :530–546 for the encoding bug
app/api/cron/finalize/route.ts          — keeper executor (?auctionId=N or sweep)
app/api/scheduler/route.ts              — POST endpoint that registers cron-job.org one-shots
lib/scheduler.ts                        — cron-job.org REST wrapper
app/auctions/new/create-auction-form.tsx — POSTs to /api/scheduler after createAuction
.github/workflows/keeper.yml             — GH Actions safety-net sweep every 30 min
vercel.json                              — maxDuration only (Hobby cron is unusable)
next.config.ts                           — serverExternalPackages for the SDK WASM
lib/zama.ts                              — relayer-sdk wrapper (client-side encryption + decryption)
lib/zama-contracts.ts                    — ABIs + addresses + AuctionData type + parseAuctionTuple
lib/chain-config.ts                      — sepolia chain export
app/auctions/[id]/reveal-panel.tsx       — manual finalize fallback (still works alongside the keeper)
.env.local                               — addresses + KEEPER_PRIVATE_KEY + CRON_SECRET + CRONJOBORGAPIKEY (gitignored)
```
