# VeilYield 资料与账号准备清单
## PREP_AND_RESOURCES

> 本文列出你在开发、部署、提交 VeilYield 之前**需要提前准备好的所有资料、账号、密钥**。建议先把这张清单全部备齐，再开始跑 BUILD_AND_DEPLOY 的步骤——能省掉中途卡壳。
>
> 按"必须 / 推荐 / 可选"分级。带 🔑 的是密钥/敏感信息，**绝不要提交到 GitHub 或发给任何人**。

---

## 1. 钱包与助记词（必须）🔑

| 项目 | 说明 | 怎么准备 |
|---|---|---|
| **浏览器钱包** | MetaMask（或兼容的注入式钱包），跑前端 dApp 必需 | 浏览器商店安装 https://metamask.io |
| **部署用助记词（MNEMONIC）** 🔑 | 12 词助记词，部署合约的钱包 | **强烈建议新建一个一次性测试钱包**，专门用于 Sepolia，别用持有真实资产的助记词 |

**如何拿到一个干净的测试助记词：**
- 方式 A：MetaMask 里新建一个账户/钱包，设置 → 安全 → 显示助记词。
- 方式 B（更隔离）：离线打开 https://iancoleman.io/bip39/ 生成一个 12 词助记词，只用于测试。

**填到哪里：** 根目录 `.env` 的 `MNEMONIC="..."`。该助记词派生的**第一个地址**（路径 `m/44'/60'/0'/0/0`）就是部署者，需要有 Sepolia ETH。

> ⚠️ `.gitignore` 已排除 `.env`，但提交前务必用 `git status` 再确认一次 `.env` 没被加进去。

---

## 2. Sepolia 测试网 ETH（必须）

部署合约和发交易要付 gas。你需要在**部署者地址**里有一点 Sepolia ETH（通常 0.1~0.5 就够整个演示）。

**水龙头（任选其一，可能需要登录或满足条件）：**
- Google Cloud Web3 Sepolia Faucet：https://cloud.google.com/application/web3/faucet/ethereum/sepolia
- Alchemy Sepolia Faucet：https://www.alchemy.com/faucets/ethereum-sepolia （需 Alchemy 账号）
- Infura Sepolia Faucet：https://www.infura.io/faucet/sepolia （需 Infura 账号）
- PoW 水龙头（无需账号，挖一会儿）：https://sepolia-faucet.pk910.de/

**怎么知道部署者地址是哪个？**
部署时脚本会打印 `deployer: 0x...`；或先跑 `npx hardhat run` 打印，或在 MetaMask 里看用该助记词导入的第一个账户地址。把测试 ETH 发到这个地址。

> **注意：** 本项目的机密代币（cUSDC）和金库都是项目自带的 mock，由部署脚本一并部署，**不需要**你去别处找测试代币——你用前端的 "Faucet" 按钮就能铸造并 wrap 出 cUSDC。你只需要准备 **Sepolia ETH 付 gas** 即可。

---

## 3. Sepolia RPC 端点（推荐）

`hardhat.config.ts` 已预填一个公共 RPC，能用，但**公共 RPC 对 FHEVM 这类加密交易经常不稳定**。强烈建议申请一个专用的：

| 提供方 | 链接 | 说明 |
|---|---|---|
| Alchemy | https://www.alchemy.com | 免费档够用，建 App 选 Ethereum → Sepolia，复制 HTTPS URL |
| Infura | https://www.infura.io | 同上 |
| PublicNode | https://ethereum-sepolia-rpc.publicnode.com | 免费公共，已预填，作兜底 |

**填到哪里：**
- 根目录 `.env` 的 `SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/你的KEY"`
- 前端 `frontend/.env` 的 `VITE_SEPOLIA_RPC_URL="..."`（可选，给 relayer 用更稳）

---

## 4. Zama 协议侧（已内置，无需额外申请）

VeilYield 的合约继承 `SepoliaConfig`，前端用 `createInstance(SepoliaConfig)`——**Sepolia 上的 Zama 网络配置（ACL、KMS、Gateway、Relayer 地址）SDK 已内置**，你不需要手动填这些地址，也不需要申请 Zama 的 API key。

> 如果将来要手动配置（比如换网络），参考官方 Relayer SDK 文档的 `createInstance` 配置项。本项目默认走 SepoliaConfig，开箱即用。

---

## 5. Etherscan API Key（可选）

仅用于 `npx hardhat verify` 在 Etherscan 上验证合约源码。不验证也能演示。

- 申请：https://etherscan.io/myapikey
- 填到根目录 `.env` 的 `ETHERSCAN_API_KEY="..."`

---

## 6. 提交物所需的账号（必须）

为了向 Zama 表单提交，你需要：

| 账号/物料 | 用途 | 准备 |
|---|---|---|
| **GitHub 账号** | 托管代码仓库 | https://github.com 注册，建一个仓库推代码 |
| **X（Twitter）账号** | 发项目 thread，tag @zama + #ZamaDeveloperProgram（**这是硬性要求**） | 用你的账号发 |
| **视频托管** | 上传 3 分钟**真人**视频（AI 配音/AI 生成会被判负） | YouTube（可设"不公开"链接）或 Loom |
| **前端部署平台**（推荐） | 评委要 "working demo deployed on a website" | Vercel（https://vercel.com，连 GitHub 一键部署），或 Netlify |

---

## 7. 开发机本地环境（必须）

| 工具 | 版本 | 检查命令 |
|---|---|---|
| Node.js | **≥ 20** | `node -v` |
| npm | ≥ 9 | `npm -v` |
| Git | 任意 | `git --version` |

> Node 版本不够会导致 FHEVM 工具链报错。用 `nvm install 20 && nvm use 20` 升级最省心。

---

## 8. 全部备齐后的检查清单

开始 BUILD_AND_DEPLOY 之前，确认：

- [ ] 装好 MetaMask，并新建/导入了一个**一次性测试钱包**。
- [ ] 拿到该钱包的 **12 词助记词**（准备填进 `.env`）。🔑
- [ ] 部署者地址里有 **Sepolia ETH**（从水龙头领的）。
- [ ] 申请了一个 **Sepolia RPC URL**（Alchemy/Infura，推荐）。
- [ ] 本机 **Node ≥ 20**。
- [ ] 有 **GitHub 账号**（建好空仓库）。
- [ ] 有 **X 账号**（准备发 thread）。
- [ ] 想好 **视频**怎么录（真人出镜）和传哪里。
- [ ] （推荐）有 **Vercel/Netlify** 账号准备部署前端。

全部打勾后，回到 **BUILD_AND_DEPLOY.md** 从第 1 步开始。

---

## 9. 各项资料该填到哪个文件（速查）

| 资料 | 文件 | 字段 |
|---|---|---|
| 助记词 🔑 | `.env`（根目录） | `MNEMONIC` |
| Sepolia RPC | `.env`（根目录） | `SEPOLIA_RPC_URL` |
| Etherscan Key | `.env`（根目录） | `ETHERSCAN_API_KEY` |
| 前端 RPC（可选） | `frontend/.env` | `VITE_SEPOLIA_RPC_URL` |
| 部署后的合约地址 | `frontend/src/lib/addresses.json` | **部署脚本自动写入，无需手填** |

> 再次提醒：`.env` 和 `frontend/.env` 都在 `.gitignore` 里，**绝不提交**。仓库里只保留 `.env.example` 模板。

---

## 10. 你**不**需要准备的东西（避免走弯路）

- ❌ 不需要找外部的测试 USDC / cUSDC —— 项目自带 mock，前端 Faucet 一键搞定。
- ❌ 不需要 Zama 的 API key —— SepoliaConfig 内置。
- ❌ 不需要主网 ETH 或真实资金 —— 全程 Sepolia 测试网。
- ❌ 不需要自己部署 Morpho/Steakhouse 金库 —— 项目用可配置汇率的 mock ERC-4626 金库代替（生产化时才换成真金库地址）。
