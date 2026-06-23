// Minimal human-readable ABIs for the contracts the frontend calls.
// (ethers v6 accepts human-readable ABI fragments directly.)

export const ROUTER_ABI = [
  "function join(uint256 vaultId, bytes32 encryptedAmount, bytes inputProof) returns (uint256 batchId)",
  "function quit(uint256 batchId)",
  "function dispatchBatch(uint256 batchId)",
  "function claim(uint256 batchId)",
  "function reclaim(uint256 batchId)",
  "function migrate(uint256 fromVaultId, uint256 toVaultId, bytes32 encryptedAmount, bytes inputProof) returns (uint256 toBatchId)",
  "function openBatchOf(uint256 vaultId) view returns (uint256)",
  "function currentAnonymitySet(uint256 vaultId) view returns (uint32)",
  "function vaultCount() view returns (uint256)",
  "function minBatchAge() view returns (uint64)",
  "function depositOf(uint256 batchId, address user) view returns (bytes32)",
  "function hasClaimed(uint256 batchId, address user) view returns (bool)",
  "function getBatch(uint256 batchId) view returns (uint256 vaultId, uint8 status, uint64 createdAt, uint64 readyAt, uint32 depositorCount, uint64 clearTotalAssets, uint64 clearTotalShares)",
  "event Joined(uint256 indexed batchId, address indexed user)",
  "event BatchDispatched(uint256 indexed batchId, uint256 indexed vaultId, uint256 requestId)",
  "event BatchSettled(uint256 indexed batchId, uint256 indexed vaultId, uint64 totalAssets, uint64 totalShares)",
  "event MigrationRequested(address indexed user, uint256 indexed fromVaultId, uint256 indexed toVaultId, uint256 toBatchId)",
];

export const CTOKEN_ABI = [
  "function confidentialBalanceOf(address account) view returns (bytes32)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function setOperator(address operator, uint48 until)",
  "function wrap(address to, uint256 amount)",
  "function underlying() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

export const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
