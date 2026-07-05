"use client"

/**
 * @zama-fhe/relayer-sdk loader + FhevmInstance singleton.
 *
 * The SDK ships a TFHE / TKMS WASM payload (~10 MB) and pulls KMS public params
 * from Zama's gateway, so we lazy-load the bundle entry the first time any
 * page actually needs encryption. Pages that only render plaintext data stay
 * lean.
 *
 * Export surface mirrors the FHENIX `lib/cofhe.ts` so the rest of the app
 * can swap providers with a single import-path change.
 */

import type { PublicClient, WalletClient } from "viem"

// --- Lazy SDK module + instance singletons -----------------------------------

// `/web` is the proper ESM entry (lib/web.js) that bundles initSDK +
// createInstance + SepoliaConfig as real exports. The `/bundle` entry is a
// thin shim over `window.relayerSDK` and only works after a UMD <script> tag
// has populated that global; importing it as ESM yields undefined.
//
// We cannot statically import: the module contains top-level WASM
// instantiation that breaks SSR. Cache the dynamic import so subsequent calls
// don't re-evaluate the module.
type ZamaBundle = typeof import("@zama-fhe/relayer-sdk/web")
let bundlePromise: Promise<ZamaBundle> | null = null

async function loadBundle(): Promise<ZamaBundle> {
  if (!bundlePromise) {
    bundlePromise = import("@zama-fhe/relayer-sdk/web")
  }
  return bundlePromise
}

// FhevmInstance is heavy (downloads CRS + KMS public key) — keep one per tab.
type FhevmInstance = Awaited<
  ReturnType<ZamaBundle["createInstance"]>
>

let instancePromise: Promise<FhevmInstance> | null = null
let initSDKPromise: Promise<void> | null = null
let connectedFor: string | null = null

/**
 * Idempotent low-level initialiser: loads WASM, creates the FhevmInstance
 * once per tab. Safe to await from anywhere; concurrent callers share the
 * same in-flight promise.
 */
async function getOrCreateInstance(): Promise<FhevmInstance> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const sdk = await loadBundle()

      // initSDK fetches & instantiates the TFHE + TKMS WASM modules. It must
      // resolve before createInstance() touches any cryptographic primitive.
      // It returns a boolean (true once both modules are ready) — we discard.
      if (!initSDKPromise) {
        initSDKPromise = sdk.initSDK().then(() => undefined)
      }
      await initSDKPromise

      // SepoliaConfig carries every contract address the SDK needs (ACL, KMS,
      // input verifier, decryption oracle, gateway chain id, relayer URL).
      // `network` is the read-only RPC the SDK uses for `eth_call` against
      // the host chain (chainId 11155111).
      //
      // Always use a Sepolia RPC URL — never `window.ethereum`. The injected
      // wallet may be on a different chain (e.g. Base Sepolia from a prior
      // session); reading state through it would return `0x` for every
      // Zama-host call and produce a misleading "could not decode result data
      // (eip712Domain)" error. Wallet signing for tx broadcast is unaffected
      // — that's done separately via wagmi's WalletClient.
      const network =
        process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ||
        "https://sepolia.gateway.tenderly.co"

      return sdk.createInstance({
        ...sdk.SepoliaConfig,
        network,
      })
    })()
  }
  return instancePromise
}

/**
 * Initialise the FhevmInstance for the connected wallet. Currently a no-op
 * beyond `getOrCreateInstance()` because the SDK doesn't keep wallet-bound
 * state — kept for parity with `ensureCofheInit()` so callers don't change.
 */
export async function ensureZamaInit(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<void> {
  void publicClient // unused but kept for API parity with the FHENIX wrapper
  const address = walletClient.account?.address
  if (!address) throw new Error("wallet not connected")
  if (connectedFor === address) return

  await getOrCreateInstance()
  connectedFor = address
}

/** Singleton accessor for callers that need raw SDK methods (e.g. EIP-712). */
export async function getInstance(): Promise<FhevmInstance> {
  return getOrCreateInstance()
}

// --- Encryption --------------------------------------------------------------

/**
 * Item descriptor for `encryptInputs`. Mirrors the slim shape used by the
 * FHENIX wrapper (`Encryptable.uint64(...)` / `Encryptable.address(...)`)
 * but using primitive type tags so callers don't have to load the SDK
 * just to construct an input list.
 */
export type EncryptableItem =
  | { type: "uint64"; value: bigint | number }
  | { type: "address"; value: string }

/**
 * Encrypt a list of plaintext inputs for the given contract+user pair and
 * return the on-chain handles + ZK input proof. The return value is shaped
 * for direct use as `(handles, inputProof)` arguments on contracts that
 * follow the OpenZeppelin Confidential Contracts convention (see e.g.
 * ConfidentialUSDC.approve / requestUnwrap / etc.).
 *
 * NOTE: handles come back as `Uint8Array[]` from the SDK. We hex-stringify
 * them via `BigInt`-decoding to keep parity with the FHENIX surface, which
 * exposes ctHash as `bigint`. That makes them compatible with viem's
 * `bytes32`/`uint256` ABI types.
 */
export async function encryptInputs(
  items: EncryptableItem[],
  contractAddress: string,
  userAddress: string,
): Promise<{ handles: bigint[]; inputProof: `0x${string}` }> {
  if (items.length === 0) throw new Error("encryptInputs: empty input list")
  const instance = await getOrCreateInstance()

  const builder = instance.createEncryptedInput(contractAddress, userAddress)
  for (const item of items) {
    if (item.type === "uint64") {
      builder.add64(BigInt(item.value))
    } else if (item.type === "address") {
      builder.addAddress(item.value)
    } else {
      // exhaustiveness guard
      const _never: never = item
      throw new Error(`encryptInputs: unsupported item ${JSON.stringify(_never)}`)
    }
  }

  const result = await builder.encrypt()
  return {
    handles: result.handles.map((h) => bytesToBigInt(h)),
    inputProof: bytesToHex(result.inputProof),
  }
}

// --- Decryption --------------------------------------------------------------

/**
 * EIP-712 user decrypt — prompts the wallet to sign a permission token, then
 * asks the relayer to return the plaintext for a single ciphertext handle.
 *
 * Matches the shape `decryptForView(ctHash, fheType)` had in the FHENIX
 * wrapper: caller hands us a handle + the contract that owns it and gets
 * back a plaintext bigint. Internally this is a multi-step EIP-712 flow:
 *   1. generate an ephemeral keypair
 *   2. build the EIP-712 typed data via `instance.createEIP712`
 *   3. sign it with the connected wallet
 *   4. forward the signature + keypair to `instance.userDecrypt`
 */
export async function userDecrypt(
  ctHash: bigint | string,
  contractAddress: string,
  userAddress: string,
  walletClient: WalletClient,
): Promise<bigint> {
  const instance = await getOrCreateInstance()

  if (!userAddress) throw new Error("userDecrypt: missing userAddress")
  if (!walletClient.account) throw new Error("userDecrypt: walletClient has no account")

  // 1. Ephemeral keypair — used by the KMS to encrypt the response so only
  //    this client can read the plaintext.
  const { publicKey, privateKey } = instance.generateKeypair()

  // 2. Build EIP-712 typed data binding the keypair to (contract, user) for
  //    a fixed window. (v0.4.2 doesn't take an extraData arg; the KMS context
  //    is resolved server-side.)
  const startTimestamp = Math.floor(Date.now() / 1000)
  const durationDays = 1

  const eip712 = instance.createEIP712(
    publicKey,
    [contractAddress],
    startTimestamp,
    durationDays,
  )

  // 3. Sign via wagmi's WalletClient (works with RainbowKit, WalletConnect,
  //    MetaMask, etc. — not just window.ethereum). createEIP712 returns
  //    {domain, types, primaryType, message}; viem's signTypedData wants the
  //    same shape. We must drop EIP712Domain from `types` because viem
  //    derives it from `domain` itself and rejects duplicates.
  const typesWithoutDomain = { ...eip712.types } as Record<string, unknown>
  delete typesWithoutDomain.EIP712Domain

  // viem's WalletClient.signTypedData has an intricate generic that resolves
  // to `never` for the parameter type when the client wasn't typed with a
  // specific transport — cast to the call signature so we can invoke it.
  const signTypedData = (
    walletClient as unknown as {
      signTypedData: (args: {
        account: WalletClient["account"]
        domain: unknown
        types: unknown
        primaryType: string
        message: unknown
      }) => Promise<`0x${string}`>
    }
  ).signTypedData

  const signature = await signTypedData({
    account: walletClient.account,
    domain: eip712.domain,
    types: typesWithoutDomain,
    primaryType: eip712.primaryType,
    message: eip712.message,
  })

  // 4. Strip the 0x prefix from the signature — the SDK expects raw hex.
  const sigNoPrefix = signature.startsWith("0x") ? signature.slice(2) : signature

  // 6. Ask the relayer for the plaintext. UserDecryptResults is a record
  //    keyed by 0x-prefixed handle hex, valued by a `bigint | boolean | hex`
  //    union — we coerce to bigint for the auction use-case (uint64 amounts).
  const handleHex = toHexHandle(ctHash)
  const result = await instance.userDecrypt(
    [{ handle: handleHex, contractAddress }],
    privateKey,
    publicKey,
    sigNoPrefix,
    [contractAddress],
    userAddress,
    startTimestamp,
    durationDays,
  )

  const clear = (result as Record<`0x${string}`, bigint | boolean | `0x${string}`>)[
    handleHex
  ]
  if (clear === undefined) {
    throw new Error("userDecrypt: relayer returned no plaintext for handle")
  }
  return coerceToBigInt(clear)
}

/**
 * Public decrypt — for ciphertexts whose handles are marked `publicly
 * decryptable` on the ACL. No wallet signature, returns plaintext bigints
 * in the same order as the input handles. Mutates `lastPublicDecryptProof`
 * with the KMS signature bundle so callers that need it for an on-chain
 * `checkSignatures` can read it back without changing the return shape.
 */
let lastPublicDecryptProof: `0x${string}` = "0x"

export function getLastPublicDecryptProof(): `0x${string}` {
  return lastPublicDecryptProof
}

export async function publicDecrypt(
  ctHashes: Array<bigint | string>,
): Promise<bigint[]> {
  if (ctHashes.length === 0) return []
  const instance = await getOrCreateInstance()
  const handles = ctHashes.map(toHexHandle)

  // PublicDecryptResults = { clearValues, abiEncodedClearValues, decryptionProof }.
  // We stash the proof on a module-level variable so callers can fetch it via
  // `getLastPublicDecryptProof()` for use with `FHE.checkSignatures` on-chain.
  const result = await instance.publicDecrypt(handles)
  lastPublicDecryptProof = result.decryptionProof
  // Expose the proof for legacy callers that read `(publicDecrypt as any).lastProof`.
  ;(publicDecrypt as unknown as { lastProof?: `0x${string}` }).lastProof =
    result.decryptionProof
  const clearValues = result.clearValues as Record<
    `0x${string}`,
    bigint | boolean | `0x${string}`
  >
  return handles.map((h) => {
    const v = clearValues[h]
    if (v === undefined) {
      throw new Error(`publicDecrypt: no plaintext for handle ${h}`)
    }
    return coerceToBigInt(v)
  })
}

// --- Hex helpers -------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "0x"
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0")
  }
  return s as `0x${string}`
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  // Big-endian — matches the on-chain `bytes32` -> `uint256` cast convention.
  let result = 0n
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i])
  }
  return result
}

function toHexHandle(h: bigint | string): `0x${string}` {
  if (typeof h === "string") {
    return (h.startsWith("0x") ? h : `0x${h}`) as `0x${string}`
  }
  // bigint -> 32-byte hex string
  return `0x${h.toString(16).padStart(64, "0")}` as `0x${string}`
}

/**
 * The KMS may hand back booleans (eboolDecrypt), bigints (e[u]intN decrypt),
 * or `0x...` hex (eaddress / encrypted bytes). We coerce everything to bigint
 * because the Obscura surface only deals in uint64 amounts + addresses.
 * Hex values are interpreted as big-endian unsigned integers; booleans become
 * 0n / 1n.
 */
function coerceToBigInt(v: bigint | boolean | string | number): bigint {
  if (typeof v === "bigint") return v
  if (typeof v === "boolean") return v ? 1n : 0n
  if (typeof v === "number") return BigInt(v)
  // string: assume 0x-prefixed hex
  return BigInt(v)
}
