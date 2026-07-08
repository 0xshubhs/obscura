"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi"
import { decodeEventLog, parseEther, formatEther, isAddress, type Address } from "viem"
import { cn } from "@/lib/utils"
import { ensureZamaInit, encryptInputs } from "@/lib/zama"
import {
  AUCTION_ABI,
  AUCTION_ADDRESS,
  SCALE,
} from "@/lib/zama-contracts"

function handleToBytes32(h: bigint): `0x${string}` {
  return `0x${h.toString(16).padStart(64, "0")}` as `0x${string}`
}

const DURATION_PRESETS = [
  { label: "5 min", seconds: 5 * 60 },
  { label: "15 min", seconds: 15 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "6 hours", seconds: 6 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
]

// ITEM = public floor, first-price. SEALED = encrypted hidden reserve, with
// optional Vickrey (second-price) settlement + FHE-random tie-break. TOKEN =
// multi-unit uniform clearing price.
type Mode = "ITEM" | "SEALED" | "TOKEN"

export function CreateAuctionForm() {
  const router = useRouter()
  const { isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [mode, setMode] = useState<Mode>("ITEM")
  const [itemName, setItemName] = useState("")
  const [itemDescription, setItemDescription] = useState("")
  const [floor, setFloor] = useState("")
  const [tokenAddress, setTokenAddress] = useState("")
  const [supply, setSupply] = useState("")
  const [durationSec, setDurationSec] = useState(DURATION_PRESETS[1].seconds)
  const [gasDeposit, setGasDeposit] = useState("0.005")
  const [useVickrey, setUseVickrey] = useState(true)
  const [useTieBreak, setUseTieBreak] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read minimum gas deposit from contract (optional - may not exist on Zama version)
  const { data: minGasDeposit } = useReadContract({
    address: AUCTION_ADDRESS || undefined,
    abi: AUCTION_ABI,
    functionName: "minGasDeposit",
    query: { enabled: !!AUCTION_ADDRESS },
  })

  const minBidRaw = (() => {
    const n = parseFloat(floor)
    if (!Number.isFinite(n) || n < 0) return 0n
    return BigInt(Math.floor(n * Number(SCALE)))
  })()

  const supplyRaw = (() => {
    const n = parseFloat(supply)
    if (!Number.isFinite(n) || n <= 0) return 0n
    return BigInt(Math.floor(n))
  })()

  const gasDepositWei = (() => {
    const n = parseFloat(gasDeposit)
    if (!Number.isFinite(n) || n <= 0) return 0n
    return parseEther(gasDeposit)
  })()

  const minDepositWei = (minGasDeposit as bigint | undefined) ?? 0n
  const depositTooLow = minDepositWei > 0n && gasDepositWei < minDepositWei

  const tokenAddressValid = mode !== "TOKEN" || (tokenAddress.length > 0 && isAddress(tokenAddress))

  const canSubmit =
    isConnected &&
    !!AUCTION_ADDRESS &&
    itemName.trim().length > 0 &&
    durationSec >= 60 &&
    !submitting &&
    !depositTooLow &&
    (mode !== "TOKEN" || (tokenAddressValid && supplyRaw > 0n)) &&
    (mode !== "SEALED" || minBidRaw > 0n)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !publicClient || !walletClient) return
    setError(null)
    setSubmitting(true)
    try {
      let hash: `0x${string}`
      if (mode === "SEALED") {
        // Encrypt the reserve so the floor never appears in cleartext on-chain.
        // The contract enforces it inside FHE; bidders never learn it.
        await ensureZamaInit(publicClient as never, walletClient)
        const enc = await encryptInputs(
          [{ type: "uint64", value: minBidRaw }],
          AUCTION_ADDRESS,
          walletClient.account!.address,
        )
        hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "createSealedAuctionItem",
          args: [
            itemName.trim(),
            itemDescription.trim(),
            0n, // displayHint — reserve is hidden, so show "—"
            handleToBytes32(enc.handles[0]),
            enc.inputProof,
            BigInt(durationSec),
            useVickrey,
            useTieBreak,
          ],
          value: gasDepositWei,
          account: walletClient.account!,
          chain: walletClient.chain,
        })
      } else if (mode === "ITEM") {
        hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "createAuctionItem",
          args: [itemName.trim(), itemDescription.trim(), minBidRaw, BigInt(durationSec)],
          value: gasDepositWei,
          account: walletClient.account!,
          chain: walletClient.chain,
        })
      } else {
        hash = await walletClient.writeContract({
          address: AUCTION_ADDRESS,
          abi: AUCTION_ABI,
          functionName: "createAuctionToken",
          args: [
            itemName.trim(),
            itemDescription.trim(),
            tokenAddress as Address,
            supplyRaw,
            minBidRaw,
            BigInt(durationSec),
          ],
          value: gasDepositWei,
          account: walletClient.account!,
          chain: walletClient.chain,
        })
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("createAuction reverted")
      const evt = receipt.logs
        .map((l) => {
          try {
            return decodeEventLog({ abi: AUCTION_ABI, data: l.data, topics: l.topics })
          } catch {
            return null
          }
        })
        .find((d) =>
          d?.eventName === "AuctionCreatedItem" || d?.eventName === "AuctionCreatedToken",
        )
      const newId = (evt?.args as { auctionId?: bigint } | undefined)?.auctionId

      // Best-effort: register a cron-job.org one-shot at endTime+90s so the
      // keeper fires precisely when this auction expires. The endpoint
      // re-reads the auction from chain, so a malicious or stale client
      // can't influence what gets scheduled. On failure (network blip,
      // cron-job.org down, env not configured) the GH Actions safety net
      // still picks up the auction within 30 min — so we don't block the
      // navigation on this call.
      if (newId !== undefined) {
        fetch("/api/scheduler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auctionId: newId.toString() }),
        }).catch((err) => {
          // Swallow — UX shouldn't see infra errors. GH safety net is the
          // backup. Log to console for the developer.
          // eslint-disable-next-line no-console
          console.warn("auto-schedule failed (safety net will catch up):", err)
        })
      }

      router.push(newId !== undefined ? `/auctions/${newId.toString()}` : "/auctions")
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 200) : "Create failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {!AUCTION_ADDRESS && (
        <div className="border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive">
            Auction contract not configured. Set <code>NEXT_PUBLIC_AUCTION_ADDRESS</code> in .env.local.
          </p>
        </div>
      )}

      {/* Mode toggle */}
      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Auction mode
        </label>
        <div className="inline-flex items-center border border-border/40">
          {(["ITEM", "SEALED", "TOKEN"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "px-5 py-2.5 font-mono text-xs uppercase tracking-widest transition-colors",
                mode === m
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          {mode === "ITEM"
            ? "Single-item: highest bidder wins, pays their full bid. Public floor."
            : mode === "SEALED"
              ? "Single-item with an ENCRYPTED reserve bidders never see. Optional second-price (Vickrey) settlement + FHE-random tie-break."
              : "Multi-unit token: uniform clearing price, supply allocated descending by bid."}
        </p>
      </div>

      {mode === "SEALED" && (
        <div className="border border-purple-500/30 bg-purple-500/5 p-5 space-y-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-purple-400">
            Sealed-auction options
          </p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useVickrey}
              onChange={(e) => setUseVickrey(e.target.checked)}
              className="mt-0.5 accent-purple-500"
            />
            <span className="font-mono text-[11px] text-foreground/90">
              Vickrey (second-price)
              <span className="block text-[10px] text-muted-foreground/70 mt-0.5">
                Winner pays the runner-up&apos;s bid, not their own. Only the second price is
                ever decrypted; the overbid is refunded in encrypted cUSDC.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useTieBreak}
              onChange={(e) => setUseTieBreak(e.target.checked)}
              className="mt-0.5 accent-purple-500"
            />
            <span className="font-mono text-[11px] text-foreground/90">
              FHE-random tie-break
              <span className="block text-[10px] text-muted-foreground/70 mt-0.5">
                Equal top bids are broken by an on-chain <code>FHE.randEuint32</code> score
                instead of first-come-wins (anti-MEV). Live-network only.
              </span>
            </span>
          </label>
        </div>
      )}

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Item name
        </label>
        <input
          type="text"
          required
          maxLength={80}
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          placeholder={mode === "ITEM" ? "Vintage Lot #42" : "Acme Token Sale"}
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60"
        />
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Description
        </label>
        <textarea
          rows={3}
          maxLength={500}
          value={itemDescription}
          onChange={(e) => setItemDescription(e.target.value)}
          placeholder="What are bidders competing for?"
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60 resize-none"
        />
      </div>

      {mode === "TOKEN" && (
        <>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
              Token address (ERC-20)
            </label>
            <input
              type="text"
              required
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value.trim())}
              placeholder="0x…"
              className={cn(
                "w-full bg-background border px-4 py-3 font-mono text-sm focus:outline-none",
                tokenAddress.length === 0
                  ? "border-border/40 focus:border-accent/60"
                  : tokenAddressValid
                    ? "border-accent/40 focus:border-accent/60"
                    : "border-destructive/60",
              )}
            />
            <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
              Approve the auction contract to pull <code>supply</code> tokens at create time.
            </p>
          </div>

          <div>
            <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
              Supply (units)
            </label>
            <input
              type="text"
              inputMode="numeric"
              required
              value={supply}
              onChange={(e) => setSupply(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1000"
              className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60"
            />
          </div>
        </>
      )}

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          {mode === "ITEM"
            ? "Floor (USDC, informational)"
            : mode === "SEALED"
              ? "Secret reserve (USDC, hidden)"
              : "Minimum price per unit (USDC)"}
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={floor}
          onChange={(e) => setFloor(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="100"
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60"
        />
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          {mode === "SEALED"
            ? "Encrypted in your browser before it touches the chain. Bids at or below it are zeroed inside FHE and can never win — the reserve itself is never revealed."
            : "Shown on the auction page for bidders — enforced on-chain via FHE."}
        </p>
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Duration
        </label>
        <div className="flex flex-wrap gap-2">
          {DURATION_PRESETS.map((p) => (
            <button
              key={p.seconds}
              type="button"
              onClick={() => setDurationSec(p.seconds)}
              className={cn(
                "px-4 py-2.5 font-mono text-xs uppercase tracking-widest border transition-colors",
                durationSec === p.seconds
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border/40 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-[0.3em] text-accent mb-3">
          Gas deposit (ETH)
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={gasDeposit}
          onChange={(e) => setGasDeposit(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.005"
          className="w-full bg-background border border-border/40 px-4 py-3 font-mono text-sm focus:outline-none focus:border-accent/60"
        />
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          Covers gas for settlement after auction ends.
          {minDepositWei > 0n && ` Min: ${formatEther(minDepositWei)} ETH.`}
          {" "}Unused portion is refunded.
        </p>
        {depositTooLow && gasDepositWei > 0n && (
          <p className="mt-1 font-mono text-[10px] text-destructive">
            Below minimum deposit of {formatEther(minDepositWei)} ETH.
          </p>
        )}
      </div>

      {error && (
        <div className="border border-destructive/50 bg-destructive/10 p-4">
          <p className="font-mono text-xs text-destructive break-all">{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className={cn(
          "w-full py-4 font-mono text-xs uppercase tracking-[0.3em] border transition-all",
          canSubmit
            ? "border-accent text-accent hover:bg-accent hover:text-accent-foreground"
            : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
        )}
      >
        {!isConnected ? "Connect wallet" : submitting ? "Creating…" : "+ Create auction"}
      </button>
    </form>
  )
}
