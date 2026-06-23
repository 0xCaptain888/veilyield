// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice A plain, mintable ERC-20 used as the public asset/share underlying in tests and on
 *         Sepolia. Six decimals to mirror USDC-like confidential tokens.
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Open faucet mint for demo purposes.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
