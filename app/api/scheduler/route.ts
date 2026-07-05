/**
 * Scheduler endpoint — POST /api/scheduler
 *
 * Body: { auctionId: number | string }
 *
 * Called by the create-auction flow after `createAuction` is mined. The
 * endpoint:
 *   1. Re-reads the auction from the chain (NEVER trusts a client-supplied
 *      endTime — only the chain knows the real value).
 *   2. Validates: auction exists, not already ended/finalized, endTime is in
 *      the future relative to the latest block's timestamp.
 *   3. Registers a cron-job.org one-shot at endTime + 90s.
 *
 * Why we re-read on the server:
 *   - A malicious client could POST `{ auctionId: 0, endTime: 0 }` to try to
 *     trigger an immediate keeper run on a long-lived auction. We ignore any
 *     client-supplied timing entirely.
 *   - The frontend's clock can drift; cron-job.org's clock can drift. The
 *     chain's `block.timestamp` is the only authoritative reference for "has
 *     this auction expired." We reuse the same source on both ends.
 */

import { NextResponse } from "next/server"
import { createPublicClient, http } from "viem"
import { sepolia } from "viem/chains"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  parseAuctionTuple,
} from "@/lib/zama-contracts"
import { scheduleAuctionFinalize } from "@/lib/scheduler"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Resolve the public URL where cron-job.org should ping. Order of preference:
//   1. KEEPER_URL (explicit, e.g. https://obscura-zama.vercel.app)
//   2. VERCEL_PROJECT_PRODUCTION_URL (Vercel auto-injects)
//   3. host header (works for previews and local dev)
function resolveBaseUrl(req: Request): string | null {
  const explicit = process.env.KEEPER_URL
  if (explicit) return explicit
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (vercel) return `https://${vercel}`
  const host = req.headers.get("host")
  if (host) {
    // localhost stays http; everything else https.
    const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"
    return `${proto}://${host}`
  }
  return null
}

export async function POST(req: Request) {
  let body: { auctionId?: number | string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 })
  }

  if (body.auctionId === undefined || body.auctionId === null) {
    return NextResponse.json({ ok: false, error: "auctionId required" }, { status: 400 })
  }

  let auctionId: bigint
  try {
    auctionId = BigInt(body.auctionId)
  } catch {
    return NextResponse.json({ ok: false, error: "auctionId must be an integer" }, { status: 400 })
  }
  if (auctionId < 0n) {
    return NextResponse.json({ ok: false, error: "auctionId must be non-negative" }, { status: 400 })
  }

  const apiKey = process.env.CRONJOBORGAPIKEY
  const cronSecret = process.env.CRON_SECRET
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "CRONJOBORGAPIKEY not configured" }, { status: 500 })
  }
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 })
  }
  if (!AUCTION_ADDRESS) {
    return NextResponse.json({ ok: false, error: "NEXT_PUBLIC_AUCTION_ADDRESS not configured" }, { status: 500 })
  }
  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "could not resolve base url" }, { status: 500 })
  }

  const rpcUrl =
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://sepolia.gateway.tenderly.co"
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })

  // Bound auctionId by nextAuctionId so we don't schedule jobs for nonexistent
  // future ids. This is the chain's own monotonic counter, not user input.
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

  // Read the on-chain auction state. endTime here is the canonical value —
  // any number the client passed is ignored.
  let auction
  try {
    const tuple = await publicClient.readContract({
      address: AUCTION_ADDRESS,
      abi: AUCTION_ABI,
      functionName: "getAuction",
      args: [auctionId],
    })
    auction = parseAuctionTuple(tuple, auctionId)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `getAuction read failed: ${(e as Error).message.slice(0, 200)}` },
      { status: 502 },
    )
  }

  if (auction.finalized) {
    return NextResponse.json({ ok: false, error: "auction already finalized" }, { status: 409 })
  }
  if (auction.ended) {
    return NextResponse.json({ ok: false, error: "auction already ended (only finalize remaining — GH safety net will pick it up)" }, { status: 409 })
  }

  // Compare endTime against the chain's own clock, not the server's. Validators
  // produce blocks with timestamps that can drift from wall-clock by ~12s
  // either side; cron-job.org has its own clock. The chain is the only
  // reference both sides agree on, so we use it.
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

  if (auction.endTime <= chainNow) {
    return NextResponse.json(
      { ok: false, error: `auction already past endTime (chainNow=${chainNow}, endTime=${auction.endTime}) — finalize via cron` },
      { status: 409 },
    )
  }

  // All checks passed. Register a one-shot at endTime + 90s.
  try {
    const result = await scheduleAuctionFinalize({
      auctionId,
      endTimeUnix: auction.endTime,
      baseUrl,
      cronSecret,
      apiKey,
    })
    return NextResponse.json({
      ok: true,
      auctionId: auctionId.toString(),
      endTime: auction.endTime.toString(),
      chainNow: chainNow.toString(),
      ...result,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `scheduling failed: ${(e as Error).message.slice(0, 240)}` },
      { status: 502 },
    )
  }
}
