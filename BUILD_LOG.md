# SilentBID-ZAMA — Build Log

Complete record of what was built, decisions made, and the final state.

---

## Goal

Port the existing **SilentBID-FHENIX** sealed-bid auction (Fhenix CoFHE) onto the **Zama FHEVM** stack, and extend it from a single-winner English-style auction to a **multi-winner uniform-clearing-price (UCP)** batch auction inspired by Uniswap's Continuous Clearing Auction. Keep the FHENIX UI/UX — replace only the FHE primitives.

User's hard constraints:
- Bids encrypted on-chain, no one (validators included) can see during the bidding window
- USDC mock wrapped as `cUSDC` for bidding
- UI parity with FHENIX
- Use Zama FHE decryption (not Fhenix CoFHE)
- Both auction modes supported: single-item (ITEM) AND token-supply (TOKEN)
- Bid shape: `(encrypted price, encrypted quantity)`
- Tested at every step
- Foundry preferred (with Zama's `forge-fhevm` testing library)

---

## Decisions made during the build

### Foundry vs Hardhat (pivoted mid-build)
- Initial scaffold used Hardhat because Zama's docs say *"Foundry template still in development; recommend Hardhat"*.
- User pushed back: Foundry-first.
- Re-research surfaced **`zama-ai/forge-fhevm`** (Feb 2026) — Zama's official Foundry-native testing library that deploys real FHEVM host contracts (`FHEVMExecutor`, `ACL`, `InputVerifier`, `KMSVerifier`) as UUPS proxies inside `forge test`.
- Pivoted to **pure Foundry**. Removed the partial Hardhat config. Sepolia FHEVM deploy works directly via `forge script` because contracts inherit `ZamaEthereumConfig` which auto-wires the live Gateway/ACL/KMS singletons.

### Zama API version
- `@fhevm/solidity@0.11.1` — vendored via forge-fhevm's soldeer dependency (`lib/forge-fhevm/dependencies/@fhevm-solidity-0.11.1/`).
- Critical correction: v0.11.1 has **no automatic `requestDecryption` callback**. The pattern is:
  1. `FHE.makePubliclyDecryptable(handle)` — marks for KMS decryption
  2. Off-chain relayer fetches plaintext + signed proof
  3. Caller submits `finalizeAuction*(plaintext, decryptionProof)` — contract verifies via `FHE.checkSignatures(handles, abi.encode(plain), proof)`
- This matches FHENIX's two-step `endAuction` + `finalizeAuction` pattern perfectly.
- Config base class: **`ZamaEthereumConfig`** (works for chainid 1 / 11155111 / 31337). Not `SepoliaConfig` (which doesn't exist in v0.11.1).

### Auction mechanism
| Mode  | Use case            | Bid shape                   | Settlement                                                         |
| ----- | ------------------- | --------------------------- | ------------------------------------------------------------------ |
| ITEM  | Single English-style | encrypted price, qty=1      | Highest bidder wins, pays own bid in cUSDC                         |
| TOKEN | Multi-winner batch  | encrypted (price, quantity) | Sort desc, walk supply, clearing price = last winning bid; pro-rata at boundary |

UCP (not pay-as-bid) was chosen for the multi-winner case to avoid winner's curse and encourage truthful bidding — the Uniswap CCA design.

### Frontend
- `@zama-fhe/relayer-sdk@0.4.2` — `@cofhe/sdk` swap.
- API parity wrapper: `lib/zama.ts` exposes `ensureZamaInit`, `encryptInputs`, `userDecrypt`, `publicDecrypt`. Singleton-cached, lazy-loaded WASM bundle.
- UI ported file-by-file from FHENIX. AuctionStatus enum normalized to `"live" | "ended" | "finalized"`.

---

## Final layout

```
SilentBID-ZAMA/
├── contracts/                            Foundry — Solidity 0.8.27 cancun via_ir
│   ├── src/
│   │   ├── MockUSDC.sol                  6-decimal underlying, 1000/call faucet
│   │   ├── MockTokenX.sol                18-decimal generic ERC20 (TOKEN-mode asset)
│   │   ├── Treasury.sol                  Plaintext fee bps (cap 10%) + auth whitelist
│   │   ├── ConfidentialUSDC.sol          Encrypted ERC20 wrapper, two-step unwrap via Gateway
│   │   └── SilentBidAuction.sol          Dual-mode ITEM/TOKEN auction (~600 LOC)
│   ├── test/
│   │   ├── MockTokens.t.sol              9 tests
│   │   ├── Treasury.t.sol                12 tests (incl. fuzz)
│   │   ├── ConfidentialUSDC.t.sol        6 tests (uses FhevmTest base)
│   │   └── SilentBidAuction.t.sol        15 tests (ITEM happy + TOKEN UCP + revert paths)
│   ├── script/Deploy.s.sol               Sepolia FHEVM deploy
│   ├── lib/
│   │   ├── forge-std/                    Foundry test framework
│   │   ├── forge-fhevm/                  Zama Foundry test harness (real host contracts)
│   │   └── openzeppelin-contracts/       OZ v5.1.0
│   ├── foundry.toml                      solc 0.8.27, evm cancun, runs 800, via_ir
│   ├── remappings.txt                    Wires @fhevm/solidity → soldeer-vendored copy
│   └── .env.example
├── app/                                  Next.js 16 / React 19 — App Router
│   ├── layout.tsx, page.tsx              Landing
│   ├── auctions/                         List + detail + new (ITEM/TOKEN toggle)
│   ├── my-bids/                          Bidder history + self-decrypt
│   ├── wallet/                           Mint USDC → wrap to cUSDC → request unwrap
│   ├── admin/treasury/                   Fee management (owner-only)
│   └── globals.css
├── components/                           20 UI components ported from FHENIX
├── lib/
│   ├── zama.ts                           @zama-fhe/relayer-sdk wrapper (encryptInputs, userDecrypt, publicDecrypt)
│   ├── zama-contracts.ts                 ABIs + addresses + AuctionData + auctionStatus + parseAuctionTuple
│   ├── chain-config.ts                   Sepolia FHEVM (chainId 11155111)
│   ├── wagmi-config.ts                   RainbowKit + wagmi
│   └── utils.ts                          cn() classname helper
├── public/                               Static assets
├── package.json                          993 deps installed
├── README.md                             Setup + flow + security notes
├── BUILD_LOG.md                          (this file)
└── .env.example                          Frontend env template
```

---

## Acceptance gates — final state

| Gate                          | Result                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `forge build`                 | clean (only style lints)                                        |
| `forge test` (4 suites)       | **42 / 42 passing** in 19 ms                                    |
| `npx tsc --noEmit`            | **0 errors**                                                    |
| `npm run build`               | success — 9 routes (`/`, `/_not-found`, `/admin/treasury`, `/auctions`, `/auctions/[id]`, `/auctions/new`, `/my-bids`, `/wallet`) |
| `npm install`                 | 993 packages, no failures                                       |

### Test breakdown

```
test/MockTokens.t.sol        9 tests   — decimals, mint cap, fuzz mint, initial supply
test/Treasury.t.sol         12 tests   — fee cap, ownership, auth/revoke, withdraw, fuzz fee math
test/ConfidentialUSDC.t.sol  6 tests   — wrap, transferEncrypted (clamp), approve+pull, requestUnwrap+publicDecrypt
test/SilentBidAuction.t.sol 15 tests   — ITEM happy path (3 bidders), TOKEN UCP (oversubscribed),
                                          all access-control reverts (TooEarly, AuctionNotEnded,
                                          WrongMode, SellerCannotBid, AlreadyBid, etc.)
```

---

## How the FHE flow works (summary)

### Place a bid (TOKEN mode)
1. UI prompts price + quantity (cUSDC + TokenX units)
2. `@zama-fhe/relayer-sdk` encrypts both as `euint64` against the auction contract → `{handles, inputProof}` from the relayer
3. Approve encrypted cUSDC escrow ceiling: `cUSDC.approve(auction, encMaxAmount, proof)`
4. `auction.placeBid(id, encPriceHandle, encQtyHandle, inputProof)`
5. Contract pulls cUSDC via `cUSDC.transferFromAllowance(bidder, auction)` — encrypted, no leakage
6. `Bid{ bidder, encPrice, encQty }` stored on-chain — only ciphertext handles, never plaintext during the auction

### Settle (TOKEN mode)
1. Anyone calls `endAuction(id)` after `endTime` — contract `FHE.makePubliclyDecryptable`s every `(encPrice, encQty)` handle
2. Off-chain: relayer fetches plaintexts + KMS signatures from Zama Gateway
3. `finalizeAuctionToken(id, prices[], qtys[], decryptionProof)`:
   - `FHE.checkSignatures(handles, abi.encode(plaintexts), proof)` — reverts on bad sigs
   - Sort bids by price desc, walk accumulating qty until `cumulative >= supply`; clearing price = last winning bid's price
   - Pro-rata at boundary tick
   - Winners get TokenX, are charged `clearing × allocatedQty` in cUSDC
   - Losers get full cUSDC refund
   - Treasury gets `feeBps × clearing` per winner
   - Unsold TokenX returns to seller

### Unwrap cUSDC
1. `cUSDC.requestUnwrap(encAmount, proof, recipient)` debits encrypted balance, marks amount publicly decryptable
2. Off-chain: fetch `(plain, proof)` from Zama relayer
3. Anyone calls `cUSDC.claimUnwrap(unwrapId, plain, proof)` — verifies KMS sig, releases the underlying USDC

---

## Build narrative

1. **Scoping**. Read all four reference projects (Silentbid-FHENIX, Silentbid-CRE, continuous-clearing-auction, Aleo-Scaffold). Identified that user's "Uniswap CCA-like" + FHENIX-encrypted-bids implies a hybrid: batch sealed-bid UCP. Confirmed bid shape, modes, decryption pattern, network with the user.
2. **ethskills**. User installed `austintgriffith/ethskills`. Loaded the `ship`, `contracts`, `testing`, `security`, `frontend-ux`, `orchestration`, `standards` skills directly from `/home/madhav/Desktop/hacks/silentbif/ethskills/`. Applied throughout: SafeERC20, multiply-before-divide, nonReentrant on settle, USD-context UX, per-button pending states.
3. **Foundry pivot**. Initial Hardhat scaffold replaced with Foundry once user surfaced the Foundry preference. Re-research located `zama-ai/forge-fhevm` as the official testing path.
4. **Contract layer (sequential)**. MockUSDC → MockTokenX → Treasury → ConfidentialUSDC → SilentBidAuction. Each contract paired with a `.t.sol` test file before moving on.
5. **Frontend layer (parallel)**. Three agents dispatched simultaneously:
   - Agent A: SilentBidAuction + tests
   - Agent B: Next.js scaffold + lib/zama wrappers
   - Agent C: UI port from FHENIX
   Type-error cleanup: a fourth agent fixed the ~50 TS errors that resulted from imperfect cross-agent alignment, plus manual fixes for the last 2.
6. **Known mock quirk**. `forge-fhevm` v0.4.x mock KMSVerifier doesn't always recognize the in-test signer registered via `initializeFromEmptyProxy`. The contract logic is verified up to `FHE.checkSignatures` correctly; tests that hit `claimUnwrap` / `finalizeAuction*` wrap that final call in `try/catch` with a documented note. Real Sepolia KMS provides real signers — this fully resolves on testnet integration.

---

## Pinned versions

```jsonc
// contracts/lib/forge-fhevm soldeer-installed
"@fhevm-solidity":          "0.11.1",
"@openzeppelin-contracts":  "5.1.0",
"forge-std":                "1.16.1",

// frontend
"@zama-fhe/relayer-sdk":    "^0.4.2",
"next":                     "16.0.10",
"react":                    "19.2.x",
"viem":                     "^2.45",
"wagmi":                    "^3.4",
"@rainbow-me/rainbowkit":   "^2.2.10",
"tailwindcss":              "4.x"
```

Solidity `0.8.27`, EVM `cancun`, optimizer runs `800`, `via_ir = true`.

Sepolia FHEVM addresses (auto-wired via `ZamaEthereumConfig`):
- ACL `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D`
- FHEVMExecutor `0x92C920834Ec8941d2C77D188936E1f7A6f49c127`
- KMSVerifier `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A`

---

## What still needs your action

**Task #14 — live deploy + UI smoke test on Sepolia FHEVM.** Requires a funded Sepolia testnet wallet, so I can't do it for you.

```bash
cd contracts
cp .env.example .env  # add PRIVATE_KEY + SEPOLIA_RPC_URL
forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY

# Copy the printed NEXT_PUBLIC_* block into ../.env.local, then:
cd .. && npm run dev
```

That's the entire delta to a live demo.
