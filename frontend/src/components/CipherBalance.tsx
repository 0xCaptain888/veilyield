import { useEffect, useState } from "react";

/**
 * The signature UI element of VeilYield.
 *
 * An encrypted balance renders as a shimmering masked ciphertext (••••••) — a literal stand-in for
 * the euint64 handle that lives on-chain. Clicking it runs the EIP-712 user-decryption flow and
 * reveals the cleartext, locally, for this user only. This makes the FHE the tactile centerpiece:
 * the value is genuinely hidden until you prove you're allowed to see it.
 */
export function CipherBalance({
  label,
  decrypt,
  refreshKey,
}: {
  label: string;
  decrypt: () => Promise<bigint>;
  refreshKey?: number;
}) {
  const [value, setValue] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  // Re-mask whenever upstream state changes (a new deposit/claim invalidates the revealed number).
  useEffect(() => {
    setValue(null);
    setErr(false);
  }, [refreshKey]);

  async function reveal() {
    if (loading) return;
    setLoading(true);
    setErr(false);
    try {
      const v = await decrypt();
      setValue(v);
    } catch (e) {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <span className="cipher" title={`Decrypting ${label}…`}>
        <span className="spinner" />
        <span className="unit">decrypting…</span>
      </span>
    );
  }

  if (value !== null) {
    return (
      <span className="cipher">
        <span className="revealed">{(Number(value) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        <span className="unit">{label}</span>
        <span
          className="masked"
          style={{ fontSize: 11, animation: "none", borderBottom: "none" }}
          onClick={() => setValue(null)}
          title="Re-hide"
        >
          ↺
        </span>
      </span>
    );
  }

  return (
    <span className="cipher">
      <span className="masked" onClick={reveal} title="Click to decrypt (you'll sign an EIP-712 request)">
        {err ? "•••• tap to retry" : "•••••• reveal"}
      </span>
    </span>
  );
}
