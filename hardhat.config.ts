import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";
import "hardhat-deploy";
import "./tasks/veilyield";
import * as dotenv from "dotenv";

dotenv.config();

// Read secrets from environment (.env). Support both PRIVATE_KEY and MNEMONIC.
// Never commit secrets — see .env.example.
const PRIVATE_KEY: string | undefined = process.env.PRIVATE_KEY;
const MNEMONIC: string =
  process.env.MNEMONIC || "test test test test test test test test test test test junk";
const SEPOLIA_RPC_URL: string =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const ETHERSCAN_API_KEY: string = process.env.ETHERSCAN_API_KEY || "";

// Build the sepolia accounts config: prefer private key if set, fall back to mnemonic.
const sepoliaAccounts: any = PRIVATE_KEY
  ? [PRIVATE_KEY]
  : { mnemonic: MNEMONIC, path: "m/44'/60'/0'/0", count: 10 };

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // FHEVM contracts rely on the Cancun EVM features available on Sepolia/mainnet.
      evmVersion: "cancun",
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      // The FHEVM Hardhat plugin runs an in-memory mock coprocessor on this network.
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: sepoliaAccounts,
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY,
    },
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
  mocha: {
    timeout: 300000,
  },
};

export default config;
