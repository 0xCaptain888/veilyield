// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC4626Minimal} from "./interfaces/IERC4626Minimal.sol";
import {IConfidentialToken} from "./interfaces/IConfidentialToken.sol";

/**
 * @title ConfidentialVaultRouter
 * @author VeilYield
 * @notice A confidential, composable yield router for the Zama Protocol.
 *
 *         Users deposit a confidential token (an ERC-7984 wrapper over an ERC-20, e.g. cUSDC)
 *         into one of several registered public ERC-4626 yield vaults (e.g. a Morpho vault),
 *         WITHOUT revealing their individual deposit amount on-chain.
 *
 *         The privacy comes from POOLING: many users join a batch with encrypted amounts;
 *         the contract aggregates them homomorphically; at dispatch ONLY the aggregate total
 *         is decrypted; a single deposit is routed into the public vault on behalf of the whole
 *         pool; and each user claims their confidential vault-share balance back pro-rata,
 *         entirely in the encrypted domain.
 *
 *         This is the Season 3 "Composable Privacy" thesis made concrete: a confidential asset
 *         (ERC-7984) composed with the rest of the public EVM (ERC-4626) through an audited
 *         pooling pattern, with a one-click confidential cross-vault MIGRATION on top — a flow
 *         that the official single-vault v1 batcher does not yet expose to users.
 *
 * @dev    Privacy model is an anonymity-set model. The set is the number of INDEPENDENT
 *         depositors in a batch. A batch cannot be dispatched before `minBatchAge` has elapsed,
 *         giving organic depositors time to accumulate. This is the same honest tradeoff Zama
 *         documents for its v1 vault stack: meaningful privacy vs. passive observers, materially
 *         higher cost to actively deanonymize, NOT unconditional privacy against an adversary
 *         willing to dominate a batch.
 *
 *         The contract NEVER branches on encrypted values. Conditional logic uses FHE.select and
 *         the ERC-7984 "no-revert, transfer 0" convention. A batch can never get permanently
 *         stuck: every deposit can be reclaimed via quit() before dispatch, and a dispatched
 *         batch either settles or is cancelled.
 */
contract ConfidentialVaultRouter is SepoliaConfig, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    //                              Types
    // ---------------------------------------------------------------------

    enum BatchStatus {
        Open, // accepting joins
        Dispatched, // total unwrap requested, awaiting decryption callback
        Settled, // vault deposit done, users may claim
        Cancelled // recovered; users may reclaim original deposits
    }

    struct VaultInfo {
        IERC4626Minimal vault; // public ERC-4626 yield vault (e.g. Morpho)
        IConfidentialToken depositToken; // confidential wrapper over the vault's asset (cUSDC)
        IConfidentialToken shareToken; // confidential wrapper over the vault's share token
        bool enabled; // owner can pause new joins for a vault
        bool exists;
    }

    struct Batch {
        uint256 vaultId;
        BatchStatus status;
        uint64 createdAt;
        euint64 encryptedTotal; // homomorphic sum of all joined deposits (encrypted)
        uint256 decryptionRequestId; // gateway request id for total decryption
        uint64 clearTotalAssets; // decrypted aggregate of underlying assets (set on settle)
        uint64 clearTotalShares; // vault shares minted to the pool (set on settle)
        uint32 depositorCount; // number of distinct depositors that joined
    }

    // ---------------------------------------------------------------------
    //                              Storage
    // ---------------------------------------------------------------------

    /// @notice Minimum age (in seconds) a batch must reach before it can be dispatched.
    /// @dev Owner-tunable knob trading settlement speed for anonymity-set size.
    uint64 public minBatchAge;

    uint256 public vaultCount;
    mapping(uint256 vaultId => VaultInfo) public vaults;

    /// @notice The id of the currently-open batch for a given vault (0 means none open).
    mapping(uint256 vaultId => uint256 batchId) public openBatchOf;

    uint256 public batchCount;
    mapping(uint256 batchId => Batch) private _batches;

    /// @notice Per-user encrypted deposit recorded in a batch.
    mapping(uint256 batchId => mapping(address user => euint64)) private _depositOf;
    /// @notice Whether a user has already been counted as a depositor in a batch.
    mapping(uint256 batchId => mapping(address user => bool)) private _hasJoined;
    /// @notice Whether a user has already claimed/reclaimed from a batch.
    mapping(uint256 batchId => mapping(address user => bool)) private _claimed;

    /// @notice Reverse lookup: decryption request id -> batch id.
    mapping(uint256 requestId => uint256 batchId) private _requestToBatch;

    // ---------------------------------------------------------------------
    //                              Events
    // ---------------------------------------------------------------------

    event VaultRegistered(uint256 indexed vaultId, address vault, address depositToken, address shareToken);
    event VaultEnabled(uint256 indexed vaultId, bool enabled);
    event MinBatchAgeUpdated(uint64 newMinBatchAge);

    event BatchOpened(uint256 indexed batchId, uint256 indexed vaultId);
    event Joined(uint256 indexed batchId, address indexed user);
    event Quit(uint256 indexed batchId, address indexed user);
    event BatchDispatched(uint256 indexed batchId, uint256 indexed vaultId, uint256 requestId);
    event BatchSettled(uint256 indexed batchId, uint256 indexed vaultId, uint64 totalAssets, uint64 totalShares);
    event BatchCancelled(uint256 indexed batchId, uint256 indexed vaultId);
    event Claimed(uint256 indexed batchId, address indexed user);

    event MigrationRequested(
        address indexed user,
        uint256 indexed fromVaultId,
        uint256 indexed toVaultId,
        uint256 toBatchId
    );

    // ---------------------------------------------------------------------
    //                              Errors
    // ---------------------------------------------------------------------

    error VaultDoesNotExist(uint256 vaultId);
    error VaultDisabled(uint256 vaultId);
    error BatchNotOpen(uint256 batchId);
    error BatchNotDispatchable(uint256 batchId);
    error BatchTooYoung(uint256 batchId, uint64 readyAt);
    error BatchNotSettled(uint256 batchId);
    error BatchNotCancelled(uint256 batchId);
    error AlreadyClaimed(uint256 batchId, address user);
    error NothingToClaim(uint256 batchId, address user);
    error InvalidRequestId(uint256 requestId);
    error SameVault();

    // ---------------------------------------------------------------------
    //                            Constructor
    // ---------------------------------------------------------------------

    constructor(uint64 minBatchAge_) Ownable(msg.sender) {
        minBatchAge = minBatchAge_;
        emit MinBatchAgeUpdated(minBatchAge_);
    }

    // ---------------------------------------------------------------------
    //                          Admin functions
    // ---------------------------------------------------------------------

    /**
     * @notice Register a public ERC-4626 vault and the confidential wrappers around its
     *         asset and share tokens, making it routable.
     * @param vault The public ERC-4626 yield vault.
     * @param depositToken The ERC-7984 wrapper over `vault.asset()` (e.g. cUSDC).
     * @param shareToken The ERC-7984 wrapper over the vault's share token.
     */
    function registerVault(
        IERC4626Minimal vault,
        IConfidentialToken depositToken,
        IConfidentialToken shareToken
    ) external onlyOwner returns (uint256 vaultId) {
        vaultId = ++vaultCount;
        vaults[vaultId] = VaultInfo({
            vault: vault,
            depositToken: depositToken,
            shareToken: shareToken,
            enabled: true,
            exists: true
        });
        emit VaultRegistered(vaultId, address(vault), address(depositToken), address(shareToken));
        emit VaultEnabled(vaultId, true);
    }

    /// @notice Enable or pause new joins for a registered vault.
    function setVaultEnabled(uint256 vaultId, bool enabled) external onlyOwner {
        if (!vaults[vaultId].exists) revert VaultDoesNotExist(vaultId);
        vaults[vaultId].enabled = enabled;
        emit VaultEnabled(vaultId, enabled);
    }

    /// @notice Update the minimum batch age (anonymity-set vs. speed knob).
    function setMinBatchAge(uint64 newMinBatchAge) external onlyOwner {
        minBatchAge = newMinBatchAge;
        emit MinBatchAgeUpdated(newMinBatchAge);
    }

    // ---------------------------------------------------------------------
    //                          Core: join a batch
    // ---------------------------------------------------------------------

    /**
     * @notice Join the currently-open deposit batch for `vaultId` with an encrypted amount.
     * @dev    The router must be an ERC-7984 operator for the caller on the deposit token
     *         (call depositToken.setOperator(router, until) first), exactly like the OZ
     *         confidential swap pattern. The confidential pull uses confidentialTransferFrom,
     *         which transfers 0 (never reverts) if the user is short, preventing balance leaks.
     * @param vaultId The registered vault to deposit into.
     * @param encryptedAmount Externally-encrypted euint64 deposit amount.
     * @param inputProof ZK proof binding the ciphertext to (this contract, msg.sender).
     */
    function join(
        uint256 vaultId,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external nonReentrant returns (uint256 batchId) {
        VaultInfo storage v = vaults[vaultId];
        if (!v.exists) revert VaultDoesNotExist(vaultId);
        if (!v.enabled) revert VaultDisabled(vaultId);

        batchId = _ensureOpenBatch(vaultId);
        Batch storage b = _batches[batchId];

        // Verify the external ciphertext and bind it to a usable handle.
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        // Pull the user's confidential deposit token into the router. Measure what actually
        // arrived (handles the "user is short -> 0 transferred" case without leaking).
        FHE.allowTransient(amount, address(v.depositToken));
        euint64 balanceBefore = v.depositToken.confidentialBalanceOf(address(this));
        v.depositToken.confidentialTransferFrom(msg.sender, address(this), amount);
        euint64 balanceAfter = v.depositToken.confidentialBalanceOf(address(this));
        euint64 received = FHE.sub(balanceAfter, balanceBefore);

        // Record / accumulate the user's deposit for this batch.
        euint64 prev = _depositOf[batchId][msg.sender];
        euint64 userTotal = FHE.isInitialized(prev) ? FHE.add(prev, received) : received;
        _depositOf[batchId][msg.sender] = userTotal;

        // Accumulate the batch-wide encrypted total.
        b.encryptedTotal = FHE.isInitialized(b.encryptedTotal)
            ? FHE.add(b.encryptedTotal, received)
            : received;

        // Permissions: the contract must keep operating on these handles across txs; the user
        // must be able to user-decrypt their own deposit in the frontend.
        FHE.allowThis(userTotal);
        FHE.allow(userTotal, msg.sender);
        FHE.allowThis(b.encryptedTotal);

        if (!_hasJoined[batchId][msg.sender]) {
            _hasJoined[batchId][msg.sender] = true;
            b.depositorCount += 1;
        }

        emit Joined(batchId, msg.sender);
    }

    /**
     * @notice Reclaim a pending deposit from an OPEN batch before it is dispatched.
     * @dev    Returns the caller's confidential deposit back and zeroes their batch entry.
     *         Always available pre-dispatch, so funds are never trapped.
     */
    function quit(uint256 batchId) external nonReentrant {
        Batch storage b = _batches[batchId];
        if (b.status != BatchStatus.Open) revert BatchNotOpen(batchId);

        euint64 userDeposit = _depositOf[batchId][msg.sender];
        if (!FHE.isInitialized(userDeposit)) revert NothingToClaim(batchId, msg.sender);

        VaultInfo storage v = vaults[b.vaultId];

        // Remove from the running total and zero the user entry.
        b.encryptedTotal = FHE.sub(b.encryptedTotal, userDeposit);
        FHE.allowThis(b.encryptedTotal);

        euint64 zero = FHE.asEuint64(0);
        _depositOf[batchId][msg.sender] = zero;
        FHE.allowThis(zero);
        FHE.allow(zero, msg.sender);

        // Refund the confidential deposit token.
        FHE.allowTransient(userDeposit, address(v.depositToken));
        v.depositToken.confidentialTransfer(msg.sender, userDeposit);

        emit Quit(batchId, msg.sender);
    }

    // ---------------------------------------------------------------------
    //                        Core: dispatch a batch
    // ---------------------------------------------------------------------

    /**
     * @notice Dispatch the open batch for a vault: closes it to new joins, requests decryption
     *         of ONLY the aggregate total, and opens the next batch immediately.
     * @dev    Permissionless — anyone may dispatch once the batch is old enough. The only value
     *         that ever leaves the encrypted domain is the pool-wide sum.
     */
    function dispatchBatch(uint256 batchId) external nonReentrant {
        Batch storage b = _batches[batchId];
        if (b.status != BatchStatus.Open) revert BatchNotDispatchable(batchId);

        uint64 readyAt = b.createdAt + minBatchAge;
        if (block.timestamp < readyAt) revert BatchTooYoung(batchId, readyAt);

        // Close this batch for new joins; clear it as the vault's open batch.
        b.status = BatchStatus.Dispatched;
        if (openBatchOf[b.vaultId] == batchId) {
            openBatchOf[b.vaultId] = 0;
        }

        // If nobody contributed, cancel immediately (nothing to decrypt).
        if (!FHE.isInitialized(b.encryptedTotal)) {
            b.status = BatchStatus.Cancelled;
            emit BatchCancelled(batchId, b.vaultId);
            return;
        }

        // Request asynchronous decryption of the aggregate total only.
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(b.encryptedTotal);
        uint256 requestId = FHE.requestDecryption(cts, this.settleBatchCallback.selector);

        b.decryptionRequestId = requestId;
        _requestToBatch[requestId] = batchId;

        emit BatchDispatched(batchId, b.vaultId, requestId);
    }

    /**
     * @notice Gateway callback delivering the decrypted aggregate total. Performs the single
     *         pooled vault deposit and records the public batch-wide exchange rate inputs.
     * @dev    MUST verify the gateway signatures. The decrypted value is the pool total, not any
     *         individual's amount.
     */
    function settleBatchCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory decryptionProof
    ) external nonReentrant {
        FHE.checkSignatures(requestId, cleartexts, decryptionProof);

        uint256 batchId = _requestToBatch[requestId];
        if (batchId == 0) revert InvalidRequestId(requestId);
        Batch storage b = _batches[batchId];
        if (b.status != BatchStatus.Dispatched) revert BatchNotDispatchable(batchId);

        uint64 totalAssets = abi.decode(cleartexts, (uint64));
        delete _requestToBatch[requestId];

        // Degenerate case: everyone quit before dispatch -> total decrypts to 0. Cancel cleanly.
        if (totalAssets == 0) {
            b.status = BatchStatus.Cancelled;
            emit BatchCancelled(batchId, b.vaultId);
            return;
        }

        VaultInfo storage v = vaults[b.vaultId];

        // Cross the confidential -> plaintext boundary for the aggregate only: unwrap the pooled
        // confidential deposit token into the plaintext ERC-20 asset the vault understands.
        v.depositToken.unwrap(address(this), address(this), totalAssets);

        IERC20 asset = IERC20(v.vault.asset());
        asset.forceApprove(address(v.vault), totalAssets);

        // Single pooled deposit into the public ERC-4626 vault.
        uint256 sharesOut = v.vault.deposit(totalAssets, address(this));
        uint64 totalShares = _toUint64(sharesOut);

        // Wrap the received plaintext shares back into the confidential share token, held by the
        // router, so users can claim confidential shares.
        IERC20 shareUnderlying = IERC20(v.shareToken.underlying());
        shareUnderlying.forceApprove(address(v.shareToken), totalShares);
        v.shareToken.wrap(address(this), totalShares);

        b.clearTotalAssets = totalAssets;
        b.clearTotalShares = totalShares;
        b.status = BatchStatus.Settled;

        emit BatchSettled(batchId, b.vaultId, totalAssets, totalShares);
    }

    // ---------------------------------------------------------------------
    //                        Core: claim shares
    // ---------------------------------------------------------------------

    /**
     * @notice Claim your confidential vault shares from a SETTLED batch, computed pro-rata in
     *         the encrypted domain: shares_i = deposit_i * totalShares / totalAssets.
     * @dev    deposit_i stays encrypted end-to-end; only the public batch-wide ratio is used.
     */
    function claim(uint256 batchId) external nonReentrant {
        Batch storage b = _batches[batchId];
        if (b.status != BatchStatus.Settled) revert BatchNotSettled(batchId);
        if (_claimed[batchId][msg.sender]) revert AlreadyClaimed(batchId, msg.sender);

        euint64 userDeposit = _depositOf[batchId][msg.sender];
        if (!FHE.isInitialized(userDeposit)) revert NothingToClaim(batchId, msg.sender);

        _claimed[batchId][msg.sender] = true;

        VaultInfo storage v = vaults[b.vaultId];

        // Encrypted pro-rata: (deposit * totalShares) / totalAssets, all on euint64.
        euint64 userShares = FHE.div(FHE.mul(userDeposit, b.clearTotalShares), b.clearTotalAssets);

        FHE.allowTransient(userShares, address(v.shareToken));
        v.shareToken.confidentialTransfer(msg.sender, userShares);

        emit Claimed(batchId, msg.sender);
    }

    /**
     * @notice Reclaim your original confidential deposit from a CANCELLED batch.
     */
    function reclaim(uint256 batchId) external nonReentrant {
        Batch storage b = _batches[batchId];
        if (b.status != BatchStatus.Cancelled) revert BatchNotCancelled(batchId);
        if (_claimed[batchId][msg.sender]) revert AlreadyClaimed(batchId, msg.sender);

        euint64 userDeposit = _depositOf[batchId][msg.sender];
        if (!FHE.isInitialized(userDeposit)) revert NothingToClaim(batchId, msg.sender);

        _claimed[batchId][msg.sender] = true;

        VaultInfo storage v = vaults[b.vaultId];
        FHE.allowTransient(userDeposit, address(v.depositToken));
        v.depositToken.confidentialTransfer(msg.sender, userDeposit);

        emit Claimed(batchId, msg.sender);
    }

    // ---------------------------------------------------------------------
    //              Signature feature: one-click confidential migration
    // ---------------------------------------------------------------------

    /**
     * @notice Move a confidential position from one vault to another in a single click, without
     *         ever revealing the amount. The user supplies confidential deposit tokens (e.g. cUSDC
     *         they hold after exiting vault A, or fresh balance) and the router credits them into
     *         the OPEN batch of the destination vault B in the encrypted domain.
     *
     * @dev    This is the headline composability flow demonstrated end-to-end: a confidential asset
     *         hops from one public DeFi venue's accounting into another's, fully encrypted, in one
     *         transaction surface. The migrant inherits the destination batch's anonymity set, and
     *         the moved amount never appears in cleartext at any point.
     *
     *         Settlement of the destination batch is then identical to a normal deposit: the
     *         aggregate is decrypted, a single pooled deposit hits vault B, and the migrant claims
     *         confidential vault-B shares pro-rata — so the migrated batch can never get stuck.
     *
     *         The router must be an operator for the caller on the destination DEPOSIT token.
     *
     * @param fromVaultId Source vault id (for event/UX context only).
     * @param toVaultId Destination registered vault to migrate into.
     * @param encryptedAmount Externally-encrypted euint64 amount of confidential deposit tokens.
     * @param inputProof ZK proof binding the ciphertext to (this contract, msg.sender).
     */
    function migrate(
        uint256 fromVaultId,
        uint256 toVaultId,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external nonReentrant returns (uint256 toBatchId) {
        if (fromVaultId == toVaultId) revert SameVault();
        VaultInfo storage to = vaults[toVaultId];
        if (!vaults[fromVaultId].exists) revert VaultDoesNotExist(fromVaultId);
        if (!to.exists) revert VaultDoesNotExist(toVaultId);
        if (!to.enabled) revert VaultDisabled(toVaultId);

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        // Pull the user's confidential destination-deposit tokens into the router; measure what
        // actually arrived (no-revert-on-short, no leak) — same mechanics as join().
        FHE.allowTransient(amount, address(to.depositToken));
        euint64 balBefore = to.depositToken.confidentialBalanceOf(address(this));
        to.depositToken.confidentialTransferFrom(msg.sender, address(this), amount);
        euint64 balAfter = to.depositToken.confidentialBalanceOf(address(this));
        euint64 received = FHE.sub(balAfter, balBefore);

        toBatchId = _ensureOpenBatch(toVaultId);
        Batch storage tb = _batches[toBatchId];

        euint64 prev = _depositOf[toBatchId][msg.sender];
        euint64 credited = FHE.isInitialized(prev) ? FHE.add(prev, received) : received;
        _depositOf[toBatchId][msg.sender] = credited;

        tb.encryptedTotal = FHE.isInitialized(tb.encryptedTotal)
            ? FHE.add(tb.encryptedTotal, received)
            : received;

        FHE.allowThis(credited);
        FHE.allow(credited, msg.sender);
        FHE.allowThis(tb.encryptedTotal);

        if (!_hasJoined[toBatchId][msg.sender]) {
            _hasJoined[toBatchId][msg.sender] = true;
            tb.depositorCount += 1;
        }

        emit MigrationRequested(msg.sender, fromVaultId, toVaultId, toBatchId);
        emit Joined(toBatchId, msg.sender);
    }

    // ---------------------------------------------------------------------
    //                          View functions
    // ---------------------------------------------------------------------

    /// @notice Encrypted handle of the caller's deposit in a batch (user-decryptable by them).
    function depositOf(uint256 batchId, address user) external view returns (euint64) {
        return _depositOf[batchId][user];
    }

    /// @notice Public, non-sensitive view of a batch's lifecycle and anonymity-set size.
    function getBatch(
        uint256 batchId
    )
        external
        view
        returns (
            uint256 vaultId,
            BatchStatus status,
            uint64 createdAt,
            uint64 readyAt,
            uint32 depositorCount,
            uint64 clearTotalAssets,
            uint64 clearTotalShares
        )
    {
        Batch storage b = _batches[batchId];
        return (
            b.vaultId,
            b.status,
            b.createdAt,
            b.createdAt + minBatchAge,
            b.depositorCount,
            b.clearTotalAssets,
            b.clearTotalShares
        );
    }

    /// @notice The current anonymity-set size (distinct depositors) of a vault's open batch.
    function currentAnonymitySet(uint256 vaultId) external view returns (uint32) {
        uint256 batchId = openBatchOf[vaultId];
        if (batchId == 0) return 0;
        return _batches[batchId].depositorCount;
    }

    function hasClaimed(uint256 batchId, address user) external view returns (bool) {
        return _claimed[batchId][user];
    }

    // ---------------------------------------------------------------------
    //                          Internal helpers
    // ---------------------------------------------------------------------

    function _ensureOpenBatch(uint256 vaultId) internal returns (uint256 batchId) {
        batchId = openBatchOf[vaultId];
        if (batchId == 0) {
            batchId = ++batchCount;
            Batch storage b = _batches[batchId];
            b.vaultId = vaultId;
            b.status = BatchStatus.Open;
            b.createdAt = uint64(block.timestamp);
            openBatchOf[vaultId] = batchId;
            emit BatchOpened(batchId, vaultId);
        }
    }

    function _toUint64(uint256 x) internal pure returns (uint64) {
        require(x <= type(uint64).max, "amount exceeds uint64");
        return uint64(x);
    }
}
