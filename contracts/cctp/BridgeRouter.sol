// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IBridgeRouter} from "./interfaces/IBridgeRouter.sol";
import {IMessageTransmitter} from "./interfaces/IMessageTransmitter.sol";
import {IStableNairaMintable} from "./interfaces/IStableNairaMintable.sol";
import {BurnBody} from "./libraries/BurnBody.sol";

/**
 * @title BridgeRouter
 * @notice Source-side burn + destination-side mint for StableNaira cross-chain
 *         transfers. Implements `IMessageHandler` so the local
 *         MessageTransmitter can dispatch verified messages to it.
 *
 * Deployment expectations:
 *  - This contract holds `MINTER_ROLE` on the local StableNaira token
 *    (needed for both `burnFrom` and `mint`).
 *  - The local MessageTransmitter is configured with this contract as its
 *    `handler`.
 *  - Users pre-approve this contract for the amount they wish to bridge, or
 *    use `permit` via a helper off-chain.
 */
contract BridgeRouter is
    Initializable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IBridgeRouter
{
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    address public override token;
    address public override transmitter;

    struct RateLimit {
        uint64 windowStart;
        uint64 windowSec;
        uint256 minted;
        uint256 cap;
    }

    RateLimit public globalLimit;
    mapping(uint32 => RateLimit) public domainLimit;

    /// @dev Allowlist of remote BridgeRouters per source domain.
    ///      Stored as bytes32 to accommodate non-EVM later.
    mapping(uint32 => bytes32) public remoteRouter;

    uint256[44] private __gap;

    event RemoteRouterUpdated(uint32 indexed domain, bytes32 router);

    error NotTransmitter();
    error UnknownRemoteRouter();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address governor,
        address pauser,
        address token_,
        address transmitter_
    ) public initializer {
        __AccessControlEnumerable_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        if (token_ == address(0) || transmitter_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, governor);
        _grantRole(PAUSER_ROLE, pauser);

        token = token_;
        transmitter = transmitter_;
    }

    // ---- Governance ----

    function setRemoteRouter(uint32 domain, bytes32 router) external onlyRole(GOVERNOR_ROLE) {
        remoteRouter[domain] = router;
        emit RemoteRouterUpdated(domain, router);
    }

    function setGlobalMintCap(uint64 windowSec, uint256 cap) external onlyRole(GOVERNOR_ROLE) {
        globalLimit.windowSec = windowSec;
        globalLimit.cap = cap;
        globalLimit.windowStart = 0;
        globalLimit.minted = 0;
        emit GlobalMintCapUpdated(windowSec, cap);
    }

    function setDomainMintCap(uint32 domain, uint64 windowSec, uint256 cap)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        RateLimit storage l = domainLimit[domain];
        l.windowSec = windowSec;
        l.cap = cap;
        l.windowStart = 0;
        l.minted = 0;
        emit DomainMintCapUpdated(domain, windowSec, cap);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---- User: source side ----

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient
    ) external whenNotPaused returns (uint64 nonce) {
        if (amount == 0) revert ZeroAmount();
        if (mintRecipient == bytes32(0)) revert ZeroAddress();
        bytes32 remote = remoteRouter[destinationDomain];
        if (remote == bytes32(0)) revert UnsupportedDestination();

        IStableNairaMintable(token).burnFrom(msg.sender, amount);

        BurnBody.Body memory body = BurnBody.Body({
            burnToken: BurnBody.toBytes32(token),
            mintRecipient: mintRecipient,
            amount: amount,
            messageSender: BurnBody.toBytes32(msg.sender)
        });

        nonce = IMessageTransmitter(transmitter).sendMessage(
            destinationDomain,
            remote,
            BurnBody.encode(body)
        );

        emit DepositForBurn(nonce, token, amount, msg.sender, mintRecipient, destinationDomain);
    }

    // ---- Destination side: IMessageHandler ----

    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata body
    ) external override returns (bool) {
        if (msg.sender != transmitter) revert NotTransmitter();

        bytes32 expected = remoteRouter[sourceDomain];
        if (expected == bytes32(0) || expected != sender) revert UnknownRemoteRouter();

        BurnBody.Body memory b = BurnBody.decode(body);
        address recipient = BurnBody.toAddress(b.mintRecipient);
        if (recipient == address(0)) revert ZeroAddress();

        _checkAndUpdateRateLimits(sourceDomain, b.amount);

        IStableNairaMintable(token).mint(recipient, b.amount);

        emit MintReceived(sourceDomain, sender, recipient, b.amount);
        return true;
    }

    // ---- Internal ----

    function _checkAndUpdateRateLimits(uint32 sourceDomain, uint256 amount) internal {
        _tickLimit(globalLimit, amount);
        _tickLimit(domainLimit[sourceDomain], amount);
    }

    function _tickLimit(RateLimit storage l, uint256 amount) internal {
        if (l.cap == 0) return; // disabled
        uint64 nowTs = uint64(block.timestamp);
        if (l.windowStart == 0 || nowTs >= l.windowStart + l.windowSec) {
            l.windowStart = nowTs;
            l.minted = 0;
        }
        uint256 newTotal = l.minted + amount;
        if (newTotal > l.cap) revert CapExceeded();
        l.minted = newTotal;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
