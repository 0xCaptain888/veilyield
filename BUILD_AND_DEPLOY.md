# VeilYield 构建 · 运行 · 部署 · 上传 GitHub 指南
## BUILD_AND_DEPLOY

> 本文是把 VeilYield 从压缩包跑通、部署到 Sepolia、并推到 GitHub 的**逐步操作手册**。按顺序照做即可。
>
> ⚠️ **重要的诚实说明：** 代码是在一个**无网络**的环境里写的，无法在该环境里运行 `npm install` 或 Solidity 编译器做最终验证。所有合约都是**严格对照 Zama 官方示例的当前 API 手写并逐行自查**的，TypeScript 已做语法校验。**第一步务必在你本机跑 `npm install && npm run compile && npm test`**——若有任何编译问题，本文第 7 节给了排查与回退方案。这是诚实交付，不是"保证零报错"。

---

## 0. 前置要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 20** | FHEVM 工具链要求；用 `node -v` 确认 |
| npm | ≥ 9 | 随 Node 安装 |
| Git | 任意 | 推 GitHub 用 |
| 浏览器钱包 | MetaMask | 跑前端 dApp 用 |
| Sepolia 测试币 | 一点点 ETH | 部署和交易的 gas，见 PREP_AND_RESOURCES |

---

## 1. 解压并进入项目

把下载的压缩包解压，得到 `veilyield/` 目录：

```bash
unzip veilyield.zip
cd veilyield
ls
# 应看到：contracts/ deploy/ test/ tasks/ frontend/ hardhat.config.ts package.json README.md ...
```

---

## 2. 安装依赖并编译合约

```bash
# 在 veilyield/ 根目录
npm install
```

> 这会装 Hardhat、FHEVM 插件、OpenZeppelin、ethers 等。首次安装可能要几分钟。

```bash
npm run compile
```

预期：`Compiled N Solidity files successfully`。

---

## 3. 跑测试（关键的"能否跑通"验证）

```bash
npm test
```

这会在 **FHEVM mock 运行时**执行全套测试，覆盖：完整生命周期、双用户池化（只解密聚合）、quit、dispatch 守卫、迁移。预期全部 **passing**。

> 这一步就是"代码能跑通"的证明。mock 运行时不需要任何外部网络或测试币。

---

## 4. （可选）本地节点 + 部署

开两个终端：

```bash
# 终端 1：启动本地 FHEVM 节点
npm run node
```

```bash
# 终端 2：部署到本地
npm run deploy:local
```

部署脚本会打印路由器地址，并把地址写入 `deployments/addresses.31337.json` 和 `frontend/src/lib/addresses.json`。

---

## 5. 部署到 Sepolia 测试网

### 5.1 配置环境变量
```bash
cp .env.example .env
```
编辑 `.env`，填入：
- `MNEMONIC`：你的 12 词助记词（**仅用于 Sepolia 测试，用一个一次性的，别用有真实资产的**）。
- `SEPOLIA_RPC_URL`：Sepolia RPC 端点（公共的已预填，但 Alchemy/Infura 的专用 key 更稳定，见 PREP_AND_RESOURCES）。
- `ETHERSCAN_API_KEY`：可选，用于合约验证。

### 5.2 确保部署钱包有 Sepolia ETH
该助记词派生的第一个地址需要一点 Sepolia ETH 付 gas。领取方式见 PREP_AND_RESOURCES。

### 5.3 部署
```bash
npm run deploy:sepolia
```
预期：依次部署 MockUSDC、两个金库、cUSDC、两个机密份额代币、路由器，注册两个金库，并把地址写入前端。记下打印的**路由器地址**。

### 5.4 （可选）验证合约
```bash
npx hardhat verify --network sepolia <路由器地址> <minBatchAge参数,如60>
```

---

## 6. 运行前端 dApp

```bash
cd frontend
cp .env.example .env        # 可选：填专用 RPC
npm install
npm run dev
```
打开终端打印的 `localhost` 地址。然后：

1. **Connect wallet**（MetaMask 切到 Sepolia）。
2. **Faucet**：铸造并 wrap 100 cUSDC。
3. 选一个金库 → 填金额 → **Encrypt & join batch**。
4. **Dispatch batch**（过了 minBatchAge 后）。
5. 等几秒网关结算 → **Claim**。
6. 试 **Migrate** 把仓位迁到另一个金库（仍然加密）。
7. 点任意加密余额的 **•••••• reveal** 揭示明文（会签一个 EIP-712 请求）。

### 6.1 不想跑前端？用 CLI 演示
```bash
npx hardhat vy:faucet  --amount 100 --network sepolia
npx hardhat vy:join    --vault 1 --amount 40 --network sepolia
npx hardhat vy:dispatch --batch 1 --network sepolia
npx hardhat vy:claim   --batch 1 --network sepolia
npx hardhat vy:balance --network sepolia
```

---

## 7. 如果编译/运行报错——排查与回退

代码按官方当前 API 手写。若本机编译报错，大概率是**依赖版本漂移**（FHEVM/OZ 是快速迭代的 0.x）。按以下顺序排查：

### 7.1 锁定 FHEVM 模板版本（最稳妥）
若 `@fhevm/solidity` 或 `@fhevm/hardhat-plugin` 的最新版与本项目 `package.json` 不兼容：
```bash
# 用官方模板的当前版本号覆盖
npm view @fhevm/solidity version
npm view @fhevm/hardhat-plugin version
# 把 package.json 里对应版本改成上面输出的版本，再 npm install
```

### 7.2 OpenZeppelin 版本
本项目用 `@openzeppelin/contracts@^5.2.0`。`forceApprove`、`Ownable2Step`、`ReentrancyGuard` 都在 v5。若你装到 v4，把版本固定到 `^5.2.0`。

### 7.3 `forceApprove` 不存在
极少数 OZ 版本里是 `SafeERC20.forceApprove`。本项目已 `using SafeERC20 for IERC20`，所以 `asset.forceApprove(spender, amt)` 应可用。若报错，替换为 `asset.approve(spender, amt)`（mock 场景安全）。

### 7.4 `evmVersion` 问题
`hardhat.config.ts` 已设 `evmVersion: "cancun"`。若你的工具链不支持，改成 `"paris"` 重试。

### 7.5 前端 SDK 导入名
若 `@zama-fhe/relayer-sdk` 的导出名有变（如 `createInstance`/`SepoliaConfig`），以 `npm view @zama-fhe/relayer-sdk` 和官方 Relayer SDK 文档为准微调 `frontend/src/lib/fhe.ts` 的导入。核心调用（`createEncryptedInput().add64().encrypt()`、`userDecrypt`）是稳定的。

### 7.6 终极回退
克隆官方 `git clone https://github.com/zama-ai/fhevm-hardhat-template`，把本项目的 `contracts/`、`deploy/`、`test/`、`tasks/` 拷进去，复用模板的 `package.json` 与 `hardhat.config.ts`（只需把网络/插件配置合并）。这样能保证依赖与官方完全一致。

---

## 8. 推送到 GitHub

### 8.1 初始化仓库
```bash
# 在 veilyield/ 根目录
git init
git add .
git commit -m "VeilYield — confidential composable yield router (Zama S3 Builder Track)"
```

> `.gitignore` 已配置：`node_modules/`、`.env`、`frontend/.env`、构建产物都不会被提交。**确认 `.env` 没被提交**（`git status` 里不应出现）。

### 8.2 在 GitHub 建仓库并推送
1. 去 https://github.com/new 建一个空仓库（不要勾 README，因为本地已有）。
2. 按 GitHub 给的命令推送：
```bash
git remote add origin https://github.com/<你的用户名>/veilyield.git
git branch -M main
git push -u origin main
```

### 8.3 提交前自检
- [ ] `npm test` 在本机通过。
- [ ] 已部署到 Sepolia，记下路由器地址。
- [ ] README 里填上你的在线 demo 链接（如部署了前端）和仓库链接。
- [ ] `.env` **没有**被提交（敏感信息）。
- [ ] 3 分钟真人视频已录、已上传（YouTube/Loom）。
- [ ] X thread 已发，tag @zama + #ZamaDeveloperProgram。

### 8.4 部署前端到公网（可选但强烈建议，评委要"working demo deployed on a website"）
最简单用 Vercel：
```bash
cd frontend
npm run build        # 产物在 frontend/dist
# 然后把 frontend 目录连到 Vercel（vercel.com，import 你的 GitHub 仓库，
# 设置 root 为 frontend，build 命令 npm run build，输出 dist）
```
注意：前端的 `addresses.json` 必须是你 Sepolia 部署后的真实地址（部署脚本已自动写入，记得把更新后的文件一起提交）。

---

## 9. 提交到 Zama 表单

最终在 https://forms.zama.org/developer-program-mainnet-season3-builder-track 提交：
- **GitHub 仓库链接**
- **在线 demo 链接**（Vercel 部署的前端）
- **3 分钟真人视频链接**
- **X thread/文章链接**
- 项目描述（用开发文档第 1 部分的定位 + 第 8 部分的评分对照浓缩）

---

## 附：常用命令速查

```bash
npm install              # 装依赖
npm run compile          # 编译合约
npm test                 # 跑测试（mock）
npm run test:sepolia     # 跑测试（真实加密）
npm run deploy:local     # 部署到本地
npm run deploy:sepolia   # 部署到 Sepolia
npm run node             # 本地 FHEVM 节点
cd frontend && npm run dev   # 跑前端
```
