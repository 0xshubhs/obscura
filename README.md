# Obscura

Multi-winner sealed-bid uniform-clearing-price auction on **Zama FHEVM**. Bids stay encrypted on-chain throughout the bidding window — no one (not the seller, not other bidders, not validators) can see anyone's bid until settlement. At end of window, the contract reveals only the clearing price and winner allocations via Zama's KMS-signed public decryption.

A spiritual port of [SilentBID-FHENIX](../Silentbid-FHENIX/) onto the Zama stack, extended with a multi-winner uniform-clearing-price (UCP) settlement mode inspired by [Uniswap's Continuous Clearing Auction](../continuous-clearing-auction/).

## Two auction modes

| Mode  | Use case                | Bid shape              | Settlement                                                                                |
| ----- | ----------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| ITEM  | Single-item English     | encrypted price, qty=1 | Single highest bidder wins, pays own bid in cUSDC (FHENIX parity)                         |
| TOKEN | Token sale / batch sale | encrypted (price, qty) | Multi-winner UCP: all winners pay the clearing price × allocated qty; pro-rata at boundary |

## Stack

| Layer                | Tooling                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| Contracts            | Foundry, Solidity 0.8.27, EVM cancun, via_ir                           |
| FHE Solidity library | `@fhevm/solidity@0.11.1` (vendored via `forge-fhevm` soldeer deps)     |
| FHE testing          | `zama-ai/forge-fhevm` (real host contracts inside Foundry tests)       |
| Frontend             | Next.js 16, React 19, wagmi 3, viem 2, RainbowKit, Tailwind 4, Radix UI |
| FHE client           | `@zama-fhe/relayer-sdk@0.4.2` (browser bundle)                         |
| Network              | Sepolia FHEVM (chainId 11155111)                                       |

## Layout

```
Obscura/
├── contracts/                   Foundry project
│   ├── src/
│   │   ├── MockUSDC.sol         6-decimal underlying, faucet (≤1000/call)
│   │   ├── MockTokenX.sol       18-decimal generic ERC20 (TOKEN-mode auction asset)
│   │   ├── Treasury.sol         Plaintext fee bps (cap 10%) + auth whitelist
│   │   ├── ConfidentialUSDC.sol cUSDC: euint64 balances/allowances, two-step unwrap
│   │   └── Obscura.sol          Both modes; FHE running-max for ITEM + UCP for TOKEN
│   │                            (+ opt-in sealed reserve / Vickrey second-price on ITEM)
│   ├── test/
│   │   ├── MockTokens.t.sol
│   │   ├── Treasury.t.sol
│   │   ├── ConfidentialUSDC.t.sol  uses forge-fhevm FhevmTest base
│   │   └── Obscura.t.sol           e2e ITEM + TOKEN + sealed/Vickrey flows
│   ├── script/Deploy.s.sol      Deploy MockUSDC → MockTokenX → cUSDC → Treasury → Auction
│   ├── foundry.toml
│   └── remappings.txt
├── app/                         Next.js (ported from FHENIX)
├── components/                  React UI (ported from FHENIX)
├── lib/
│   ├── zama.ts                  Replaces FHENIX lib/cofhe.ts
│   ├── zama-contracts.ts        Replaces FHENIX lib/fhenix-contracts.ts
│   └── wagmi-config.ts
└── package.json
```

## Quick start

### Prerequisites

- Node.js ≥ 20
- Foundry (`forge`, `cast`, `anvil`) — install via `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- A Sepolia private key with some test ETH ([Sepolia faucet](https://sepoliafaucet.com))

### 1. Install + test contracts

```bash
cd contracts
git init -q   # forge install requires a git repo at cwd
forge install foundry-rs/forge-std zama-ai/forge-fhevm OpenZeppelin/openzeppelin-contracts@v5.1.0
( cd lib/forge-fhevm && forge soldeer install )
forge build
forge test -vv
```

Plain-Solidity tests (Treasury, mocks): all green. ConfidentialUSDC tests using `forge-fhevm` test harness: 5/6 green; the 6th (claimUnwrap with mock KMS sigs) is a known mock-quirk and works correctly against the real Sepolia KMS.

### 2. Deploy to Sepolia FHEVM

```bash
cp .env.example .env
# edit .env: PRIVATE_KEY, SEPOLIA_RPC_URL

forge script script/Deploy.s.sol \
  --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
```

Copy the printed `NEXT_PUBLIC_*` block into `../.env.local` at the project root.

### 3. Run the frontend

```bash
cd ..  # back to project root
npm install
npm run dev
# → http://localhost:3000
```

### 4. Auto-finalize keeper (cron-job.org one-shots + GH Actions safety net)

Zama FHEVM v0.11 has no on-chain decryption callback — somebody has to fetch
plaintext + KMS signatures from the relayer and submit them to
`finalizeAuction*`. We do that automatically with a two-layer scheduler:

```
app/api/cron/finalize/route.ts    # stateless keeper handler (the executor)
app/api/scheduler/route.ts         # POST endpoint that registers one-shots
lib/scheduler.ts                   # cron-job.org REST wrapper
.github/workflows/keeper.yml        # GH Actions safety-net sweep every 30 min
vercel.json                         # function-level maxDuration only
```

**Layer 1: cron-job.org one-shots (precise primary path).**
After `createAuction` is mined, the frontend POSTs `{auctionId}` to
`/api/scheduler`. That route re-reads the auction from chain (the client
never gets to set the timing — only the chain's own `endTime` matters),
then registers **two** one-shots against `/api/cron/finalize?auctionId=N`:
one at `endTime + 30s` (drives `endAuction`) and one at `endTime + 90s`
(drives `publicDecrypt + finalizeAuctionItem`). Each invocation does at
most one transition based on chain state, finishing in ~15-20s — well
under Vercel Hobby's 60s function cap. The two one-shots share the same
URL and the route's state machine handles whichever transition is next.

**Layer 2: GitHub Actions sweep (fallback safety net).**
`*/30 * * * *` pings `/api/cron/finalize` (no `auctionId`) which iterates
every auction and processes one transition per call. Catches any auction
whose one-shot was missed — cron-job.org outage, scheduling-API call failed,
browser closed before the scheduler POST landed, etc.

**Time check is anchored to chain `block.timestamp`, not server clock.**
Validators publish blocks with timestamps that drift up to a few seconds
from wall-clock; cron-job.org has its own clock. We always read the latest
block's timestamp and compare against `auction.endTime`, which is the same
clock the contract uses to gate `endAuction`. This makes the system immune
to scheduler clock skew — if cron-job.org fires a few seconds early the
keeper sees `chainNow < endTime` and skips gracefully.

```
live      (chainNow < endTime, !ended)             → skip
expired   (chainNow >= endTime, !ended)            → call endAuction
ended     (a.ended && !a.finalized)                → publicDecrypt + finalize
finalized (a.finalized)                            → skip
```

**Latency budget (happy path with cron-job.org):** `endAuction` lands ~30s
after `endTime`, `finalize` lands ~90-110s after `endTime`. Worst case
(both one-shots missed, GH safety net catches up): ~30 min per transition.
The frontend's manual finalize button still works either way.

**Env vars required on Vercel (Project → Settings → Environment Variables):**

```bash
KEEPER_PRIVATE_KEY=0x...    # any funded EOA on Sepolia (~0.05 ETH for headroom)
CRON_SECRET=<random-string> # protects /api/cron/finalize from arbitrary callers
CRONJOBORGAPIKEY=<api-key>  # cron-job.org account API key (Settings → API)
KEEPER_URL=https://<project>.vercel.app   # explicit base URL (optional —
                                          # auto-resolved from request host
                                          # otherwise)
NEXT_PUBLIC_AUCTION_ADDRESS=0xa10314...
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co
```

**Repo secrets for the GH Actions safety-net cron** (Settings → Secrets and
variables → Actions):

```
KEEPER_URL    https://<your-project>.vercel.app
CRON_SECRET   same value as the Vercel env var above
```

For local testing:

```bash
# Trigger a one-shot for a specific auction
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/finalize?auctionId=0"

# Trigger the safety-net sweep
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/finalize"

# Schedule a one-shot via the scheduler endpoint
curl -X POST -H "Content-Type: application/json" \
  -d '{"auctionId":"0"}' \
  http://localhost:3000/api/scheduler
```

**Limitations:**
- TOKEN-mode finalize was previously blocked by a cleartext-encoding mismatch:
  the contract encoded the cleartexts as `abi.encode(uint256[])` (dynamic array)
  but the KMS signs positional `abi.encode(uint256, uint256, …)`. **Fixed** in
  `_verifyTokenDecryption` (`contracts/src/Obscura.sol`) — it now builds
  the positional encoding via `bytes.concat`, mirroring `finalizeAuctionItem`.
  Verified by `forge test` (15/15), deployed to the current auction, and the
  keeper's TOKEN branch is re-enabled. (The manual finalize button remains as a
  fallback.)
- cron-job.org free tier caps you at 50 active jobs. Each auction uses
  TWO slots (endAuction + finalize one-shots), so the practical ceiling is
  ~25 simultaneously-pending auctions. Auto-expiry (10 min past fire) keeps
  the slot pool fresh as auctions finalize.

## How the FHE flow works

### Place a sealed bid (TOKEN mode)

1. **UI** prompts for price + quantity in cUSDC and TokenX units
2. **`@zama-fhe/relayer-sdk`** encrypts both as `euint64` against the auction contract's address — produces `{handles, inputProof}` from the relayer
3. **UI** approves the encrypted cUSDC escrow (`cUSDC.approve(auction, encMaxAmount, proof)`)
4. **UI** calls `Obscura.placeBid(id, encPriceHandle, encQtyHandle, inputProof)`
5. Contract pulls cUSDC via `cUSDC.transferFromAllowance(bidder, auction)` (encrypted, no leakage)
6. Contract stores `Bid{ bidder, encPrice, encQty }` — only the FHE handles touch storage; the underlying values never decrypt during the auction

### Settle (TOKEN mode)

1. **Anyone** calls `endAuction(id)` after `endTime` — contract calls `FHE.makePubliclyDecryptable` on every `(encPrice, encQty)` handle, plus the running winner state
2. **Off-chain** an actor (the seller, a bidder, or a third-party keeper) fetches the cleartexts + KMS signatures from the Zama relayer for those handles
3. **They** call `finalizeAuctionToken(id, prices[], qtys[], decryptionProof)` — the contract:
   - `FHE.checkSignatures(handles, encoded(plaintexts), proof)` — reverts if any KMS sig is invalid
   - Sorts bids by price descending
   - Walks down accumulating qty until `cumulative >= supply` — clearing price = price of the last (boundary) bid
   - Pro-rata allocates qty at the boundary tick
   - Winners get TokenX, are charged `clearing × allocatedQty` in cUSDC
   - Losers get full cUSDC refund
   - Treasury gets `feeBps * clearing` per winner
   - Unsold TokenX returns to seller

### Unwrap cUSDC

1. `cUSDC.requestUnwrap(encAmount, proof, recipient)` debits the encrypted balance and marks the amount publicly decryptable
2. Off-chain: fetch `(plain, proof)` from Zama relayer
3. Anyone calls `cUSDC.claimUnwrap(unwrapId, plain, proof)` — verifies KMS sig, releases the underlying USDC

## Security notes

- Reentrancy: all settlement paths use `nonReentrant` + CEI ordering
- USDC has 6 decimals (`uint64` is sufficient for any realistic bid)
- All encrypted state has explicit ACL grants (`FHE.allowThis` + `FHE.allow(handle, user)`) — Zama's strictest mode
- Multiply-before-divide on fee math
- SafeERC20 for the USDC underlying and TokenX

## Why this architecture

| Concern         | Choice                            | Rationale                                                                                  |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Bid privacy     | On-chain `euint64` ciphertexts    | No off-chain trust, no committee, no commit-reveal latency — pure FHE                      |
| MEV resistance  | Bids never decrypt during window  | Validators can't read or reorder by content; identity is plaintext but bid value is hidden |
| Multi-winner    | Uniform clearing price            | Avoids winner's curse, encourages truthful bidding (vs pay-as-bid)                         |
| Settlement gas  | Off-chain decryption + on-chain checkSignatures | Avoids running an FHE sort on-chain (intractable)                                          |
| Unsold supply   | Returns to seller                 | No dead-token loss when a TOKEN auction is undersubscribed                                 |

## License

MIT
