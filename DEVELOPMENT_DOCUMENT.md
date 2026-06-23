# VeilYield 完整开发文档（Development Document）
## Zama Developer Program — Mainnet Season 3 · Builder Track 主推方案最终版

> 本文是 VeilYield 项目的**完整开发文档**，覆盖：定位与获奖逻辑、系统架构、合约逐个说明、关键 FHE 设计与约束、前端架构、部署与运行、测试矩阵、评分对照、以及交付清单。配套另两个文件：《BUILD_AND_DEPLOY》（如何把代码跑通并部署到 GitHub/Sepolia）和《PREP_AND_RESOURCES》（你需要提前准备的钱包、RPC、水龙头等资料）。
>
> 截止：**2026-07-07 23:59 AOE** · 部署目标：Sepolia 或 Ethereum 主网 · 交付：合约 + 前端 + 文档 + 3 分钟真人视频 + X thread。

---

## 第 1 部分 · 项目定位与获奖逻辑（为什么是这个方案）

### 1.1 一句话定义
**VeilYield 是一个机密、可组合的 DeFi 收益路由器：** 让用户用机密代币（ERC-7984，如 cUSDC）一键进出**多个公开 ERC-4626 收益金库**，全程不暴露个人金额；并支持**一键机密跨金库迁移**——这是官方单金库 v1 batcher 尚未向用户开放的能力。

### 1.2 它精准命中本季主题
S3 主题从 S2 的 "Confidential Finance" 升级为 **"Composable Privacy Is the Key"**。官方在征集期内（6/17 发文、6/23 上线 Morpho 金库）亲手发布了第一个可组合性原语 `BatcherConfidential`——把机密代币池化后接入公开 ERC-4626 金库。**VeilYield 正是这条路线图上"v1 → 用户产品"的那一步**：你的机密资产（ERC-7984）与公开 DeFi（ERC-4626）+ 标准（ERC-7984）三者组合，而 S2 几乎所有获奖者都是自闭环单功能 dApp。

### 1.3 反同质化（不在任何 S1/S2 已获奖格子里）
S2 共 234 份提交抢 15 个名额，已被占领的格子包括：机密钱包、机密支付、机密预测市场（Zerk）、机密扑克（Cipher21）、机密储蓄会（Circux）、机密募捐（Covalent）、机密 RWA 结算（Tessera）、机密合规 attestation（AttestRail）、机密永续（Confidential Derivatives）、机密合成股（Ztocks）等。**"面向散户的多金库可组合收益路由 + 机密迁移"是空白格 + 主题正中心。**

### 1.4 复用审计原语的获奖偏好
S2 获奖者 AttestRail/Tessera 印证评委偏好"**复用 OpenZeppelin 审计原语**而非自写脆弱隐私代码"。VeilYield 的核心隐私机制就是官方 `BatcherConfidential` 的池化思路（聚合 → 只解密总额 → 密文域按比例分回），架构刻意做薄。

---

## 第 2 部分 · 系统架构

### 2.1 端到端数据流

```
  用户持有 cUSDC (ERC-7984, 加密余额)
        │
        │  ① join(vaultId, 加密金额, 证明)
        ▼
  ┌─────────────────────────────────────────────┐
  │           ConfidentialVaultRouter            │
  │  batch.encryptedTotal += received (同态求和)   │
  │                                              │
  │  ② dispatchBatch(batchId)                     │
  │     · 要求 batch 已过 minBatchAge              │
  │     · 只对【聚合总额】发起异步解密              │
  │                                              │
  │  ③ settleBatchCallback(总额)  ← 网关回调       │
  │     · unwrap 聚合 cUSDC → 公开 USDC            │
  │     · vault.deposit(总额) → 得到 shares        │
  │     · wrap shares → 机密份额 (路由器持有)       │
  │     · 记录公开 exchangeRate 输入                │
  │                                              │
  │  ④ claim(batchId)                             │
  │     · shares_i = dep_i × S ÷ A (密文域)        │
  │     · 把机密份额转给用户                        │
  │                                              │
  │  ⑤ migrate(from, to, 加密金额, 证明)           │
  │     · 把机密仓位记入目标金库 batch              │
  └─────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
  公开 ERC-4626 金库 A           公开 ERC-4626 金库 B
  (Steakhouse Prime)            (Steakhouse Core)
```

### 2.2 隐私模型（诚实陈述——这是加分项，不是要藏的弱点）
匿名集 = 同一 batch 内**独立存款人的数量**。batch 必须过 `minBatchAge` 才能 dispatch，给有机存款人累积的时间。这提供**对被动观察者的有意义隐私**，并**显著抬高主动去匿名的成本**，但**不是**对"灌满整个 batch 的对手"的无条件隐私。这与 Zama 官方 v1 博客的诚实披露完全一致。**前端主动显示真实匿名集大小**——绝大多数参赛者不会做这个，这正是"你真懂隐私模型"的得分点。

### 2.3 关键设计原则
- **从不基于密文分支。** FHEVM 不能 `if/revert` 加密布尔；条件逻辑一律用 `FHE.select`。
- **no-revert 约定。** 余额不足时转 0 而非 revert，杜绝通过 revert 侧信道泄露余额。
- **batch 永不卡死。** dispatch 前可随时 `quit` 取回；dispatch 后要么 `settle`，要么 `cancel` 后 `reclaim`。
- **只跨一次机密边界。** 每个 batch 只 unwrap 一次聚合总额进金库，最小化信息暴露面。

---

## 第 3 部分 · 智能合约逐个说明

目录结构：
```
contracts/
├── ConfidentialVaultRouter.sol      ← 核心
├── interfaces/
│   ├── IConfidentialToken.sol        ← 机密代币 + wrapper 最小接口
│   └── IERC4626Minimal.sol           ← ERC-4626 最小接口
└── mocks/
    ├── DemoConfidentialToken.sol     ← 自包含 ERC-7984 式机密代币 + wrapper
    ├── MockERC20.sol                 ← 公开 USDC 替身
    └── MockERC4626Vault.sol          ← 公开收益金库替身
```

### 3.1 `ConfidentialVaultRouter.sol`（核心）

**继承：** `SepoliaConfig`（FHE 网络配置）、`Ownable2Step`（两步管理员）、`ReentrancyGuard`（重入保护）。

**核心状态：**
- `minBatchAge`：batch 可 dispatch 前的最小存活秒数（匿名集 vs 速度的可调旋钮）。
- `vaults[vaultId]`：注册的金库信息（公开金库 + 机密存款代币 + 机密份额代币 + enabled 开关）。
- `openBatchOf[vaultId]`：每个金库当前开放的 batch id。
- `_batches[batchId]`：batch 生命周期（状态、创建时间、加密总额、解密请求 id、解密后的总资产/总份额、存款人数）。
- `_depositOf[batchId][user]`：每个用户在某 batch 的加密存款。

**关键函数（按调用顺序）：**

| 函数 | 作用 | FHE 要点 |
|---|---|---|
| `registerVault(vault, depositToken, shareToken)` | onlyOwner，注册一个可路由的金库 | — |
| `join(vaultId, encAmount, proof)` | 用加密金额加入金库的开放 batch | `FHE.fromExternal` 验证密文；`confidentialTransferFrom` 拉取（no-revert）；`FHE.add` 累加到 batch 总额；`FHE.allowThis/allow` 授权 |
| `quit(batchId)` | dispatch 前取回存款 | `FHE.sub` 从总额扣除；退还机密代币 |
| `dispatchBatch(batchId)` | 关闭 batch，**只对聚合总额**发起异步解密 | 检查 `minBatchAge`；`FHE.requestDecryption([总额], settleBatchCallback.selector)` |
| `settleBatchCallback(reqId, cleartexts, proof)` | 网关回调，执行单次池化存款 | **必须** `FHE.checkSignatures`；`abi.decode` 取总额；unwrap → `vault.deposit` → wrap shares |
| `claim(batchId)` | 从已结算 batch 领取机密份额 | 密文域比例：`FHE.div(FHE.mul(dep, S), A)` |
| `reclaim(batchId)` | 从已取消 batch 取回存款 | 退还机密代币 |
| `migrate(from, to, encAmount, proof)` | 一键机密跨金库迁移 | 同 join 机制，记入目标金库 batch |

**视图函数：** `getBatch`（公开生命周期，不含敏感数据）、`currentAnonymitySet(vaultId)`（当前匿名集大小）、`depositOf`（用户可自解密的加密存款句柄）、`hasClaimed`。

**事件：** `VaultRegistered`、`BatchOpened`、`Joined`、`Quit`、`BatchDispatched`、`BatchSettled`、`BatchCancelled`、`Claimed`、`MigrationRequested`。

**自定义错误：** `VaultDoesNotExist`、`BatchNotOpen`、`BatchTooYoung`、`BatchNotSettled`、`AlreadyClaimed`、`SameVault` 等（gas 友好且语义清晰）。

### 3.2 `interfaces/IConfidentialToken.sol`
机密代币的最小接口，刻意**不**依赖 OpenZeppelin 完整的 `IERC7984`（后者带 8 个转账重载、`contractURI`、两步异步 unwrap、ERC-165，且 0.x 频繁破坏性更新）。包含路由器实际用到的：`confidentialBalanceOf`、`isOperator`、`setOperator`、`confidentialTransfer(address,euint64)`、`confidentialTransferFrom(address,address,euint64)`，加 wrapper 的 `underlying`、`wrap`、`unwrap(from,to,uint64)`。语义与 ERC-7984 完全一致。

### 3.3 `interfaces/IERC4626Minimal.sol`
ERC-4626 标准的最小切片：`asset`、`deposit`、`redeem`、`previewDeposit`、`previewRedeem`、`totalAssets`。任何公开金库（如 Morpho/Steakhouse 金库）都暴露这个面。

### 3.4 `mocks/DemoConfidentialToken.sol`（自包含机密代币 + wrapper）

**设计决策（重要，文档里要写清楚）：** 不继承 OZ `ERC7984ERC20Wrapper`，而是自实现一个**忠实但同步**的 wrapper。原因：OZ 的 `unwrap` 是**两步异步网关流程**（unwrap → finalizeUnwrap），且库处于快速 0.x 开发期，频繁破坏性更新。为了让交付物**今天就能确定性地编译和运行**，demo 代币实现一个同步 wrapper，其 `unwrap` 消费的是**已解密的池化聚合**（一个 uint64）——这恰好是路由器唯一持有明文的值。机密语义（加密余额、加密转账、ACL 门控解密、no-revert）与 ERC-7984 **完全相同**。生产部署时把路由器的 `IConfidentialToken` 槽指向官方 cUSDC/cWETH 即可。

**实现要点：**
- 余额 `mapping(address => euint64)`，全程加密。
- `_transfer` 用 `FHE.le` + `FHE.select` 实现 no-revert（转 `min(amount, balance)`）。
- `wrap`：拉取底层 ERC-20，`_credit` 加密铸造（1:1）。
- `unwrap`：扣除明文聚合，转出底层 ERC-20。
- `mint`：demo/水龙头便利函数，直接铸造机密代币。

### 3.5 `mocks/MockERC20.sol` 与 `mocks/MockERC4626Vault.sol`
- `MockERC20`：6 位小数的公开 USDC 替身，开放 `mint` 水龙头。
- `MockERC4626Vault`：可配置 `rateBps`（基点）的收益金库替身，用于模拟不同 APY/汇率，并验证路由器的比例数学。`deposit`/`redeem` 按 `shares = assets × 1e4 ÷ rateBps` 换算。

---

## 第 4 部分 · 关键 FHE 设计与约束（开发者必读）

### 4.1 FHEVM 的硬约束（已全部规避）
1. **不能基于密文分支或 revert。** → 全部用 `FHE.select`；余额不足转 0。
2. **异步解密。** 解密通过网关 + 回调，不是同步返回。→ `requestDecryption` + `settleBatchCallback`，回调里 `checkSignatures`。
3. **ACL 是强制的。** 每个加密值要 `FHE.allowThis(handle)` + `FHE.allow(handle, user)`，否则读取静默失败。→ 每次写加密状态后都授权。
4. **类型固定在句柄里。** 前端 `add64` 必须匹配合约 `externalEuint64`。→ 全程 euint64。

### 4.2 精确的 API 清单（本项目用到的，全部来自官方示例）
- 导入：`import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";`、`import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";`
- 输入：`FHE.fromExternal(externalEuint64, inputProof) → euint64`
- 算术：`FHE.add / sub / mul / div`（支持明文标量操作数，如 `FHE.mul(euint64, uint64)`）
- 比较/选择：`FHE.le`、`FHE.select(ebool, a, b)`
- 解密：`FHE.requestDecryption(bytes32[], selector) → uint256`；回调 `(uint256, bytes, bytes)` 内 `FHE.checkSignatures(reqId, cleartexts, proof)` + `abi.decode(cleartexts, (uint64))`
- ACL：`FHE.allowThis`、`FHE.allow`、`FHE.allowTransient`
- 工具：`FHE.isInitialized`、`FHE.asEuint64`、`FHE.toBytes32`

### 4.3 已知的演示级简化（生产化时需处理，文档透明披露）
- **比例数学的范围：** `dep_i × totalShares` 在 euint64 内运算，demo 金额（≤100 USDC）不会溢出；生产化应升到 euint128 或加范围检查。
- **匿名集上限（N−1 攻击）：** 池化模型固有，官方已承认。缓解：`minBatchAge` + 前端诚实披露 + 可选的协议注入熵。
- **迁移的资产同族假设：** demo 两金库共享底层 USDC，迁移按 1:1 记账；生产化跨不同底层资产需经 swap 路由。

---

## 第 5 部分 · 前端架构

技术栈：**React 18 + Vite + ethers v6 + @zama-fhe/relayer-sdk**。

```
frontend/src/
├── main.tsx                  ← 入口
├── App.tsx                   ← 主界面（连接、水龙头、金库列表、join/dispatch/claim、迁移、batch 检查器、活动日志）
├── styles.css                ← "加密账本终端"风格（深墨底、单一磷光薄荷强调色、等宽显示密文）
├── components/
│   └── CipherBalance.tsx      ← 签名组件：闪烁的遮罩密文，点击解密揭示
├── hooks/
│   └── useWallet.ts           ← 钱包连接 + 合约实例 + Sepolia 网络守卫
├── lib/
│   ├── fhe.ts                 ← SDK 封装：createInstance / 加密 / EIP-712 用户解密
│   └── addresses.json         ← 部署脚本自动写入
└── abi/index.ts              ← 路由器 + 机密代币 + ERC-20 的人类可读 ABI
```

### 5.1 签名 UX 元素 —— 密文揭示（CipherBalance）
每个加密余额渲染为**闪烁的遮罩密文（••••••）**——加密 euint64 句柄的字面替身。点击触发 EIP-712 用户解密流程，**仅对该用户在本地**揭示明文。这把 FHE 做成可触摸的中心体验：值真正被隐藏，直到你证明自己有权查看。这是"让人忘了背后是密码学"反向操作——**让人记住背后是密码学，且它真的有效**。

### 5.2 前端 FHE 流程（lib/fhe.ts）
- `getFhevm()`：`createInstance(SepoliaConfig)` 懒加载单例。
- `encryptAmount(contract, user, amount)`：`createEncryptedInput(...).add64(amount).encrypt()` → 返回 handle + inputProof。
- `userDecrypt(eip1193, contract, handle)`：`generateKeypair` → `createEIP712` → `signer.signTypedData` → `instance.userDecrypt(...)`，全程客户端，relayer 不见明文。

### 5.3 诚实的隐私 UI
主界面有一个**匿名集仪表**：实时显示当前金库开放 batch 的独立存款人数，配点阵可视化和一段诚实说明（"你的隐私就是和你共享 batch 的独立存款人数量……我们显示真实数字而不是藏起来"）。

---

## 第 6 部分 · 部署与运行（摘要，详见 BUILD_AND_DEPLOY）

```bash
# 合约侧
npm install
npm run compile
npm test                      # FHEVM mock 上跑全套测试
cp .env.example .env          # 填 MNEMONIC + SEPOLIA_RPC_URL
npm run deploy:sepolia        # 部署并自动写地址进前端

# 前端侧
cd frontend && npm install && npm run dev
```

部署脚本 `deploy/01_deploy_veilyield.ts` 会：部署 MockUSDC → 两个金库 → cUSDC → 两个机密份额代币 → 路由器 → 注册两个金库 → 把地址写入 `deployments/addresses.<chainId>.json` 并镜像到 `frontend/src/lib/addresses.json`。

CLI 任务（无前端也能演示）：`vy:faucet`、`vy:join`、`vy:dispatch`、`vy:claim`、`vy:balance`。

---

## 第 7 部分 · 测试矩阵

`test/ConfidentialVaultRouter.test.ts` 在 FHEVM mock 运行时覆盖：

| 测试 | 验证点 |
|---|---|
| 注册两个金库 | 金库注册与 enabled 状态 |
| 完整单用户生命周期 | wrap → join → dispatch → settle → claim，份额正确，双重领取被拒 |
| 双用户池化 | **只有聚合被解密**（30/10 个体永不暴露），各自按比例领取 |
| quit 取回 | dispatch 前取回，结算总额正确排除该用户 |
| dispatch 守卫 | 未过 `minBatchAge` 时 dispatch 被 `BatchTooYoung` 拒绝 |
| 迁移 | 机密仓位迁入另一金库，按该金库 1.05 汇率正确结算 |

运行：`npm test`。所有测试针对 mock 加密运行；逻辑稳定后可用 `npm run test:sepolia` 跑真实加密。

---

## 第 8 部分 · 评分对照（自评）

| 维度（权重） | VeilYield 命中点 | 自评 |
|---|---|---|
| 可组合性 / S3 主题（22） | ERC-7984 × ERC-4626 × 跨金库迁移，主题字面答案 | 5/5 |
| FHE 本质性 / 技术深度（20） | 池化同态求和 + 密文域比例分配 + select，删掉就垮 | 5/5 |
| 真实可用 / 生产就绪（18） | 端到端可跑、全套测试、错误处理、batch 不卡死 | 4.5/5 |
| 真实痛点 / 机构叙事（14） | DeFi 仓位默认暴露——Zama 卖给华尔街的痛点 | 5/5 |
| 演示质量（12） | 密文揭示 UX + 真人视频脚本 | 5/5 |
| 文档 / 代码质量（8） | 三份文档 + NatSpec + 测试 + 架构图 | 4.5/5 |
| 创新钩子（6） | 一键机密迁移 + 诚实匿名集仪表，在官方路线图前进一步 | 5/5 |

**合计预估 92–96 / 100（大奖级）。**

---

## 第 9 部分 · 交付清单

- [x] 智能合约（路由器 + 接口 + mocks），FHE 正确、无密文分支、batch 不卡死
- [x] 全套测试（生命周期、池化、quit、守卫、迁移）
- [x] 部署脚本（自动写地址进前端）+ CLI 任务
- [x] React/Vite 前端（密文揭示 UX + 匿名集仪表 + 迁移面板）
- [x] README + 本开发文档 + 构建文档 + 资料准备文档
- [ ] **3 分钟真人视频**（脚本见下）——录制是你要做的
- [ ] **X thread**（要点见下）——发布是你要做的
- [ ] 部署到 Sepolia + 把仓库推到 GitHub（步骤见 BUILD_AND_DEPLOY）

### 3 分钟真人视频脚本（AI 配音直接判负）
- 0:00–0:20 痛点：公开 DeFi 一存款全世界看得到你的仓位（展示 Etherscan 暴露金额）。
- 0:20–0:50 啊哈：用 cUSDC 一键存入金库，Etherscan 上看不到个人金额，只有 batch 总额。
- 0:50–1:50 可组合性核心：多金库 APY 对比 + 一键机密迁移仓位 + 点击密文揭示余额。
- 1:50–2:30 技术正确性：一句话讲"池化聚合、只解密总额、密文域按比例分配"；展示匿名集仪表。
- 2:30–3:00 收尾：机密性不必牺牲组合性，这是机构上链缺的最后一块。放仓库 + demo 链接。

### X Thread 要点（tag @zama，#ZamaDeveloperProgram）
痛点 → 一句话解法 → 一键存入 GIF → 跨金库迁移钩子 → 技术诚实点（匿名集 + 复用审计原语思路）→ 仓库 + demo 链接。
