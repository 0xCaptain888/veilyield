// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

/**
 * @title IERC4626Minimal
 * @notice The minimal slice of the ERC-4626 tokenized-vault standard the router needs.
 *         Any public yield vault (e.g. a Morpho/Steakhouse vault) exposes this surface.
 */
interface IERC4626Minimal {
    /// @notice The underlying asset managed by the vault (e.g. USDC).
    function asset() external view returns (address);

    /// @notice Deposit `assets` of the underlying, minting shares to `receiver`.
    /// @return shares The amount of vault shares minted.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /// @notice Redeem `shares`, sending the underlying assets to `receiver`.
    /// @return assets The amount of underlying assets returned.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    /// @notice Preview how many shares a deposit of `assets` would mint.
    function previewDeposit(uint256 assets) external view returns (uint256 shares);

    /// @notice Preview how many assets a redemption of `shares` would return.
    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    /// @notice Current total assets under management (used for APY display off-chain).
    function totalAssets() external view returns (uint256);
}
