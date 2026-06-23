import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useWallet, getContracts, addresses } from "./hooks/useWallet";
import { encryptAmount, userDecrypt } from "./lib/fhe";
import { CipherBalance } from "./components/CipherBalance";

type LogLine = { ts: string; msg: string; kind?: "ok" | "err" };
const STATUS = ["Open", "Dispatched", "Settled", "Cancelled"] as const;
const ONE = 1_000_000n;

function fmt(n: bigint): string {
  return (Number(n) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function apyFromRate(rateBps: number): string {
  // Purely illustrative: map the demo exchange-rate premium to a display APY.
  return ((rateBps - 10000) / 100 + 4).toFixed(2) + "%";
}

export default function App() {
  const w = useWallet();
  const [amount, setAmount] = useState("40");
  const [selectedVault, setSelectedVault] = useState(1);
  const [migrateTo, setMigrateTo] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [anon, setAnon] = useState<Record<number, number>>({});
  const [openBatch, setOpenBatch] = useState<Record<number, bigint>>({});
  const [batchInfo, setBatchInfo] = useState<any | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const deployed = addresses.router !== "0x0000000000000000000000000000000000000000";

  const push = useCallback((msg: string, kind?: "ok" | "err") => {
    const ts = new Date().toLocaleTimeString();
    setLog((l) => [{ ts, msg, kind }, ...l].slice(0, 40));
  }, []);

  // Poll public on-chain state (anonymity set + open batch per vault).
  useEffect(() => {
    if (!w.signer || !deployed) return;
    let cancelled = false;
    (async () => {
      try {
        const { router } = getContracts(w.signer!);
        const a: Record<number, number> = {};
        const ob: Record<number, bigint> = {};
        for (const v of addresses.vaults) {
          a[v.id] = Number(await router.currentAnonymitySet(v.id));
          ob[v.id] = await router.openBatchOf(v.id);
        }
        if (!cancelled) {
          setAnon(a);
          setOpenBatch(ob);
        }
      } catch {
        /* ignore transient read errors */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [w.signer, deployed, refreshTick]);

  const bump = () => setRefreshTick((t) => t + 1);

  // ---- actions ----

  const faucet = useCallback(async () => {
    if (!w.signer) return;
    setBusy("faucet");
    try {
      const { usdc, cUSDC } = getContracts(w.signer);
      const amt = 100n * ONE;
      push("Minting 100 mock USDC…");
      await (await usdc.mint(w.address, amt)).wait();
      push("Approving cUSDC wrapper…");
      await (await usdc.approve(addresses.cUSDC, amt)).wait();
      push("Wrapping into confidential cUSDC…");
      await (await cUSDC.wrap(w.address, amt)).wait();
      push("Funded with 100 cUSDC.", "ok");
      bump();
    } catch (e: any) {
      push(e?.shortMessage ?? e?.message ?? "faucet failed", "err");
    } finally {
      setBusy(null);
    }
  }, [w.signer, w.address, push]);

  const doJoin = useCallback(async () => {
    if (!w.signer) return;
    setBusy("join");
    try {
      const { router, cUSDC } = getContracts(w.signer);
      const amt = BigInt(Math.floor(Number(amount) * 1e6));
      const until = Math.floor(Date.now() / 1000) + 3600;
      push("Authorizing router as operator on cUSDC…");
      await (await cUSDC.setOperator(addresses.router, until)).wait();
      push(`Encrypting ${amount} cUSDC locally…`);
      const { handle, inputProof } = await encryptAmount(addresses.router, w.address!, amt);
      push(`Joining ${addresses.vaults[selectedVault - 1].name} batch (amount stays encrypted)…`);
      await (await router.join(selectedVault, handle, inputProof)).wait();
      push("Joined. Your individual amount was never revealed on-chain.", "ok");
      bump();
    } catch (e: any) {
      push(e?.shortMessage ?? e?.message ?? "join failed", "err");
    } finally {
      setBusy(null);
    }
  }, [w.signer, w.address, amount, selectedVault, push]);

  const doDispatch = useCallback(async () => {
    if (!w.signer) return;
    setBusy("dispatch");
    try {
      const { router } = getContracts(w.signer);
      const batchId = openBatch[selectedVault];
      if (!batchId || batchId === 0n) {
        push("No open batch to dispatch for this vault.", "err");
        return;
      }
      push(`Dispatching batch #${batchId} — only the pool total will be decrypted…`);
      await (await router.dispatchBatch(batchId)).wait();
      push("Dispatched. The decryption oracle settles it shortly (seconds).", "ok");
      bump();
    } catch (e: any) {
      push(e?.shortMessage ?? e?.message ?? "dispatch failed", "err");
    } finally {
      setBusy(null);
    }
  }, [w.signer, openBatch, selectedVault, push]);

  const inspectBatch = useCallback(
    async (batchId: bigint) => {
      if (!w.signer) return;
      try {
        const { router } = getContracts(w.signer);
        const b = await router.getBatch(batchId);
        setBatchInfo({
          id: batchId,
          vaultId: Number(b.vaultId),
          status: Number(b.status),
          depositors: Number(b.depositorCount),
          totalAssets: b.clearTotalAssets as bigint,
          totalShares: b.clearTotalShares as bigint,
        });
      } catch (e: any) {
        push(e?.shortMessage ?? e?.message ?? "inspect failed", "err");
      }
    },
    [w.signer, push],
  );

  const doClaim = useCallback(
    async (batchId: bigint) => {
      if (!w.signer) return;
      setBusy("claim");
      try {
        const { router } = getContracts(w.signer);
        const b = await router.getBatch(batchId);
        if (Number(b.status) === 2) {
          push(`Claiming confidential shares from batch #${batchId}…`);
          await (await router.claim(batchId)).wait();
          push("Claimed. Your share balance is encrypted — click to reveal.", "ok");
        } else if (Number(b.status) === 3) {
          push(`Batch #${batchId} was cancelled — reclaiming deposit…`);
          await (await router.reclaim(batchId)).wait();
          push("Reclaimed.", "ok");
        } else {
          push("Batch not settled yet — wait for the oracle and retry.", "err");
        }
        bump();
      } catch (e: any) {
        push(e?.shortMessage ?? e?.message ?? "claim failed", "err");
      } finally {
        setBusy(null);
      }
    },
    [w.signer, push],
  );

  const doMigrate = useCallback(async () => {
    if (!w.signer) return;
    setBusy("migrate");
    try {
      const { router, cUSDC } = getContracts(w.signer);
      const amt = BigInt(Math.floor(Number(amount) * 1e6));
      const until = Math.floor(Date.now() / 1000) + 3600;
      push("Authorizing router as operator on cUSDC…");
      await (await cUSDC.setOperator(addresses.router, until)).wait();
      push(`Encrypting ${amount} cUSDC for migration…`);
      const { handle, inputProof } = await encryptAmount(addresses.router, w.address!, amt);
      const fromV = selectedVault;
      push(
        `Migrating from ${addresses.vaults[fromV - 1].name} → ${addresses.vaults[migrateTo - 1].name} in one click, fully encrypted…`,
      );
      await (await router.migrate(fromV, migrateTo, handle, inputProof)).wait();
      push("Migrated into the destination batch. Amount never appeared in cleartext.", "ok");
      bump();
    } catch (e: any) {
      push(e?.shortMessage ?? e?.message ?? "migrate failed", "err");
    } finally {
      setBusy(null);
    }
  }, [w.signer, w.address, amount, selectedVault, migrateTo, push]);

  const decryptCUSDC = useCallback(async (): Promise<bigint> => {
    if (!w.signer || !w.eip1193) return 0n;
    const { cUSDC } = getContracts(w.signer);
    const handle = await cUSDC.confidentialBalanceOf(w.address);
    return userDecrypt(w.eip1193, addresses.cUSDC, handle);
  }, [w.signer, w.eip1193, w.address]);

  const decryptShare = useCallback(
    async (vaultId: number): Promise<bigint> => {
      if (!w.signer || !w.eip1193) return 0n;
      const { shareTokens } = getContracts(w.signer);
      const token = shareTokens[vaultId - 1];
      const handle = await token.confidentialBalanceOf(w.address);
      return userDecrypt(w.eip1193, addresses.vaults[vaultId - 1].shareToken, handle);
    },
    [w.signer, w.eip1193, w.address],
  );

  const selectedBatch = openBatch[selectedVault];

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          <span className="mark">
            Veil<b>Yield</b>
          </span>
          <span className="tag">confidential · composable · onchain yield</span>
        </div>
        {w.address ? (
          <span className="pill">
            {w.address.slice(0, 6)}…{w.address.slice(-4)}
          </span>
        ) : (
          <button className="primary" onClick={w.connect} disabled={w.connecting}>
            {w.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>

      <div className="hero">
        <h1>
          Earn public DeFi yield <br />
          without revealing your <span className="veil">position</span>.
        </h1>
        <p>
          VeilYield routes confidential ERC-7984 tokens into public ERC-4626 vaults through an
          encrypted batch. Many depositors pool together; only the batch total is ever decrypted;
          you claim your share entirely in the encrypted domain — and migrate between vaults in one
          click, still private.
        </p>
      </div>

      {w.wrongNetwork && (
        <div className="banner warn">
          Wrong network. Switch your wallet to <b>Sepolia</b> to use VeilYield.
        </div>
      )}
      {w.error && <div className="banner err">{w.error}</div>}
      {!deployed && (
        <div className="banner warn">
          No deployment detected. Run <code>npx hardhat deploy --network sepolia</code> (it writes
          addresses into the frontend), then reload.
        </div>
      )}

      <div className="grid">
        {/* LEFT: actions */}
        <div>
          <div className="card">
            <h2>
              <span className="num">01</span> Your confidential balance
            </h2>
            <div className="balance-row">
              <div className="balance-label">
                cUSDC (spendable)
                <span className="sub">euint64 · only you can decrypt</span>
              </div>
              <CipherBalance label="cUSDC" decrypt={decryptCUSDC} refreshKey={refreshTick} />
            </div>
            {addresses.vaults.map((v) => (
              <div className="balance-row" key={v.id}>
                <div className="balance-label">
                  {v.name} shares
                  <span className="sub">confidential vault position</span>
                </div>
                <CipherBalance
                  label={`c${v.name}`}
                  decrypt={() => decryptShare(v.id)}
                  refreshKey={refreshTick}
                />
              </div>
            ))}
            <div className="actions" style={{ marginTop: 16 }}>
              <button onClick={faucet} disabled={!w.signer || busy === "faucet"}>
                {busy === "faucet" && <span className="spinner" />}Faucet: mint + wrap 100 cUSDC
              </button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2>
              <span className="num">02</span> Deposit into a vault
            </h2>
            <div className="step-flow">
              <span className="s active">encrypt</span>
              <span className="s">join batch</span>
              <span className="s">dispatch (pool total only)</span>
              <span className="s">claim shares</span>
            </div>

            {addresses.vaults.map((v) => (
              <div
                key={v.id}
                className={`vault ${selectedVault === v.id ? "selected" : ""}`}
                onClick={() => setSelectedVault(v.id)}
                style={{ cursor: "pointer" }}
              >
                <div className="vault-top">
                  <span className="vault-name">{v.name}</span>
                  <span className="vault-apy">{apyFromRate(v.rateBps)} APY</span>
                </div>
                <div className="vault-meta">
                  <span>ERC-4626 · USDC</span>
                  <span>anon set: {anon[v.id] ?? 0}</span>
                  <span>open batch: #{(openBatch[v.id] ?? 0n).toString()}</span>
                </div>
              </div>
            ))}

            <div className="field" style={{ marginTop: 8 }}>
              <label>Amount to deposit (encrypted before it leaves your browser)</label>
              <div className="input-amt">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                />
                <span className="suffix">cUSDC</span>
              </div>
            </div>

            <div className="actions">
              <button className="primary" onClick={doJoin} disabled={!w.signer || busy === "join"}>
                {busy === "join" && <span className="spinner" />}Encrypt &amp; join batch
              </button>
              <button
                className="ghost"
                onClick={doDispatch}
                disabled={!w.signer || busy === "dispatch" || !selectedBatch || selectedBatch === 0n}
              >
                {busy === "dispatch" && <span className="spinner" />}Dispatch batch
              </button>
              {selectedBatch && selectedBatch !== 0n && (
                <button className="ghost" onClick={() => doClaim(selectedBatch!)} disabled={busy === "claim"}>
                  {busy === "claim" && <span className="spinner" />}Claim / reclaim
                </button>
              )}
            </div>

            {/* Anonymity meter — honest privacy disclosure */}
            <div className="anon">
              <div className="anon-head">
                <span className="k">Anonymity set for this vault's open batch</span>
                <span className="v">{anon[selectedVault] ?? 0}</span>
              </div>
              <div className="anon-dots">
                {Array.from({ length: 8 }).map((_, i) => (
                  <span key={i} className={`dot ${i < (anon[selectedVault] ?? 0) ? "" : "empty"}`} />
                ))}
              </div>
              <div className="anon-note">
                Your privacy is exactly the number of independent depositors sharing this batch. A
                batch can't be dispatched until it ages past <code>minBatchAge</code>, giving organic
                depositors time to join. This is meaningful privacy against passive observers — not
                unconditional privacy against an adversary who floods the batch. We surface the real
                number instead of hiding it.
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2>
              <span className="num">03</span> Migrate between vaults — one click, still encrypted
            </h2>
            <p style={{ color: "var(--text-dim)", fontSize: 14, margin: "0 0 14px", lineHeight: 1.6 }}>
              Move a confidential position from{" "}
              <b>{addresses.vaults[selectedVault - 1]?.name}</b> into another vault without ever
              revealing the amount. The migrated value enters the destination batch and inherits its
              anonymity set.
            </p>
            <div className="field">
              <label>Destination vault</label>
              <div className="actions">
                {addresses.vaults
                  .filter((v) => v.id !== selectedVault)
                  .map((v) => (
                    <button
                      key={v.id}
                      className={migrateTo === v.id ? "primary" : "ghost"}
                      onClick={() => setMigrateTo(v.id)}
                    >
                      {v.name}
                    </button>
                  ))}
              </div>
            </div>
            <div className="actions">
              <button onClick={doMigrate} disabled={!w.signer || busy === "migrate" || migrateTo === selectedVault}>
                {busy === "migrate" && <span className="spinner" />}Migrate {amount} cUSDC →{" "}
                {addresses.vaults[migrateTo - 1]?.name}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: batch inspector + log */}
        <div>
          <div className="card">
            <h2>
              <span className="num">04</span> Batch inspector
            </h2>
            <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "0 0 12px", lineHeight: 1.6 }}>
              Public, non-sensitive batch lifecycle. Note: <b>only the pool total</b> is ever
              decrypted here — individual deposits stay encrypted forever.
            </p>
            <div className="actions" style={{ marginBottom: 12 }}>
              <button
                onClick={() => selectedBatch && inspectBatch(selectedBatch)}
                disabled={!selectedBatch || selectedBatch === 0n}
              >
                Inspect open batch #{(selectedBatch ?? 0n).toString()}
              </button>
            </div>
            {batchInfo && (
              <div>
                <div className="balance-row">
                  <span className="balance-label">Status</span>
                  <span className={`chip ${STATUS[batchInfo.status].toLowerCase()}`}>
                    {STATUS[batchInfo.status]}
                  </span>
                </div>
                <div className="balance-row">
                  <span className="balance-label">Vault</span>
                  <span className="cipher">
                    <span className="revealed">{addresses.vaults[batchInfo.vaultId - 1]?.name}</span>
                  </span>
                </div>
                <div className="balance-row">
                  <span className="balance-label">Distinct depositors</span>
                  <span className="cipher">
                    <span className="revealed">{batchInfo.depositors}</span>
                  </span>
                </div>
                <div className="balance-row">
                  <span className="balance-label">
                    Pool total <span className="sub">aggregate only — the one number decrypted</span>
                  </span>
                  <span className="cipher">
                    <span className="revealed">{fmt(batchInfo.totalAssets)}</span>
                    <span className="unit">USDC</span>
                  </span>
                </div>
                <div className="balance-row">
                  <span className="balance-label">Pool shares minted</span>
                  <span className="cipher">
                    <span className="revealed">{fmt(batchInfo.totalShares)}</span>
                  </span>
                </div>
                {batchInfo.status === 2 && (
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button className="primary" onClick={() => doClaim(batchInfo.id)} disabled={busy === "claim"}>
                      Claim my confidential shares
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <h2>Activity</h2>
            <div className="log">
              {log.length === 0 && <span className="ts">Actions will appear here…</span>}
              {log.map((l, i) => (
                <div key={i}>
                  <span className="ts">{l.ts} </span>
                  <span className={l.kind === "ok" ? "ok" : l.kind === "err" ? "err" : ""}>{l.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="footer">
        Built on the <a href="https://www.zama.org/">Zama Protocol</a> with FHEVM · Composable
        privacy: ERC-7984 × ERC-4626. Router: <code>{addresses.router}</code> · Network:{" "}
        <code>{addresses.network}</code>. Demo software, unaudited — testnet only.
      </div>
    </div>
  );
}
