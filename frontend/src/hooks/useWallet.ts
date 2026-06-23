import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, Eip1193Provider, JsonRpcSigner } from "ethers";
import { ROUTER_ABI, CTOKEN_ABI, ERC20_ABI } from "../abi";
import addresses from "../lib/addresses.json";

const SEPOLIA_CHAIN_ID = 11155111;

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      isMetaMask?: boolean;
      on?: (event: string, handler: (...args: any[]) => void) => void;
      removeListener?: (event: string, handler: (...args: any[]) => void) => void;
    };
    okxwallet?: Eip1193Provider & {
      on?: (event: string, handler: (...args: any[]) => void) => void;
      removeListener?: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}

/**
 * Get the supported wallet provider (OKX first, then MetaMask).
 * Returns null if no supported wallet is found.
 */
export function getSupportedWallet(): { provider: Eip1193Provider; name: string } | null {
  // OKX Wallet takes priority
  if (window.okxwallet) {
    return { provider: window.okxwallet, name: "OKX Wallet" };
  }
  // MetaMask as fallback
  if (window.ethereum && window.ethereum.isMetaMask) {
    return { provider: window.ethereum, name: "MetaMask" };
  }
  return null;
}

export interface WalletState {
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  eip1193: (Window["ethereum"]) | null;
  signer: JsonRpcSigner | null;
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    chainId: null,
    connecting: false,
    error: null,
    eip1193: null,
    signer: null,
  });

  const refresh = useCallback(async () => {
    const wallet = getSupportedWallet();
    if (!wallet) return;
    try {
      const provider = new BrowserProvider(wallet.provider);
      const net = await provider.getNetwork();
      const accounts = await provider.send("eth_accounts", []);
      if (accounts.length === 0) {
        setState((s) => ({ ...s, address: null, signer: null, chainId: Number(net.chainId) }));
        return;
      }
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();
      setState((s) => ({
        ...s,
        address: addr,
        chainId: Number(net.chainId),
        eip1193: wallet.provider,
        signer,
        error: null,
      }));
    } catch (e: any) {
      setState((s) => ({ ...s, error: e?.message ?? "wallet error" }));
    }
  }, []);

  const connect = useCallback(async (walletType?: "okx" | "metamask") => {
    let wallet: { provider: Eip1193Provider; name: string } | null = null;

    if (walletType === "okx") {
      if (!window.okxwallet) {
        setState((s) => ({ ...s, error: "OKX Wallet not found. Please install it from okx.com/web3." }));
        return;
      }
      wallet = { provider: window.okxwallet, name: "OKX Wallet" };
    } else if (walletType === "metamask") {
      if (!window.ethereum?.isMetaMask) {
        setState((s) => ({ ...s, error: "MetaMask not found. Please install it from metamask.io." }));
        return;
      }
      wallet = { provider: window.ethereum, name: "MetaMask" };
    } else {
      wallet = getSupportedWallet();
    }

    if (!wallet) {
      setState((s) => ({ ...s, error: "No supported wallet found. Please install OKX Wallet or MetaMask." }));
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const provider = new BrowserProvider(wallet.provider);
      await provider.send("eth_requestAccounts", []);
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== SEPOLIA_CHAIN_ID) {
        try {
          await wallet.provider.request?.({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0xaa36a7" }],
          });
        } catch {
          /* user may decline; surfaced below via chainId banner */
        }
      }
      await refresh();
    } catch (e: any) {
      setState((s) => ({ ...s, error: e?.message ?? "connect failed" }));
    } finally {
      setState((s) => ({ ...s, connecting: false }));
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    // Listen to the active wallet provider
    const activeWallet = window.okxwallet || (window.ethereum?.isMetaMask ? window.ethereum : null);
    if (activeWallet?.on) {
      const onAccounts = () => refresh();
      const onChain = () => window.location.reload();
      activeWallet.on("accountsChanged", onAccounts);
      activeWallet.on("chainChanged", onChain);
      return () => {
        activeWallet.removeListener?.("accountsChanged", onAccounts);
        activeWallet.removeListener?.("chainChanged", onChain);
      };
    }
  }, [refresh]);

  const wrongNetwork = state.chainId != null && state.chainId !== SEPOLIA_CHAIN_ID;

  return { ...state, connect, refresh, wrongNetwork };
}

export function getContracts(signer: JsonRpcSigner) {
  return {
    router: new Contract(addresses.router, ROUTER_ABI, signer),
    cUSDC: new Contract(addresses.cUSDC, CTOKEN_ABI, signer),
    usdc: new Contract(addresses.USDC, ERC20_ABI, signer),
    shareTokens: addresses.vaults.map(
      (v) => new Contract(v.shareToken, CTOKEN_ABI, signer),
    ),
  };
}

export { addresses };
