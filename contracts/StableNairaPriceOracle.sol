// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract StableNairaPriceOracle is Ownable {
    using ECDSA for bytes32;

    struct Round {
        uint256 roundId;
        uint256 price;
        uint256 timestamp;
    }

    uint8 public immutable decimals;
    uint256 public latestRoundId;
    mapping(uint256 => Round) public rounds;

    // reporters management
    mapping(address => bool) public isReporter;
    address[] public reporters;
    uint256 public quorum;

    // configuration
    uint256 public maxStalenessSec = 900;
    uint256 public maxDeviationPPB = 20000000;

    event ReporterAdded(address reporter);
    event ReporterRemoved(address reporter);
    event QuorumUpdated(uint256 quorum);
    event PriceSubmitted(uint256 roundId, uint256 price, uint256 timestamp, address submittedBy);

    constructor(
    uint8 _decimals,
    address[] memory initialReporters,
    uint256 _quorum
    ) Ownable(msg.sender) {
        require(initialReporters.length >= _quorum && _quorum > 0, "invalid quorum");

        decimals = _decimals;
        quorum = _quorum;

        for (uint i = 0; i < initialReporters.length; i++) {
            address r = initialReporters[i];
            require(r != address(0), "zero reporter");
            if (!isReporter[r]) {
                isReporter[r] = true;
                reporters.push(r);
                emit ReporterAdded(r);
            }
        }
    }

    // Owner-only management
    function addReporter(address r) external onlyOwner {
        require(r != address(0), "zero");
        require(!isReporter[r], "exists");
        isReporter[r] = true;
        reporters.push(r);
        emit ReporterAdded(r);
    }

    function removeReporter(address r) external onlyOwner {
        require(isReporter[r], "missing");
        isReporter[r] = false;
        emit ReporterRemoved(r);
    }

    function setQuorum(uint256 q) external onlyOwner {
        require(q > 0, "q>0");
        quorum = q;
        emit QuorumUpdated(q);
    }

    function setMaxStaleness(uint256 sec_) external onlyOwner {
        maxStalenessSec = sec_;
    }

    function setMaxDeviationPPB(uint256 ppb) external onlyOwner {
        maxDeviationPPB = ppb;
    }

    function _reportHash(uint256 roundId, uint256 price, uint256 timestamp) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), roundId, price, timestamp));
    }

    // submit signed report with signatures array (distinct ECDSA sigs)
    function submitReport(
        uint256 roundId,
        uint256 price,
        uint256 timestamp,
        bytes[] calldata sigs
    ) external {
        require(price > 0, "price=0");
        require(timestamp <= block.timestamp && block.timestamp - timestamp <= maxStalenessSec, "stale or future");

        bytes32 h = MessageHashUtils.toEthSignedMessageHash(_reportHash(roundId, price, timestamp));

        // verify unique signers and quorum
        uint256 valid = 0;
        address lastSigner = address(0);

        for (uint i = 0; i < sigs.length; i++) {
            address signer = _recoverSigner(h, sigs[i]);
            require(signer != address(0), "invalid sig");
            require(isReporter[signer], "not reporter");
            require(signer > lastSigner, "duplicate or unordered sigs");
            lastSigner = signer;
            valid++;
        }

        require(valid >= quorum, "not enough sigs");

        // Check deviation
        if (latestRoundId > 0) {
            uint256 prev = rounds[latestRoundId].price;
            uint256 diff = (price > prev) ? price - prev : prev - price;
            uint256 ppb = (diff * 1e9) / prev;
            require(ppb <= maxDeviationPPB, "deviation too large");
        }

        // accept
        latestRoundId = roundId;
        rounds[roundId] = Round(roundId, price, timestamp);
        emit PriceSubmitted(roundId, price, timestamp, msg.sender);
    }

    function _recoverSigner(bytes32 ethSignedHash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(ethSignedHash, v, r, s);
    }

    // view helpers
    function getLatestPrice() external view returns (uint256 price, uint256 ts, uint256 roundId) {
        Round memory r = rounds[latestRoundId];
        return (r.price, r.timestamp, r.roundId);
    }

    function getReporters() external view returns (address[] memory) {
        return reporters;
    }
}
