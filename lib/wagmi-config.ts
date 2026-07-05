import { getDefaultConfig } from "@rainbow-me/rainbowkit"
import { sepolia } from "viem/chains"
import { http } from "wagmi"

const RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://eth-sepolia.public.blastapi.io"

export const wagmiConfig = getDefaultConfig({
  appName: "Obscura",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "a73ceeb8d8079b8c1dc4d9d5ebbc0433",
  chains: [sepolia],
  transports: { [sepolia.id]: http(RPC) },
  ssr: true,
})
