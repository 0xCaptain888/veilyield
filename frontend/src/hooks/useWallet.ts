import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, Eip1193Provider, JsonRpcSigner } from "ethers";
import { ROUTER_ABI, CTOKEN_ABI, ERC20_ABI } from "../abi";
import addresses from "../lib/addresses.json";

const SEPOLIA_CHAIN_ID = 11155111;

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on?: (event: string, handler: (...args: any[]) => void) => void;
      removeListener?: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
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
    if (!window.ethereum) return;
    try {
      const provider = new BrowserProvider(window.ethereum);
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
        eip1193: window.ethereum!,
        signer,
        error: null,
      }));
    } catch (e: any) {
      setState((s) => ({ ...s, error: e?.message ?? "wallet error" }));
    }
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setState((s) => ({ ...s, error: "No injected wallet found. Install MetaMask." }));
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const provider = new BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== SEPOLIA_CHAIN_ID) {
        try {
          await window.ethereum.request?.({
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
    const eth = window.ethereum;
    if (eth?.on) {
      const onAccounts = () => refresh();
      const onChain = () => window.location.reload();
      eth.on("accountsChanged", onAccounts);
      eth.on("chainChanged", onChain);
      return () => {
        eth.removeListener?.("accountsChanged", onAccounts);
        eth.removeListener?.("chainChanged", onChain);
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
