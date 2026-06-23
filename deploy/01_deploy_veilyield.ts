import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the full VeilYield stack:
 *   1. MockERC20 "USDC"            — the public asset both vaults manage
 *   2. Two MockERC4626Vault        — "Steakhouse Prime" (1.00) and "Steakhouse Core" (1.05 rate)
 *   3. Confidential deposit token  — cUSDC, wrapping the mock USDC (used by both vaults)
 *   4. Two confidential share tokens — wrapping each vault's share ERC-20
 *   5. ConfidentialVaultRouter     — the core, with minBatchAge
 *   6. registerVault x2            — wires both vaults into the router
 *
 * Addresses are written to ./deployments/addresses.<chainId>.json and mirrored into
 * frontend/src/lib/addresses.json so the UI picks them up automatically.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers, network } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  // On a local mock chain we can use a tiny batch age so the demo flows quickly.
  // On Sepolia we still keep it short for the demo but you may raise it for a real anonymity set.
  const MIN_BATCH_AGE = network.name === "sepolia" ? 60 : 1; // seconds

  log(`\n=== Deploying VeilYield to ${network.name} (deployer: ${deployer}) ===\n`);

  // 1. Mock public USDC (6 decimals).
  const usdc = await deploy("MockERC20", {
    from: deployer,
    args: ["USD Coin (Mock)", "USDC", 6],
    log: true,
  });

  // 2. Two ERC-4626 vaults over USDC, with different exchange rates to model different APYs.
  const vaultA = await deploy("VaultSteakPrime", {
    contract: "MockERC4626Vault",
    from: deployer,
    args: [usdc.address, "Steakhouse Prime Shares", "stPRIME", 10_000], // 1.00
    log: true,
  });
  const vaultB = await deploy("VaultSteakCore", {
    contract: "MockERC4626Vault",
    from: deployer,
    args: [usdc.address, "Steakhouse Core Shares", "stCORE", 10_500], // 1.05 (shares worth more)
    log: true,
  });

  // 3. Confidential deposit token cUSDC, wrapping the mock USDC.
  const cUSDC = await deploy("cUSDC", {
    contract: "DemoConfidentialToken",
    from: deployer,
    args: ["Confidential USDC", "cUSDC", usdc.address],
    log: true,
  });

  // 4. Confidential share tokens, one per vault, wrapping each vault's share ERC-20.
  const cShareA = await deploy("cShareSteakPrime", {
    contract: "DemoConfidentialToken",
    from: deployer,
    args: ["Confidential stPRIME", "cstPRIME", vaultA.address],
    log: true,
  });
  const cShareB = await deploy("cShareSteakCore", {
    contract: "DemoConfidentialToken",
    from: deployer,
    args: ["Confidential stCORE", "cstCORE", vaultB.address],
    log: true,
  });

  // 5. The router.
  const router = await deploy("ConfidentialVaultRouter", {
    from: deployer,
    args: [MIN_BATCH_AGE],
    log: true,
  });

  // 6. Register both vaults in the router (idempotent guard: only if not yet registered).
  const routerContract = await ethers.getContractAt("ConfidentialVaultRouter", router.address);
  const existing = await routerContract.vaultCount();
  if (existing === 0n) {
    let tx = await routerContract.registerVault(vaultA.address, cUSDC.address, cShareA.address);
    await tx.wait();
    tx = await routerContract.registerVault(vaultB.address, cUSDC.address, cShareB.address);
    await tx.wait();
    log(`Registered 2 vaults in the router.`);
  } else {
    log(`Router already has ${existing} vault(s) registered, skipping registration.`);
  }

  // Persist addresses for the frontend and for reference.
  const chainId = network.config.chainId ?? 31337;
  const addresses = {
    chainId,
    network: network.name,
    USDC: usdc.address,
    cUSDC: cUSDC.address,
    router: router.address,
    vaults: [
      {
        id: 1,
        name: "Steakhouse Prime",
        vault: vaultA.address,
        shareToken: cShareA.address,
        rateBps: 10_000,
      },
      {
        id: 2,
        name: "Steakhouse Core",
        vault: vaultB.address,
        shareToken: cShareB.address,
        rateBps: 10_500,
      },
    ],
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentsDir, `addresses.${chainId}.json`),
    JSON.stringify(addresses, null, 2),
  );

  const frontendLibDir = path.join(__dirname, "..", "frontend", "src", "lib");
  if (fs.existsSync(frontendLibDir)) {
    fs.writeFileSync(path.join(frontendLibDir, "addresses.json"), JSON.stringify(addresses, null, 2));
    log(`Mirrored addresses into frontend/src/lib/addresses.json`);
  }

  log(`\n=== VeilYield deployed. Router: ${router.address} ===\n`);
};

export default func;
func.tags = ["VeilYield"];
