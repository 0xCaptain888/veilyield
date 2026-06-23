// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC4626Minimal} from "../interfaces/IERC4626Minimal.sol";

/**
 * @title MockERC4626Vault
 * @notice A minimal ERC-4626-style yield vault standing in for a public vault such as a
 *         Morpho/Steakhouse vault. It mints share tokens 1:1 against deposited assets at a
 *         configurable rate (in basis points of 1e4) so tests can model differing APYs/exchange
 *         rates between vaults and exercise the router's pro-rata math.
 *
 * @dev    The vault's SHARE token here is itself an ERC-20 (this contract). The router wraps that
 *         share ERC-20 into a confidential share token so users hold encrypted share balances.
 *         shares = assets * 1e4 / rateBps ; assets = shares * rateBps / 1e4.
 */
contract MockERC4626Vault is ERC20, IERC4626Minimal {
    using SafeERC20 for IERC20;

    IERC20 private immutable _asset;
    uint256 public rateBps; // 1e4 == 1.0 (1 asset -> 1 share). >1e4 means shares worth more.

    constructor(IERC20 asset_, string memory name_, string memory symbol_, uint256 rateBps_)
        ERC20(name_, symbol_)
    {
        _asset = asset_;
        rateBps = rateBps_ == 0 ? 10_000 : rateBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    /// @notice Owner-free knob to simulate yield accrual / differing vault performance.
    function setRateBps(uint256 newRateBps) external {
        require(newRateBps > 0, "rate=0");
        rateBps = newRateBps;
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return (assets * 10_000) / rateBps;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return (shares * rateBps) / 10_000;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        shares = previewDeposit(assets);
        _mint(receiver, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        if (owner != msg.sender) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        assets = previewRedeem(shares);
        _asset.safeTransfer(receiver, assets);
    }

    function totalAssets() external view returns (uint256) {
        return _asset.balanceOf(address(this));
    }
}
