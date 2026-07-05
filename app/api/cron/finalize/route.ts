/**
 * Auto-finalize keeper.
 *
 * Why this exists: Zama FHEVM v0.11 has no on-chain decryption callback.
 * `FHE.makePubliclyDecryptable(...)` only marks a handle as decryptable; an
 * off-chain caller still has to fetch cleartext + KMS signatures from the
 * relayer and submit them to `finalizeAuction*`. This endpoint plays that
 * caller, automatically. The chain remains the state machine — no DB.
 *
 * Two callers, one route:
 *   1. cron-job.org one-shots for a specific auction:
 *        GET /api/cron/finalize?auctionId=N
 *      Two pings per auction — one at endTime+30s (does endAuction) and one
 *      at endTime+150s (does finalize). Each invocation processes a SINGLE
 *      transition based on chain state, finishing in ~15-20s. Splitting like
 *      this keeps every call well under Vercel Hobby's 60s function cap.
 *
 *   2. GitHub Actions safety-net cron every 30 min, no query param:
 *        GET /api/cron/finalize
 *      Iterates all auctions, processes ONE transition per auction per call.
 *      Catches anything cron-job.org missed.
 *
 * State machine per auction (idempotent — chain is source of truth):
 *   live (chainNow < endTime, !ended)             → skip
 *   expired (chainNow >= endTime, !ended)         → call endAuction
 *   ended && !finalized                           → publicDecrypt + finalize
 *   finalized                                     → skip
 *
 * Time check uses `block.timestamp` from the latest block, NOT `Date.now()`.
 * Validators publish blocks with timestamps that drift up to a few seconds
 * from wall-clock. cron-job.org's clock can drift independently. The chain
 * is the only reference both sides agree on, and it's also what the contract
 * uses to gate `endAuction` (`require(block.timestamp >= endTime)`). Trust
 * the same clock the contract trusts.
 */

import { NextResponse } from "next/server"
import {
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  parseAuctionTuple,
} from "@/lib/zama-contracts"

export const runtime = "nodejs"
export const maxDuration = 60
export const dynamic = "force-dynamic"

// Constant-time bearer-token check.
function isAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const got = req.headers.get("authorization") ?? ""
  const want = `Bearer ${expected}`
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

type ActionResult = {
  auctionId: string
  action:
    | "endAuction"
    | "finalizeAuctionItem"
    | "finalizeAuctionToken"
    | "skip-live"
    | "skip-finalized"
    | "skip-token"
    | "skip-pending-relayer"
    | "noop"
  tx?: `0x${string}`
  error?: string
}

/**
 * Process AT MOST ONE state transition for a single auction. The chain is
 * the state machine — the route just dispatches the next step based on what
 * it sees on chain. Splitting like this keeps every invocation well under
 * Vercel Hobby's 60s function cap.
 *
 * Per call:
 *   live (chainNow < endTime, !ended)             → skip
 *   expired (chainNow >= endTime, !ended)         → call endAuction
 *   ended && !finalized                           → publicDecrypt + finalize
 *   finalized                                     → skip
 *
 * cron-job.org schedules two one-shots per auction (endTime+30s and
 * endTime+150s) so the two transitions happen in two separate invocations.
 */
async function processAuction(
  id: bigint,
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: PrivateKeyAccount,
  getZama: () => Promise<Awaited<ReturnType<typeof import("@zama-fhe/relayer-sdk/node").createInstance>>>,
  chainNow: bigint,
): Promise<ActionResult[]> {
  const out: ActionResult[] = []

  const tuple0 = await publicClient.readContract({
    address: AUCTION_ADDRESS,
    abi: AUCTION_ABI,
    functionName: "getAuction",
    args: [id],
  })
  const a = parseAuctionTuple(tuple0, id)

  if (a.finalized) {
    out.push({ auctionId: id.toString(), action: "skip-finalized" })
    return out
  }

  // Transition 1: live → ended.
  if (!a.ended) {
    if (chainNow < a.endTime) {
      out.push({ auctionId: id.toString(), action: "skip-live" })
      return out
    }
    try {
      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "endAuction",
        args: [id],
        gas: 8_000_000n,
        account,
        chain: sepolia,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      out.push({ auctionId: id.toString(), action: "endAuction", tx: hash })
    } catch (e) {
      out.push({
        auctionId: id.toString(),
        action: "endAuction",
        error: (e as Error).message.slice(0, 240),
      })
    }
    return out
  }

  // Transition 2: ended → finalized.
  if (a.mode === "TOKEN") {
    // Re-enabled after the auction was redeployed with the positional cleartext
    // encoding fix in SilentBidAuction._verifyTokenDecryption. The KMS signs the
    // cleartexts as fixed 32-byte words in handle order, and the contract now
    // rebuilds them the same way, so checkSignatures verifies.
    try {
      const inst = await getZama()

      // Read every bid's (encPrice, encQty) handles in bid order. The contract's
      // _verifyTokenDecryption reconstructs handles as [price_0, qty_0, price_1,
      // qty_1, ...], so we decrypt and submit prices[]/qtys[] in that same order.
      const nBids = (await publicClient.readContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "bidCount",
        args: [id],
      })) as bigint

      const priceHandles: `0x${string}`[] = []
      const qtyHandles: `0x${string}`[] = []
      for (let i = 0n; i < nBids; i++) {
        const bid = (await publicClient.readContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "getBid",
          args: [id, i],
        })) as readonly [Address, `0x${string}`, `0x${string}`, `0x${string}`, boolean, bigint, bigint]
        priceHandles.push(bid[1].toLowerCase() as `0x${string}`)
        qtyHandles.push(bid[2].toLowerCase() as `0x${string}`)
      }

      // One publicDecrypt over all handles interleaved [price_0, qty_0, ...] —
      // this is what the KMS signs, and the proof covers every handle at once.
      const allHandles = priceHandles.flatMap((p, i) => [p, qtyHandles[i]])
      const r = await inst.publicDecrypt(allHandles)

      const toBig = (v: unknown) => (typeof v === "bigint" ? v : BigInt(v as string))
      const readClear = (h: `0x${string}`, label: string) => {
        const v = r.clearValues[h]
        if (v === undefined) throw new Error(`relayer returned no plaintext for ${label} handle`)
        return toBig(v)
      }
      const prices = priceHandles.map((h) => readClear(h, "price"))
      const qtys = qtyHandles.map((h) => readClear(h, "qty"))

      const hash = await walletClient.writeContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "finalizeAuctionToken",
        args: [id, prices, qtys, r.decryptionProof],
        gas: 12_000_000n,
        account,
        chain: sepolia,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      out.push({ auctionId: id.toString(), action: "finalizeAuctionToken", tx: hash })
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300)
      out.push({
        auctionId: id.toString(),
        action: msg.includes("404") || msg.toLowerCase().includes("not found")
          ? "skip-pending-relayer"
          : "finalizeAuctionToken",
        error: msg,
      })
    }
    return out
  }

  try {
    const inst = await getZama()
    const handleBidder = a.highestBidderHandle.toLowerCase() as `0x${string}`
    const handleBid = a.highestBidHandle.toLowerCase() as `0x${string}`

    const r = await inst.publicDecrypt([handleBidder, handleBid])

    const winnerRaw = r.clearValues[handleBidder]
    const amountRaw = r.clearValues[handleBid]
    if (winnerRaw === undefined || amountRaw === undefined) {
      throw new Error("relayer returned no plaintext for ITEM handles")
    }
    const winnerBig = typeof winnerRaw === "bigint" ? winnerRaw : BigInt(winnerRaw as string)
    const amountBig = typeof amountRaw === "bigint" ? amountRaw : BigInt(amountRaw as string)
    const winner = (`0x${winnerBig.toString(16).padStart(40, "0")}`) as Address

    const hash = await walletClient.writeContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "finalizeAuctionItem",
      args: [id, winner, amountBig, r.decryptionProof],
      gas: 12_000_000n,
      account,
      chain: sepolia,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    out.push({ auctionId: id.toString(), action: "finalizeAuctionItem", tx: hash })
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300)
    // Common transient: relayer 404s because indexing is still pending. Mark
    // the result distinctly so the safety-net path doesn't treat it as a hard
    // failure.
    out.push({
      auctionId: id.toString(),
      action: msg.includes("404") || msg.toLowerCase().includes("not found")
        ? "skip-pending-relayer"
        : "finalizeAuctionItem",
      error: msg,
    })
  }
  return out
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const pk = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  const rpcUrl =
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://sepolia.gateway.tenderly.co"

  if (!pk || !pk.startsWith("0x")) {
    return NextResponse.json(
      { ok: false, error: "KEEPER_PRIVATE_KEY missing or malformed" },
      { status: 500 },
    )
  }
  if (!AUCTION_ADDRESS) {
    return NextResponse.json(
      { ok: false, error: "NEXT_PUBLIC_AUCTION_ADDRESS not configured" },
      { status: 500 },
    )
  }

  const account = privateKeyToAccount(pk)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) })

  let zamaInstance: Awaited<ReturnType<typeof import("@zama-fhe/relayer-sdk/node").createInstance>> | null = null
  async function getZama() {
    if (zamaInstance) return zamaInstance
    const { createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/node")
    zamaInstance = await createInstance({ ...SepoliaConfig, network: rpcUrl })
    return zamaInstance
  }

  // Anchor every time check on chainNow, not server clock.
  let chainNow: bigint
  try {
    const block = await publicClient.getBlock({ blockTag: "latest" })
    chainNow = block.timestamp
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `latest block read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  // Per-auction one-shot path: ?auctionId=N.
  const url = new URL(req.url)
  const auctionIdParam = url.searchParams.get("auctionId")
  if (auctionIdParam !== null) {
    let auctionId: bigint
    try {
      auctionId = BigInt(auctionIdParam)
    } catch {
      return NextResponse.json({ ok: false, error: "auctionId must be an integer" }, { status: 400 })
    }
    if (auctionId < 0n) {
      return NextResponse.json({ ok: false, error: "auctionId must be non-negative" }, { status: 400 })
    }
    let nextId: bigint
    try {
      nextId = (await publicClient.readContract({
        address: AUCTION_ADDRESS,
        abi: AUCTION_ABI,
        functionName: "nextAuctionId",
      })) as bigint
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `nextAuctionId read failed: ${(e as Error).message.slice(0, 200)}` },
        { status: 502 },
      )
    }
    if (auctionId >= nextId) {
      return NextResponse.json(
        { ok: false, error: `auction ${auctionId} does not exist (nextAuctionId=${nextId})` },
        { status: 404 },
      )
    }
    const results = await processAuction(
      auctionId,
      publicClient,
      walletClient,
      account,
      getZama,
      chainNow,
    )
    return NextResponse.json({
      ok: true,
      mode: "one-shot",
      results,
      keeper: account.address,
      chainNow: chainNow.toString(),
    })
  }

  // Sweep path: iterate all auctions, one transition per auction per call.
  let auctionCount: bigint
  try {
    auctionCount = (await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "nextAuctionId",
    })) as bigint
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `auctionCount read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  const allResults: ActionResult[] = []
  for (let id = 0n; id < auctionCount; id++) {
    const r = await processAuction(
      id,
      publicClient,
      walletClient,
      account,
      getZama,
      chainNow,
    )
    allResults.push(...r)
    // First non-skip action returns — bound the budget so a slow relayer
    // call on auction K doesn't time-out the whole sweep.
    const acted = r.find((x) => x.action === "endAuction" || x.action === "finalizeAuctionItem")
    if (acted) {
      return NextResponse.json({
        ok: true,
        mode: "sweep",
        results: allResults,
        keeper: account.address,
        count: auctionCount.toString(),
        chainNow: chainNow.toString(),
      })
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "sweep",
    results: allResults,
    keeper: account.address,
    count: auctionCount.toString(),
    chainNow: chainNow.toString(),
  })
}
