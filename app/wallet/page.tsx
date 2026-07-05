import type { Metadata } from "next"
import { ConnectButtonWrapper } from "@/components/connect-button"
import { ObscuraLogo } from "@/components/obscura-logo"
import { WalletPanel } from "@/components/wallet-panel"

export const metadata: Metadata = {
  title: "Wallet — Obscura · Zama",
  description: "Mint test USDC, wrap to sealed cUSDC, unwrap back to USDC.",
}

export default function WalletPage() {
  return (
    <main className="relative min-h-screen">
      <div className="grid-bg fixed inset-0 opacity-30" aria-hidden="true" />
      <header className="relative z-20 border-b border-border/30 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center justify-between px-6 md:px-12 py-4 gap-4 flex-wrap">
          <ObscuraLogo />
          <ConnectButtonWrapper />
        </div>
      </header>
      <section className="relative z-10 px-6 md:px-12 py-12 md:py-20">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">wallet</p>
        <h1 className="mt-3 font-[var(--font-bebas)] text-4xl md:text-6xl tracking-tight">
          Mint · Wrap · Unwrap
        </h1>
        <p className="mt-3 max-w-xl font-mono text-sm text-muted-foreground">
          Test USDC lives on {` `}
          <span className="text-foreground">Sepolia</span>. Wrap it into sealed cUSDC to bid;
          unwrap to get your funds back. The encrypted balance is only visible to you.
        </p>
        <div className="mt-10">
          <WalletPanel />
        </div>
      </section>
    </main>
  )
}
