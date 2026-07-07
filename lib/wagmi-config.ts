import { getDefaultConfig } from "@rainbow-me/rainbowkit"
import { sepolia } from "viem/chains"
import { http } from "wagmi"

// publicnode is a live, key-less Sepolia endpoint. (The old blastapi public URL
// was retired — a dead fallback made the ConnectButton balance fail to load.)
const RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"

export const wagmiConfig = getDefaultConfig({
  appName: "Obscura",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "a73ceeb8d8079b8c1dc4d9d5ebbc0433",
  chains: [sepolia],
  transports: { [sepolia.id]: http(RPC) },
  ssr: true,
})
