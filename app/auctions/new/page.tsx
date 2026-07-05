import Link from "next/link"
import type { Metadata } from "next"
import { CreateAuctionForm } from "./create-auction-form"

export const metadata: Metadata = {
  title: "Create auction — Obscura",
  description: "Create a new sealed-bid CCA auction.",
}

export default function NewAuctionPage() {
  return (
    <div className="px-6 md:px-12 py-12 md:py-20 min-h-[calc(100vh-theme(spacing.20))] flex flex-col">
      <Link
        href="/auctions"
        className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-accent transition-colors shrink-0"
      >
        ← All auctions
      </Link>

      <div className="mt-8 md:mt-12 text-center shrink-0">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">
          Create
        </span>
        <h1 className="mt-4 font-[var(--font-bebas)] text-4xl md:text-6xl tracking-tight">
          NEW AUCTION
        </h1>
        <p className="mt-4 max-w-lg mx-auto font-mono text-sm text-muted-foreground leading-relaxed">
          Set name, description, reserve price, and duration. The auction will run as a sealed-bid CCA.
        </p>
      </div>

      <div className="flex-1 flex items-start justify-center mt-12 md:mt-16 pb-12">
        <div className="w-full max-w-xl border border-border/40 bg-card/30 p-6 md:p-8">
          <CreateAuctionForm />
        </div>
      </div>
    </div>
  )
}
