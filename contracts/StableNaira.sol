// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
  StableNaira (BEP-20 - Binance Smart Chain)
  - Centralized & compliance-enabled model: owner manages minter addresses, vaults or multisigs.
  - Users can burn their tokens (to redeem off-chain).
  - Pausable and ownership control included.
  - Freeze, unfreeze, and seize funds
  - Block transfers based on lawful authority orders
*/

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract StableNaira is ERC20, Pausable, Ownable {
    // role: minters allowed to mint tokens
    mapping(address => bool) public minters;

    // freeze list (cannot send or receive)
    mapping(address => bool) public frozen;

    // optional on-chain metadata
    string public constant VERSION = "1.0";

    // Events
    event MinterAdded(address indexed account);
    event MinterRemoved(address indexed account);
    event RedeemRequested(address indexed account, uint256 amount, string offChainReference);
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event FundsSeized(address indexed from, address indexed to, uint256 amount);


    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(_msgSender()) {
        minters[_msgSender()] = true;
        emit MinterAdded(_msgSender());
    }

    // ---- Modifiers ----
    modifier onlyMinter() {
        require(minters[_msgSender()], "StableNaira: caller is not a minter");
        _;
    }

    modifier notFrozen(address account) {
        require(!frozen[account], "StableNaira: account frozen");
        _;
    }

    // ---- Minter management (onlyOwner) ----
    function addMinter(address account) external onlyOwner {
        require(account != address(0), "StableNaira: zero address");
        require(!minters[account], "StableNaira: already minter");
        minters[account] = true;
        emit MinterAdded(account);
    }

    function removeMinter(address account) external onlyOwner {
        require(minters[account], "StableNaira: not a minter");
        minters[account] = false;
        emit MinterRemoved(account);
    }

    // ---- Mint / Burn ----
    /// Mints tokens to `to`. Called by off-chain treasury/minter
    /// after receiving fiat/crypto collateral.
    function mint(address to, uint256 amount) external onlyMinter whenNotPaused returns (bool) {
        require(to != address(0), "StableNaira: mint to zero address");
        _mint(to, amount);
        return true;
    }

    /// Burn own tokens (user burns tokens to redeem off-chain).
    /// The off-chain redemption system should watch for burn events (or call redeemRequest).
    function burn(uint256 amount) external whenNotPaused {
        _burn(_msgSender(), amount);
    }

    /// Admin/burn: burn on behalf of a user (e.g., to finalize forced redemption).
    function burnFrom(address account, uint256 amount) external onlyMinter whenNotPaused {
        // If allowance model is desired:
        // _spendAllowance(account, _msgSender(), amount);
        // For centralized flows: allows minters burn without allowance.
        _burn(account, amount);
    }

    // ---- Redeem request helper ----
    /// Users can emit a redeem request with an off-chain reference.
    /// Off-chain system watches this event and processes redemption (fiat/crypto wire).
    function redeemRequest(uint256 amount, string calldata offChainReference) external whenNotPaused {
        // Todo: Lock tokens by burning immediately (reduces supply) OR keep them and mark pending off-chain.
        // Burn immediately to reflect supply reduction.
        _burn(_msgSender(), amount);
        emit RedeemRequested(_msgSender(), amount, offChainReference);
    }

    // ---- Freeze Controls (onlyOwner) ----
    /// Freeze an address (cannot send or receive tokens)
    function freezeAddress(address account) external onlyOwner {
        require(!frozen[account], "StableNaira: already frozen");
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    /// Unfreeze an address
    function unfreezeAddress(address account) external onlyOwner {
        require(frozen[account], "StableNaira: not frozen");
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    // ---- Seize Funds (onlyOwner) ----
    /// Seize `amount` tokens from `from` and send to `to` (lawful authority wallet)
    function seizeFunds(address from, address to, uint256 amount) external onlyOwner {
        require(from != address(0), "StableNaira: invalid from");
        require(to != address(0), "StableNaira: invalid to");
        require(balanceOf(from) >= amount, "StableNaira: insufficient balance");

        _transfer(from, to, amount);

        emit FundsSeized(from, to, amount);
    }

    // ---- Pausable controls (onlyOwner) ----
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function decimals() public pure override returns (uint8) {
        return 2; // smallest unit = 0.01 StableNaira (1 Kobo)
    }

    // ---- Transfer Hook with Freeze Enforcement ----
    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        // Skip checks when minting or burning
        if (from != address(0)) require(!frozen[from], "StableNaira: sender frozen");
        if (to != address(0)) require(!frozen[to], "StableNaira: recipient frozen");

        super._update(from, to, value);
    }

}
