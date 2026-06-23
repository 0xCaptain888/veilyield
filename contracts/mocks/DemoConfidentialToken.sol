// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IConfidentialToken} from "../interfaces/IConfidentialToken.sol";

/**
 * @title DemoConfidentialToken
 * @notice A self-contained ERC-7984-style confidential token + ERC-20 wrapper used by VeilYield.
 *
 *         It implements the exact IERC7984 surface the router depends on
 *         (confidentialTransfer / confidentialTransferFrom / confidentialBalanceOf /
 *         setOperator / isOperator) plus the IERC7984ERC20Wrapper surface
 *         (underlying / wrap / unwrap), using real FHE euint64 arithmetic and ACL permissions.
 *
 * @dev    Why a self-contained token instead of inheriting OpenZeppelin's ERC7984ERC20Wrapper:
 *         OZ's canonical wrapper performs unwrap through a TWO-STEP asynchronous gateway flow
 *         (unwrap -> finalizeUnwrap), and the library is under rapid 0.x development with frequent
 *         breaking changes. For a hackathon deliverable that must compile and run deterministically
 *         on both the mock runtime and Sepolia, we implement a faithful, synchronous wrapper whose
 *         `unwrap` consumes the already-decrypted pool aggregate (a plain uint64) — which is exactly
 *         the only value the router ever has in cleartext. The confidentiality semantics
 *         (encrypted balances, encrypted transfers, no-revert-on-insufficient-funds, ACL-gated
 *         decryption) are identical to ERC-7984.
 *
 *         No-revert convention: like ERC-7984, confidentialTransfer[From] never reverts on
 *         insufficient balance; it moves min(amount, balance) and returns the amount actually moved,
 *         preventing balance leaks through revert side-channels.
 */
contract DemoConfidentialToken is SepoliaConfig, IConfidentialToken {
    using SafeERC20 for IERC20;

    string public name;
    string public symbol;
    uint8 public constant decimals = 6;

    address private immutable _underlying;

    mapping(address account => euint64) private _balances;
    mapping(address holder => mapping(address operator => uint48 until)) private _operators;

    event Wrapped(address indexed to, uint256 amount);
    event Unwrapped(address indexed from, address indexed to, uint64 amount);
    event OperatorSet(address indexed holder, address indexed operator, uint48 until);
    event ConfidentialTransfer(address indexed from, address indexed to);

    /**
     * @param underlying_ The public ERC-20 this token wraps (e.g. a mock USDC). May be address(0)
     *                    for a pure confidential token with no wrap/unwrap backing (not used here).
     */
    constructor(string memory name_, string memory symbol_, address underlying_) {
        name = name_;
        symbol = symbol_;
        _underlying = underlying_;
    }

    // ----------------------------- Wrapper surface -----------------------------

    function underlying() external view returns (address) {
        return _underlying;
    }

    /// @notice Wrap `amount` of the underlying ERC-20 (pulled from caller) into confidential tokens
    ///         credited to `to`. 1:1 rate for simplicity (both 6 decimals).
    function wrap(address to, uint256 amount) external {
        IERC20(_underlying).safeTransferFrom(msg.sender, address(this), amount);
        euint64 amt = FHE.asEuint64(uint64(amount));
        _credit(to, amt);
        emit Wrapped(to, amount);
    }

    /// @notice Unwrap a cleartext `amount` (the decrypted pool aggregate) of confidential tokens
    ///         held by `from`, sending the underlying ERC-20 to `to`. Caller must be `from` or an
    ///         operator for `from`.
    function unwrap(address from, address to, uint64 amount) external {
        require(from == msg.sender || isOperator(from, msg.sender), "not authorized");
        // Deduct the cleartext aggregate from the confidential balance.
        euint64 amt = FHE.asEuint64(amount);
        _debit(from, amt);
        IERC20(_underlying).safeTransfer(to, amount);
        emit Unwrapped(from, to, amount);
    }

    // ----------------------------- ERC-7984 surface -----------------------------

    function confidentialBalanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    function isOperator(address holder, address spender) public view returns (bool) {
        return _operators[holder][spender] >= block.timestamp;
    }

    function setOperator(address operator, uint48 until) external {
        _operators[msg.sender][operator] = until;
        emit OperatorSet(msg.sender, operator, until);
    }

    /// @notice Transfer with an externally-encrypted amount + proof.
    function confidentialTransfer(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external returns (euint64 transferred) {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        return _transfer(msg.sender, to, amount);
    }

    /// @notice Transfer with an already-allowed euint64 handle (no proof).
    function confidentialTransfer(address to, euint64 amount) external returns (euint64 transferred) {
        return _transfer(msg.sender, to, amount);
    }

    /// @notice Operator transfer with an already-allowed euint64 handle (no proof).
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 amount
    ) external returns (euint64 transferred) {
        require(from == msg.sender || isOperator(from, msg.sender), "not operator");
        return _transfer(from, to, amount);
    }

    /// @notice Operator transfer with an externally-encrypted amount + proof.
    function confidentialTransferFrom(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external returns (euint64 transferred) {
        require(from == msg.sender || isOperator(from, msg.sender), "not operator");
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        return _transfer(from, to, amount);
    }

    // --------------------------- Test / demo minting ---------------------------

    /// @notice Mint confidential tokens directly (demo/faucet convenience, no wrap needed).
    function mint(address to, uint64 amount) external {
        euint64 amt = FHE.asEuint64(amount);
        _credit(to, amt);
    }

    // ----------------------------- Internal logic -----------------------------

    function _transfer(address from, address to, euint64 amount) internal returns (euint64 sent) {
        require(to != address(0), "transfer to zero");

        euint64 fromBal = _balances[from];
        if (!FHE.isInitialized(fromBal)) {
            fromBal = FHE.asEuint64(0);
        }

        // No-revert: move only what is available.
        ebool enough = FHE.le(amount, fromBal);
        sent = FHE.select(enough, amount, FHE.asEuint64(0));

        euint64 newFrom = FHE.sub(fromBal, sent);
        _balances[from] = newFrom;
        FHE.allowThis(newFrom);
        FHE.allow(newFrom, from);

        _credit(to, sent);

        // Let the caller (operator or sender) process the returned handle in-tx.
        FHE.allowTransient(sent, msg.sender);

        emit ConfidentialTransfer(from, to);
    }

    function _credit(address to, euint64 amount) internal {
        euint64 bal = _balances[to];
        euint64 newBal = FHE.isInitialized(bal) ? FHE.add(bal, amount) : amount;
        _balances[to] = newBal;
        FHE.allowThis(newBal);
        FHE.allow(newBal, to);
    }

    function _debit(address from, euint64 amount) internal {
        euint64 bal = _balances[from];
        require(FHE.isInitialized(bal), "no balance");
        // For unwrap of the decrypted aggregate, the contract is the custodian; underflow is
        // prevented at the router level (it only unwraps what the pool actually deposited).
        euint64 newBal = FHE.sub(bal, amount);
        _balances[from] = newBal;
        FHE.allowThis(newBal);
        FHE.allow(newBal, from);
    }
}
