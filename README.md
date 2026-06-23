# VeilYield — Confidential, Composable Yield Router

> **Zama Developer Program — Mainnet Season 3, Builder Track.**
> Move confidential ERC-7984 tokens in and out of public ERC-4626 DeFi vaults **without revealing your individual position**, and migrate between vaults in one click — still encrypted.

VeilYield is the Season 3 thesis ("**Composable Privacy Is the Key**") made concrete: a confidential asset composed with the rest of the public EVM. It takes the pooling pattern Zama shipped in its first confidential vault stack and turns it into a **user-facing, multi-vault yield router** with a confidential cross-vault migration flow that the single-vault v1 batcher does not yet expose.

---

## What it does

1. **Deposit privately.** You hold confidential cUSDC (an ERC-7984 wrapper). You pick a public ERC-4626 vault and deposit an **encrypted amount**. Many users join the same batch.
2. **Only the total is revealed.** When the batch is dispatched, the router homomorphically sums everyone's deposits and asks the Zama gateway to decrypt **only the aggregate**. A single pooled deposit hits the public vault. Your individual amount is never decrypted.
3. **Claim shares, still encrypted.** You claim your vault shares pro-rata, computed in the encrypted domain (`shares_i = deposit_i × totalShares ÷ totalAssets`). Your share balance is an `euint64` only you can decrypt.
4. **Migrate in one click.** Move a confidential position from one vault into another without revealing the amount. The migrant enters the destination batch and inherits its anonymity set.

The frontend renders every encrypted balance as a **shimmering masked ciphertext you click to reveal** (running the EIP-712 user-decryption flow) — making the FHE the tactile centerpiece.

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
   cUSDC (ERC-7984) │            ConfidentialVaultRouter         │   ERC-4626 vaults (public)
   encrypted balance│                                            │   ┌────────────────────┐
        │           │  join ─► batch.encryptedTotal += amount    │   │ Steakhouse Prime   │
        ├──────────►│  dispatch ─► decrypt AGGREGATE only ───────┼──►│ deposit(total)     │
        │           │  settle ─► vault.deposit + wrap shares     │   └────────────────────┘
        │           │  claim ─► shares_i = dep_i·S÷A (encrypted) │   ┌────────────────────┐
   migrate ────────►│  migrate ─► credit destination batch       │   │ Steakhouse Core    │
                    └──────────────────────────────────────────┘   └────────────────────┘
```

**Privacy model (stated honestly):** your anonymity set is exactly the number of independent depositors sharing a batch. A batch can't be dispatched until it ages past `minBatchAge`. This is meaningful privacy against passive observers and materially raises the cost of active deanonymization — it is **not** unconditional privacy against an adversary who floods a batch. The UI surfaces the real anonymity-set size instead of hiding it.

### Contracts

| Contract | Role |
|---|---|
| `ConfidentialVaultRouter.sol` | Core. Batched join → dispatch → settle → claim, plus quit, reclaim, and confidential `migrate`. Never branches on encrypted values; uses `FHE.select` and the no-revert convention. |
| `interfaces/IConfidentialToken.sol` | Minimal ERC-7984 + wrapper surface the router depends on (decoupled from OZ 0.x churn). |
| `interfaces/IERC4626Minimal.sol` | The slice of ERC-4626 the router calls. |
| `mocks/DemoConfidentialToken.sol` | Self-contained ERC-7984-style confidential token + ERC-20 wrapper, real FHE `euint64` arithmetic. |
| `mocks/MockERC20.sol` | Public USDC stand-in (6 decimals, faucet mint). |
| `mocks/MockERC4626Vault.sol` | Public yield-vault stand-in with a configurable exchange rate to model differing APYs. |

> **Why a self-contained confidential token instead of inheriting OpenZeppelin's `ERC7984ERC20Wrapper`?** OZ's canonical wrapper performs `unwrap` through a two-step asynchronous gateway flow and the library is under rapid 0.x development with frequent breaking changes. For a deliverable that must compile and run deterministically today, the demo token implements a faithful, synchronous wrapper whose `unwrap` consumes the already-decrypted pool aggregate — exactly the only value the router ever has in cleartext. The confidentiality semantics (encrypted balances, encrypted transfers, ACL-gated decryption, no-revert-on-insufficient-funds) are identical to ERC-7984. A production deployment points the router's `IConfidentialToken` slots at the official Zama wrappers (cUSDC, cWETH, …).

---

## Quick start

Prerequisites: **Node.js ≥ 20**, npm, and a browser wallet (MetaMask) for the frontend.

```bash
# 1. Install contract deps
npm install

# 2. Compile + run the full test suite on the FHEVM mock runtime
npm run compile
npm test

# 3. (optional) Run a local node + deploy
npm run node            # terminal 1
npm run deploy:local    # terminal 2
```

### Deploy to Sepolia + run the dApp

```bash
cp .env.example .env          # fill in MNEMONIC + SEPOLIA_RPC_URL
npm run deploy:sepolia        # writes addresses into the frontend automatically

cd frontend
cp .env.example .env          # optional RPC override
npm install
npm run dev                   # open the printed localhost URL
```

Then in the dApp: **Connect wallet → Faucet (mint + wrap 100 cUSDC) → pick a vault → Encrypt & join → Dispatch → Claim**. Try **Migrate** to move a position to the other vault, still encrypted.

CLI alternative (no frontend):

```bash
npx hardhat vy:faucet  --amount 100 --network sepolia
npx hardhat vy:join    --vault 1 --amount 40 --network sepolia
npx hardhat vy:dispatch --batch 1 --network sepolia
npx hardhat vy:claim   --batch 1 --network sepolia
npx hardhat vy:balance --network sepolia
```

---

## Tests

`npm test` runs the lifecycle on the FHEVM mock runtime and covers: the full single-user happy path, two-user **pooling** (only the aggregate is decrypted; each claims pro-rata), **quit** before dispatch, the `minBatchAge` **dispatch guard**, **double-claim** rejection, and **migration** with correct settlement against a different vault rate.

---

## License

BSD-3-Clause-Clear. Demo software, unaudited — testnet only.
