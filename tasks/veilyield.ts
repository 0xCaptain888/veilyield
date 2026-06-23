import { task } from "hardhat/config";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * CLI tasks for interacting with a deployed VeilYield router.
 *
 * Examples (Sepolia):
 *   npx hardhat vy:faucet --amount 100 --network sepolia
 *   npx hardhat vy:join --vault 1 --amount 40 --network sepolia
 *   npx hardhat vy:dispatch --batch 1 --network sepolia
 *   npx hardhat vy:claim --batch 1 --network sepolia
 *   npx hardhat vy:balance --network sepolia
 */

function loadAddresses(hre: any) {
  const chainId = hre.network.config.chainId ?? 31337;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  const path = require("path");
  const p = path.join(__dirname, "..", "deployments", `addresses.${chainId}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`No deployment found at ${p}. Run \`npx hardhat deploy\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

task("vy:faucet", "Mint mock USDC and wrap it into confidential cUSDC")
  .addParam("amount", "Amount in whole tokens (e.g. 100)")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const a = loadAddresses(hre);
    const [me] = await ethers.getSigners();
    const amount = Math.floor(Number(args.amount) * 1e6);

    const usdc = await ethers.getContractAt("MockERC20", a.USDC);
    const cUSDC = await ethers.getContractAt("DemoConfidentialToken", a.cUSDC);

    console.log(`Minting ${args.amount} USDC to ${me.address}...`);
    await (await usdc.mint(me.address, amount)).wait();
    await (await usdc.approve(a.cUSDC, amount)).wait();
    console.log(`Wrapping into cUSDC...`);
    await (await cUSDC.wrap(me.address, amount)).wait();
    console.log(`Done. You now hold confidential cUSDC.`);
  });

task("vy:join", "Join a vault's deposit batch with an encrypted amount")
  .addParam("vault", "Vault id (1 or 2)")
  .addParam("amount", "Amount in whole tokens")
  .setAction(async (args, hre) => {
    const { ethers, fhevm } = hre;
    const a = loadAddresses(hre);
    const [me] = await ethers.getSigners();
    const amount = Math.floor(Number(args.amount) * 1e6);

    const cUSDC = await ethers.getContractAt("DemoConfidentialToken", a.cUSDC);
    const router = await ethers.getContractAt("ConfidentialVaultRouter", a.router);

    const until = Math.floor(Date.now() / 1000) + 3600;
    console.log(`Authorizing router as operator...`);
    await (await cUSDC.setOperator(a.router, until)).wait();

    console.log(`Encrypting ${args.amount} and joining vault ${args.vault}...`);
    const enc = await fhevm.createEncryptedInput(a.router, me.address).add64(amount).encrypt();
    const tx = await router.join(args.vault, enc.handles[0], enc.inputProof);
    await tx.wait();

    const batchId = await router.openBatchOf(args.vault);
    console.log(`Joined batch #${batchId}. Anonymity set: ${await router.currentAnonymitySet(args.vault)}`);
  });

task("vy:dispatch", "Dispatch a batch (decrypt aggregate, deposit into the vault)")
  .addParam("batch", "Batch id")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const a = loadAddresses(hre);
    const router = await ethers.getContractAt("ConfidentialVaultRouter", a.router);
    console.log(`Dispatching batch #${args.batch}...`);
    await (await router.dispatchBatch(args.batch)).wait();
    console.log(`Dispatched. The decryption oracle will settle it shortly; then run vy:claim.`);
  });

task("vy:claim", "Claim confidential vault shares from a settled batch")
  .addParam("batch", "Batch id")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const a = loadAddresses(hre);
    const router = await ethers.getContractAt("ConfidentialVaultRouter", a.router);
    const b = await router.getBatch(args.batch);
    console.log(`Batch status: ${["Open", "Dispatched", "Settled", "Cancelled"][Number(b.status)]}`);
    if (Number(b.status) === 2) {
      await (await router.claim(args.batch)).wait();
      console.log(`Claimed confidential shares.`);
    } else if (Number(b.status) === 3) {
      await (await router.reclaim(args.batch)).wait();
      console.log(`Batch was cancelled — reclaimed your deposit.`);
    } else {
      console.log(`Not settled yet. Wait for the oracle and retry.`);
    }
  });

task("vy:balance", "Decrypt and print your confidential balances").setAction(async (_args, hre) => {
  const { ethers, fhevm } = hre;
  const a = loadAddresses(hre);
  const [me] = await ethers.getSigners();
  const cUSDC = await ethers.getContractAt("DemoConfidentialToken", a.cUSDC);

  const handle = await cUSDC.confidentialBalanceOf(me.address);
  if (handle === ethers.ZeroHash) {
    console.log(`cUSDC balance: 0 (uninitialized)`);
    return;
  }
  const clear = await fhevm.userDecryptEuint(FhevmType.euint64, handle, a.cUSDC, me);
  console.log(`cUSDC balance: ${Number(clear) / 1e6}`);
});
