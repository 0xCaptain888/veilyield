// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title IConfidentialToken
 * @notice The exact slice of the ERC-7984 confidential-token surface that the VeilYield router
 *         depends on, plus the ERC-20 wrap/unwrap surface of a confidential wrapper.
 *
 * @dev    This is intentionally a minimal, self-contained interface rather than OpenZeppelin's
 *         full IERC7984 / IERC7984ERC20Wrapper. The OZ interfaces carry many additional members
 *         (eight transfer permutations, contractURI, confidentialTotalSupply, ERC-165, a two-step
 *         async unwrap, etc.) and are under rapid 0.x development. Pinning to this minimal surface
 *         keeps the router decoupled from that churn while remaining 100% semantically faithful to
 *         ERC-7984: encrypted euint64 balances, encrypted transfers, ACL-gated decryption, and the
 *         "no revert on insufficient balance, transfer 0" convention.
 *
 *         A production deployment would point these at the official Zama confidential wrappers
 *         (cUSDC, cWETH, ...) which expose the same confidentialTransfer / confidentialTransferFrom
 *         / confidentialBalanceOf / setOperator / isOperator behavior.
 */
interface IConfidentialToken {
    // --- ERC-7984 core (subset used by the router) ---

    function confidentialBalanceOf(address account) external view returns (euint64);

    function isOperator(address holder, address spender) external view returns (bool);

    function setOperator(address operator, uint48 until) external;

    /// @notice Transfer an already-ACL-allowed encrypted amount. Returns amount actually moved.
    function confidentialTransfer(address to, euint64 amount) external returns (euint64 transferred);

    /// @notice Operator transfer of an already-ACL-allowed encrypted amount. Returns amount moved.
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 amount
    ) external returns (euint64 transferred);

    // --- ERC-20 wrapper surface (subset used by the router) ---

    /// @notice The public ERC-20 token underlying this confidential wrapper.
    function underlying() external view returns (address);

    /// @notice Wrap `amount` of the underlying ERC-20 (pulled from caller) into confidential tokens
    ///         credited to `to`.
    function wrap(address to, uint256 amount) external;

    /// @notice Unwrap a cleartext `amount` (the decrypted pool aggregate) of confidential tokens
    ///         held by `from`, sending the underlying ERC-20 to `to`.
    function unwrap(address from, address to, uint64 amount) external;
}
