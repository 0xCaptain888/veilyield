import { BrowserProvider, Eip1193Provider } from "ethers";
import { createInstance, SepoliaConfig, type FhevmInstance } from "@zama-fhe/relayer-sdk/web";

/**
 * Thin wrapper around the Zama Relayer SDK for the browser.
 *
 * Responsibilities:
 *  - lazily build a single FhevmInstance bound to Sepolia
 *  - encrypt a uint64 amount for a (contract, user) pair, returning the handle + input proof
 *  - user-decrypt an encrypted handle the connected wallet is authorized to read (EIP-712 flow)
 *
 * All FHE crypto runs client-side; the relayer never sees plaintext.
 */

let instancePromise: Promise<FhevmInstance> | null = null;

export async function getFhevm(): Promise<FhevmInstance> {
  if (!instancePromise) {
    instancePromise = createInstance({
      ...SepoliaConfig,
      // Allow overriding the host-chain RPC the SDK uses (optional).
      network: import.meta.env.VITE_SEPOLIA_RPC_URL || (SepoliaConfig as any).network,
    });
  }
  return instancePromise;
}

/** Encrypt a single uint64 value for the given contract + user. */
export async function encryptAmount(
  contractAddress: string,
  userAddress: string,
  amount: bigint,
): Promise<{ handle: string; inputProof: string }> {
  const fhevm = await getFhevm();
  const input = fhevm.createEncryptedInput(contractAddress, userAddress);
  input.add64(amount);
  const enc = await input.encrypt();
  // handles are Uint8Array; ethers accepts them, but we normalize to hex for safety.
  const handle = toHex(enc.handles[0]);
  const inputProof = toHex(enc.inputProof);
  return { handle, inputProof };
}

/**
 * User-decrypt one encrypted handle the wallet is allowed to read.
 * Returns the cleartext bigint, or 0n for an uninitialized handle.
 */
export async function userDecrypt(
  eip1193: Eip1193Provider,
  contractAddress: string,
  handle: string,
): Promise<bigint> {
  if (!handle || /^0x0{64}$/.test(handle)) return 0n;

  const fhevm = await getFhevm();
  const provider = new BrowserProvider(eip1193);
  const signer = await provider.getSigner();
  const userAddress = await signer.getAddress();

  const keypair = fhevm.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000).toString();
  const durationDays = "7";
  const contracts = [contractAddress];

  const eip712 = fhevm.createEIP712(keypair.publicKey, contracts, startTimestamp, durationDays);

  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    eip712.message,
  );

  const results = await fhevm.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature.replace(/^0x/, ""),
    contracts,
    userAddress,
    startTimestamp,
    durationDays,
  );

  const value = results[handle];
  return typeof value === "bigint" ? value : BigInt(value ?? 0);
}

function toHex(data: Uint8Array | string): string {
  if (typeof data === "string") return data.startsWith("0x") ? data : "0x" + data;
  return "0x" + Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join("");
}
