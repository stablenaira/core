// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title StableNairaPriceOracle
/// @notice Signed-quorum NGN/USD price oracle. Reporters off-chain produce
///         ECDSA signatures over `(chainId, oracle, roundId, price, timestamp)`;
///         anyone can submit a quorum of distinct sigs to advance the round.
///
///         Uses `Ownable2Step` so a fat-fingered ownership transfer cannot
///         brick the oracle (the new owner must `acceptOwnership`).
contract StableNairaPriceOracle is Ownable2Step {
    using ECDSA for bytes32;

    struct Round {
        uint256 roundId;
        uint256 price;
        uint256 timestamp;
    }

    /* --------------------------- bounds --------------------------- */

    /// @notice Lower / upper bounds for the staleness window.
    uint256 public constant MIN_STALENESS_SEC = 30;
    uint256 public constant MAX_STALENESS_SEC = 1 hours;

    /// @notice Lower / upper bounds for the deviation cap. 1e9 == 100%.
    uint256 public constant MIN_DEVIATION_PPB = 1_000_000;       // 0.1%
    uint256 public constant MAX_DEVIATION_PPB = 1_000_000_000;   // 100%

    /* --------------------------- state ---------------------------- */

    uint8 public immutable decimals;
    uint256 public latestRoundId;
    mapping(uint256 => Round) public rounds;

    // Reporter set: O(1) membership via mapping; canonical list via array.
    mapping(address => bool) public isReporter;
    address[] public reporters;
    uint256 public activeReporterCount;
    uint256 public quorum;

    // Configuration.
    uint256 public maxStalenessSec = 900;        // 15 minutes
    uint256 public maxDeviationPPB = 20_000_000; // 2%

    /* --------------------------- events --------------------------- */

    event ReporterAdded(address indexed reporter);
    event ReporterRemoved(address indexed reporter);
    event QuorumUpdated(uint256 previous, uint256 current);
    event MaxStalenessUpdated(uint256 previous, uint256 current);
    event MaxDeviationPPBUpdated(uint256 previous, uint256 current);
    event PriceSubmitted(
        uint256 indexed roundId,
        uint256 price,
        uint256 timestamp,
        address indexed submittedBy
    );

    /* --------------------------- errors --------------------------- */

    error InvalidQuorum();
    error ZeroReporter();
    error ReporterAlreadyExists();
    error ReporterMissing();
    error QuorumExceedsActive(uint256 quorum, uint256 active);
    error WouldDropBelowQuorum(uint256 active, uint256 quorum);
    error StalenessOutOfRange(uint256 attempted, uint256 min, uint256 max);
    error DeviationOutOfRange(uint256 attempted, uint256 min, uint256 max);
    error PriceZero();
    error StaleOrFuture();
    error RoundOrder();
    error InvalidSig();
    error NotReporter(address signer);
    error UnorderedSigs();
    error DeviationTooLarge(uint256 ppb, uint256 max);
    error NotEnoughSigs();

    constructor(
        uint8 _decimals,
        address[] memory initialReporters,
        uint256 _quorum
    ) Ownable(msg.sender) {
        if (_quorum == 0) revert InvalidQuorum();

        decimals = _decimals;

        for (uint256 i = 0; i < initialReporters.length; i++) {
            address r = initialReporters[i];
            if (r == address(0)) revert ZeroReporter();
            if (!isReporter[r]) {
                isReporter[r] = true;
                reporters.push(r);
                activeReporterCount += 1;
                emit ReporterAdded(r);
            }
        }

        if (_quorum > activeReporterCount) {
            revert QuorumExceedsActive(_quorum, activeReporterCount);
        }
        quorum = _quorum;

        emit QuorumUpdated(0, _quorum);
        emit MaxStalenessUpdated(0, maxStalenessSec);
        emit MaxDeviationPPBUpdated(0, maxDeviationPPB);
    }

    /* ---------------------- owner-only management ----------------- */

    function addReporter(
        address r
    ) external onlyOwner {
        if (r == address(0)) revert ZeroReporter();
        if (isReporter[r]) revert ReporterAlreadyExists();
        isReporter[r] = true;
        reporters.push(r);
        activeReporterCount += 1;
        emit ReporterAdded(r);
    }

    /// @notice Remove a reporter. Reverts if doing so would drop the active
    ///         count below `quorum` — operator must lower quorum first.
    function removeReporter(
        address r
    ) external onlyOwner {
        if (!isReporter[r]) revert ReporterMissing();
        if (activeReporterCount - 1 < quorum) {
            revert WouldDropBelowQuorum(activeReporterCount - 1, quorum);
        }
        isReporter[r] = false;
        activeReporterCount -= 1;
        // Swap-and-pop from `reporters[]` so the canonical list stays in sync.
        uint256 len = reporters.length;
        for (uint256 i = 0; i < len; ++i) {
            if (reporters[i] == r) {
                reporters[i] = reporters[len - 1];
                reporters.pop();
                break;
            }
        }
        emit ReporterRemoved(r);
    }

    function setQuorum(
        uint256 q
    ) external onlyOwner {
        if (q == 0) revert InvalidQuorum();
        if (q > activeReporterCount) revert QuorumExceedsActive(q, activeReporterCount);
        emit QuorumUpdated(quorum, q);
        quorum = q;
    }

    function setMaxStaleness(
        uint256 sec_
    ) external onlyOwner {
        if (sec_ < MIN_STALENESS_SEC || sec_ > MAX_STALENESS_SEC) {
            revert StalenessOutOfRange(sec_, MIN_STALENESS_SEC, MAX_STALENESS_SEC);
        }
        emit MaxStalenessUpdated(maxStalenessSec, sec_);
        maxStalenessSec = sec_;
    }

    function setMaxDeviationPPB(
        uint256 ppb
    ) external onlyOwner {
        if (ppb < MIN_DEVIATION_PPB || ppb > MAX_DEVIATION_PPB) {
            revert DeviationOutOfRange(ppb, MIN_DEVIATION_PPB, MAX_DEVIATION_PPB);
        }
        emit MaxDeviationPPBUpdated(maxDeviationPPB, ppb);
        maxDeviationPPB = ppb;
    }

    /* ---------------------- price submission ---------------------- */

    function _reportHash(
        uint256 roundId,
        uint256 price,
        uint256 timestamp
    ) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), roundId, price, timestamp));
    }

    /// @notice Submit a signed report. Signatures MUST be ordered strictly
    ///         ascending by recovered signer address, and there must be at
    ///         least `quorum` of them, all from active reporters.
    function submitReport(
        uint256 roundId,
        uint256 price,
        uint256 timestamp,
        bytes[] calldata sigs
    ) external {
        if (price == 0) revert PriceZero();
        if (timestamp > block.timestamp || block.timestamp - timestamp > maxStalenessSec) {
            revert StaleOrFuture();
        }
        if (roundId <= latestRoundId) revert RoundOrder();

        bytes32 h = MessageHashUtils.toEthSignedMessageHash(_reportHash(roundId, price, timestamp));

        uint256 valid = 0;
        address lastSigner = address(0);

        for (uint256 i = 0; i < sigs.length; i++) {
            // ECDSA.tryRecover enforces low-s and rejects malleable / non-canonical
            // signatures — replaces raw `ecrecover` from the prior implementation.
            (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(h, sigs[i]);
            if (err != ECDSA.RecoverError.NoError || signer == address(0)) revert InvalidSig();
            if (!isReporter[signer]) revert NotReporter(signer);
            if (signer <= lastSigner) revert UnorderedSigs();
            lastSigner = signer;
            valid++;
        }

        if (valid < quorum) revert NotEnoughSigs();

        if (latestRoundId > 0) {
            uint256 prev = rounds[latestRoundId].price;
            uint256 diff = price > prev ? price - prev : prev - price;
            uint256 ppb = (diff * 1e9) / prev;
            if (ppb > maxDeviationPPB) revert DeviationTooLarge(ppb, maxDeviationPPB);
        }

        latestRoundId = roundId;
        rounds[roundId] = Round(roundId, price, timestamp);
        emit PriceSubmitted(roundId, price, timestamp, msg.sender);
    }

    /* --------------------------- views ---------------------------- */

    function getLatestPrice() external view returns (uint256 price, uint256 ts, uint256 roundId) {
        Round memory r = rounds[latestRoundId];
        return (r.price, r.timestamp, r.roundId);
    }

    /// @notice Returns the canonical list of reporter addresses currently in
    ///         the set. After MED-01 fix, this list contains only active reporters.
    function getReporters() external view returns (address[] memory) {
        return reporters;
    }
}
