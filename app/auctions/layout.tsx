import type { Metadata } from "next"
import { ConnectButtonWrapper } from "@/components/connect-button"
import { ObscuraLogo } from "@/components/obscura-logo"
import { WalletPanel } from "@/components/wallet-panel"

export const metadata: Metadata = {
  title: "Auctions — Obscura · Zama",
  description: "Sealed-bid auctions on Sepolia using Zama FHE.",
}

export default function AuctionsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <main className="relative min-h-screen">
      <div className="grid-bg fixed inset-0 opacity-30" aria-hidden="true" />
      <header className="relative z-20 border-b border-border/30 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center justify-between px-6 md:px-12 py-4 gap-4 flex-wrap">
          <ObscuraLogo />
          <ConnectButtonWrapper />
        </div>
      </header>
      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-[1fr,minmax(280px,360px)] gap-0">
        <div>{children}</div>
        <aside className="border-l border-border/30 p-6 md:p-8 bg-background/40">
          <WalletPanel />
        </aside>
      </div>
    </main>
  )
}
