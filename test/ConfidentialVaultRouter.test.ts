import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as hre from "hardhat";

/**
 * End-to-end tests for the VeilYield ConfidentialVaultRouter on the FHEVM mock runtime.
 *
 * Covered:
 *  - full happy path: wrap -> join -> dispatch -> settle -> claim, with the share balance correct
 *  - pooling: two depositors in one batch, only the aggregate is ever decrypted, each claims pro-rata
 *  - quit: a depositor reclaims before dispatch and is excluded from the settled deposit
 *  - anonymity-set accounting: depositorCount reflects distinct joiners
 *  - migration: a confidential position is moved into another vault's batch and settles correctly
 *  - guards: cannot dispatch before minBatchAge; cannot claim twice
 */
describe("ConfidentialVaultRouter", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let usdc: any;
  let vaultA: any;
  let vaultB: any;
  let cUSDC: any;
  let cShareA: any;
  let cShareB: any;
  let router: any;

  let usdcAddr: string;
  let cUSDCAddr: string;
  let cShareAAddr: string;
  let cShareBAddr: string;
  let routerAddr: string;

  const MIN_BATCH_AGE = 1;
  const ONE = 1_000_000; // 1.0 token at 6 decimals

  before(async function () {
    if (!hre.fhevm.isMock) {
      throw new Error("This test suite must run on the FHEVM mock network (npx hardhat test).");
    }
    const signers = await ethers.getSigners();
    [deployer, alice, bob] = signers;
  });

  beforeEach(async function () {
    // Public USDC
    usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    usdcAddr = await usdc.getAddress();

    // Two ERC-4626 vaults with different rates
    vaultA = await ethers.deployContract("MockERC4626Vault", [usdcAddr, "stPRIME", "stPRIME", 10_000]);
    vaultB = await ethers.deployContract("MockERC4626Vault", [usdcAddr, "stCORE", "stCORE", 10_500]);
    const vaultAAddr = await vaultA.getAddress();
    const vaultBAddr = await vaultB.getAddress();

    // Confidential tokens
    cUSDC = await ethers.deployContract("DemoConfidentialToken", ["cUSDC", "cUSDC", usdcAddr]);
    cShareA = await ethers.deployContract("DemoConfidentialToken", ["cstPRIME", "cstPRIME", vaultAAddr]);
    cShareB = await ethers.deployContract("DemoConfidentialToken", ["cstCORE", "cstCORE", vaultBAddr]);
    cUSDCAddr = await cUSDC.getAddress();
    cShareAAddr = await cShareA.getAddress();
    cShareBAddr = await cShareB.getAddress();

    // Router
    router = await ethers.deployContract("ConfidentialVaultRouter", [MIN_BATCH_AGE]);
    routerAddr = await router.getAddress();

    await (await router.registerVault(vaultAAddr, cUSDCAddr, cShareAAddr)).wait();
    await (await router.registerVault(vaultBAddr, cUSDCAddr, cShareBAddr)).wait();
  });

  // Helper: give `who` `amount` of confidential cUSDC (mint mock USDC -> wrap).
  async function fundConfidential(who: HardhatEthersSigner, amount: number) {
    await (await usdc.mint(who.address, amount)).wait();
    await (await usdc.connect(who).approve(cUSDCAddr, amount)).wait();
    await (await cUSDC.connect(who).wrap(who.address, amount)).wait();
  }

  // Helper: encrypt `amount` for (router, user) and call join.
  async function join(who: HardhatEthersSigner, vaultId: number, amount: number) {
    // Authorize the router as operator on cUSDC so it can pull the confidential deposit.
    const until = Math.floor(Date.now() / 1000) + 3600;
    await (await cUSDC.connect(who).setOperator(routerAddr, until)).wait();

    const enc = await fhevm.createEncryptedInput(routerAddr, who.address).add64(amount).encrypt();
    await (await router.connect(who).join(vaultId, enc.handles[0], enc.inputProof)).wait();
  }

  async function decryptCUSDC(who: HardhatEthersSigner): Promise<bigint> {
    const handle = await cUSDC.confidentialBalanceOf(who.address);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, cUSDCAddr, who);
  }

  async function decryptShareA(who: HardhatEthersSigner): Promise<bigint> {
    const handle = await cShareA.confidentialBalanceOf(who.address);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, cShareAAddr, who);
  }

  it("registers two vaults", async function () {
    expect(await router.vaultCount()).to.equal(2n);
    const v1 = await router.vaults(1);
    expect(v1.exists).to.equal(true);
    expect(v1.enabled).to.equal(true);
  });

  it("full single-user lifecycle: wrap -> join -> dispatch -> settle -> claim", async function () {
    await fundConfidential(alice, 100 * ONE);

    // Sanity: Alice holds 100 cUSDC, encrypted.
    expect(await decryptCUSDC(alice)).to.equal(BigInt(100 * ONE));

    // Join vault 1 with 40 cUSDC.
    await join(alice, 1, 40 * ONE);

    const batchId = await router.openBatchOf(1);
    expect(batchId).to.equal(1n);
    expect(await router.currentAnonymitySet(1)).to.equal(1);

    // Alice's deposit balance dropped by 40.
    expect(await decryptCUSDC(alice)).to.equal(BigInt(60 * ONE));

    // Dispatch after minBatchAge.
    await time.increase(MIN_BATCH_AGE + 1);
    await (await router.dispatchBatch(batchId)).wait();

    // Drive the mock decryption oracle to deliver the aggregate and run settlement.
    await fhevm.awaitDecryptionOracle();

    const b = await router.getBatch(batchId);
    expect(b.status).to.equal(2); // Settled
    expect(b.clearTotalAssets).to.equal(BigInt(40 * ONE));
    // Vault A rate 1.0 -> shares == assets.
    expect(b.clearTotalShares).to.equal(BigInt(40 * ONE));

    // Claim confidential shares.
    await (await router.connect(alice).claim(batchId)).wait();
    expect(await decryptShareA(alice)).to.equal(BigInt(40 * ONE));

    // Double claim is rejected.
    await expect(router.connect(alice).claim(batchId)).to.be.reverted;
  });

  it("pools two depositors and only ever decrypts the aggregate; each claims pro-rata", async function () {
    await fundConfidential(alice, 100 * ONE);
    await fundConfidential(bob, 100 * ONE);

    await join(alice, 1, 30 * ONE);
    await join(bob, 1, 10 * ONE);

    const batchId = await router.openBatchOf(1);
    expect(await router.currentAnonymitySet(1)).to.equal(2);

    await time.increase(MIN_BATCH_AGE + 1);
    await (await router.dispatchBatch(batchId)).wait();
    await fhevm.awaitDecryptionOracle();

    const b = await router.getBatch(batchId);
    // Only the aggregate (40) was decrypted — never the individual 30 / 10.
    expect(b.clearTotalAssets).to.equal(BigInt(40 * ONE));

    await (await router.connect(alice).claim(batchId)).wait();
    await (await router.connect(bob).claim(batchId)).wait();

    // Vault A rate 1.0 -> shares equal deposits, pro-rata.
    expect(await decryptShareA(alice)).to.equal(BigInt(30 * ONE));
    expect(await decryptShareA(bob)).to.equal(BigInt(10 * ONE));
  });

  it("lets a depositor quit before dispatch and excludes them from settlement", async function () {
    await fundConfidential(alice, 100 * ONE);
    await fundConfidential(bob, 100 * ONE);

    await join(alice, 1, 25 * ONE);
    await join(bob, 1, 15 * ONE);

    const batchId = await router.openBatchOf(1);

    // Bob changes his mind and quits; he gets his 15 back.
    await (await router.connect(bob).quit(batchId)).wait();
    expect(await decryptCUSDC(bob)).to.equal(BigInt(100 * ONE));

    await time.increase(MIN_BATCH_AGE + 1);
    await (await router.dispatchBatch(batchId)).wait();
    await fhevm.awaitDecryptionOracle();

    const b = await router.getBatch(batchId);
    // Only Alice's 25 remains in the settled total.
    expect(b.clearTotalAssets).to.equal(BigInt(25 * ONE));

    await (await router.connect(alice).claim(batchId)).wait();
    expect(await decryptShareA(alice)).to.equal(BigInt(25 * ONE));
  });

  it("reverts dispatch before the batch reaches minBatchAge", async function () {
    // Use a fresh router with a longer batch age so the guard is observable.
    const longRouter = await ethers.deployContract("ConfidentialVaultRouter", [10_000]);
    const longAddr = await longRouter.getAddress();
    await (await longRouter.registerVault(await vaultA.getAddress(), cUSDCAddr, cShareAAddr)).wait();

    await fundConfidential(alice, 50 * ONE);
    const until = Math.floor(Date.now() / 1000) + 3600;
    await (await cUSDC.connect(alice).setOperator(longAddr, until)).wait();
    const enc = await fhevm.createEncryptedInput(longAddr, alice.address).add64(20 * ONE).encrypt();
    await (await longRouter.connect(alice).join(1, enc.handles[0], enc.inputProof)).wait();

    const batchId = await longRouter.openBatchOf(1);
    await expect(longRouter.dispatchBatch(batchId)).to.be.revertedWithCustomError(
      longRouter,
      "BatchTooYoung",
    );
  });

  it("migrates a confidential position into another vault and settles it", async function () {
    // Alice ends up holding cUSDC and migrates 20 of it into vault 2.
    await fundConfidential(alice, 100 * ONE);

    const toBatchTx = await (async () => {
      const until = Math.floor(Date.now() / 1000) + 3600;
      await (await cUSDC.connect(alice).setOperator(routerAddr, until)).wait();
      const enc = await fhevm.createEncryptedInput(routerAddr, alice.address).add64(20 * ONE).encrypt();
      return router.connect(alice).migrate(1, 2, enc.handles[0], enc.inputProof);
    })();
    await toBatchTx.wait();

    const batchId = await router.openBatchOf(2);
    expect(batchId).to.not.equal(0n);
    expect(await router.currentAnonymitySet(2)).to.equal(1);

    await time.increase(MIN_BATCH_AGE + 1);
    await (await router.dispatchBatch(batchId)).wait();
    await fhevm.awaitDecryptionOracle();

    const b = await router.getBatch(batchId);
    expect(b.vaultId).to.equal(2n);
    expect(b.status).to.equal(2); // Settled
    expect(b.clearTotalAssets).to.equal(BigInt(20 * ONE));
    // Vault B rate 1.05 -> shares = assets * 1e4 / 10500.
    const expectedShares = BigInt(Math.floor((20 * ONE * 10_000) / 10_500));
    expect(b.clearTotalShares).to.equal(expectedShares);

    // Alice can claim her confidential vault-2 shares.
    await (await router.connect(alice).claim(batchId)).wait();
    const handle = await cShareB.confidentialBalanceOf(alice.address);
    const shares = await fhevm.userDecryptEuint(FhevmType.euint64, handle, cShareBAddr, alice);
    expect(shares).to.equal(expectedShares);
  });
});
