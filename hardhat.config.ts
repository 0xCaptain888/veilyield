import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";
import "hardhat-deploy";
import "./tasks/veilyield";
import * as dotenv from "dotenv";

dotenv.config();

// Read secrets from environment (.env). MNEMONIC funds deployments; a 12-word test mnemonic is
// fine for Sepolia. Never commit a real mnemonic — see .env.example.
const MNEMONIC: string =
  process.env.MNEMONIC || "test test test test test test test test test test test junk";
const SEPOLIA_RPC_URL: string =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const ETHERSCAN_API_KEY: string = process.env.ETHERSCAN_API_KEY || "";

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
      accounts: {
        mnemonic: MNEMONIC,
        path: "m/44'/60'/0'/0",
        count: 10,
      },
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
