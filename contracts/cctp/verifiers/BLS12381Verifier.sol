// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ISignatureVerifier} from "../interfaces/ISignatureVerifier.sol";

/**
 * @title BLS12381Verifier (EIP-2537)
 * @notice BLS12-381 signature verifier using EIP-2537 precompiles.
 *
 * Implements the "min-pk" BLS signature scheme:
 *   - G1 public keys (128 bytes uncompressed)
 *   - G2 signatures (256 bytes uncompressed)
 *   - Hash-to-curve: BLS12381G2_XMD:SHA-256_SSWU_RO_ (RFC 9380)
 *
 * Verification identity:
 *   e(aggPk, H(m)) == e(g1, aggSig)
 *   <=> e(-aggPk, H(m)) * e(g1, aggSig) == 1
 *
 * Implementation layout
 * ─────────────────────
 *   verifyAggregated  — orchestrator
 *     ├── _aggregateG1           (G1ADD, one pubkey at a time)
 *     ├── _negateG1              (y ← p − y in Fp)
 *     ├── hashToG2               (the full RFC 9380 suite)
 *     │     ├── expandMessageXmd (SHA-256 via 0x02)
 *     │     ├── hashToField      (modexp via 0x05, 4× Fp reductions)
 *     │     ├── mapToG2          (MAP_FP2_TO_G2 via 0x11, called twice)
 *     │     ├── G2ADD            (0x0D)
 *     │     └── _clearCofactor   (chunked G2_MSM via 0x0E)
 *     └── _pairingCheck          (PAIRING_CHECK via 0x0F)
 *
 * Configurability
 * ───────────────
 * The G2 cofactor `h` and the hash-to-curve DST are stored in contract
 * storage and set via `initialize(...)` (UUPS upgradeable). This lets us
 * ship the verifier today and re-parameterize it without redeploying every
 * downstream contract that references the proxy address.
 */
contract BLS12381Verifier is
    Initializable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable,
    ISignatureVerifier
{
    // ─────────────────────────────────────────────────────────────────
    // Precompiles (EIP-2537 / Ethereum Pectra numbering)
    // ─────────────────────────────────────────────────────────────────
    address internal constant PRECOMPILE_SHA256         = address(0x02);
    address internal constant PRECOMPILE_MODEXP         = address(0x05);
    address internal constant PRECOMPILE_G1ADD          = address(0x0B);
    address internal constant PRECOMPILE_G2ADD          = address(0x0D);
    address internal constant PRECOMPILE_G2MSM          = address(0x0E);
    address internal constant PRECOMPILE_PAIRING        = address(0x0F);
    address internal constant PRECOMPILE_MAP_FP2_TO_G2  = address(0x11);

    // ─────────────────────────────────────────────────────────────────
    // Curve constants
    // ─────────────────────────────────────────────────────────────────

    /// @dev BLS12-381 field modulus p, split into (hi 128 bits, lo 256 bits).
    uint256 internal constant P_HI = 0x1a0111ea397fe69a4b1ba7b6434bacd7;
    uint256 internal constant P_LO = 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    /// @dev The standard generator of G1 (uncompressed, 128 bytes).
    ///      x = 0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb
    ///      y = 0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1
    bytes internal constant G1_GENERATOR =
        hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"
        hex"0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";

    uint256 internal constant G1_POINT_SIZE = 128;
    uint256 internal constant G2_POINT_SIZE = 256;
    uint256 internal constant FP_SIZE       = 64;
    uint256 internal constant FP2_SIZE      = 128;
    uint256 internal constant SHA256_BLOCK  = 64;
    uint256 internal constant SHA256_OUT    = 32;

    // ─────────────────────────────────────────────────────────────────
    // Storage (UUPS layout: admin via AccessControl, plus two bytes slots)
    // ─────────────────────────────────────────────────────────────────

    /**
     * @notice G2 subgroup cofactor, big-endian, trimmed to its actual
     *         byte length (e.g. 80 bytes for BLS12-381 G2).
     *         Set at `initialize` time by the deployer; upgradeable.
     */
    bytes public cofactor;

    /**
     * @notice Hash-to-curve domain separation tag. MUST equal the DST used
     *         off-chain when signatures are produced (see
     *         `cctp-network/packages/crypto/src/bls.ts`).
     */
    bytes public dst;

    uint256[48] private __gap;

    // ─────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────

    error InvalidPublicKeyLength();
    error InvalidSignatureLength();
    error PrecompileFailed(address precompile);
    error DstTooLong();
    error ExpandTooLong();
    error CofactorNotConfigured();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, bytes calldata cofactor_, bytes calldata dst_)
        public
        initializer
    {
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (cofactor_.length == 0) revert CofactorNotConfigured();
        if (dst_.length == 0 || dst_.length > 255) revert DstTooLong();
        cofactor = cofactor_;
        dst = dst_;
    }

    function setCofactor(bytes calldata newCofactor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCofactor.length == 0) revert CofactorNotConfigured();
        cofactor = newCofactor;
    }

    function setDst(bytes calldata newDst) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newDst.length == 0 || newDst.length > 255) revert DstTooLong();
        dst = newDst;
    }

    // ─────────────────────────────────────────────────────────────────
    // ISignatureVerifier
    // ─────────────────────────────────────────────────────────────────

    /// @inheritdoc ISignatureVerifier
    function verifyAggregated(
        bytes32 messageDigest,
        bytes[] calldata publicKeys,
        bytes calldata aggregatedSignature
    ) external view override returns (bool) {
        uint256 n = publicKeys.length;
        if (n == 0) return false;
        if (aggregatedSignature.length != G2_POINT_SIZE) revert InvalidSignatureLength();
        for (uint256 i = 0; i < n; i++) {
            if (publicKeys[i].length != G1_POINT_SIZE) revert InvalidPublicKeyLength();
        }

        bytes memory aggPk = _aggregateG1(publicKeys);
        bytes memory negAggPk = _negateG1(aggPk);
        bytes memory hm = _hashToG2(messageDigest);

        return _pairingCheck(negAggPk, hm, G1_GENERATOR, aggregatedSignature);
    }

    /**
     * @notice Public view for the hash-to-G2 result. Exposed so that
     *         off-chain tooling and tests can exercise the full flow
     *         independent of a signature. Matches the reference
     *         implementation in the cctp/crypto package (noble-curves)
     *         byte-for-byte in uncompressed EIP-2537 layout.
     */
    function hashToG2(bytes32 messageDigest) external view returns (bytes memory) {
        return _hashToG2(messageDigest);
    }

    /// @notice Expose expand_message_xmd for test parity (RFC 9380 §5.3.1).
    function expandMessageXmd(bytes memory msg_, uint256 lenInBytes)
        external
        view
        returns (bytes memory)
    {
        return _expandMessageXmd(msg_, dst, lenInBytes);
    }

    // ─────────────────────────────────────────────────────────────────
    // G1 aggregation + negation
    // ─────────────────────────────────────────────────────────────────

    function _aggregateG1(bytes[] calldata pks) internal view returns (bytes memory acc) {
        acc = pks[0]; // implicit calldata -> memory copy
        uint256 n = pks.length;
        for (uint256 i = 1; i < n; i++) {
            bytes memory input = new bytes(G1_POINT_SIZE * 2);
            _memcpy(input, 0, acc, 0, G1_POINT_SIZE);
            _memcpyCalldata(input, G1_POINT_SIZE, pks[i], 0, G1_POINT_SIZE);
            acc = _callPrecompile(PRECOMPILE_G1ADD, input, G1_POINT_SIZE);
        }
    }

    function _negateG1(bytes memory point) internal pure returns (bytes memory out) {
        out = new bytes(G1_POINT_SIZE);
        _memcpy(out, 0, point, 0, FP_SIZE);
        (uint256 yHi, uint256 yLo) = _readFp(point, FP_SIZE);
        (uint256 nHi, uint256 nLo) = _subModP(P_HI, P_LO, yHi, yLo);
        _writeFp(out, FP_SIZE, nHi, nLo);
    }

    // ─────────────────────────────────────────────────────────────────
    // Hash-to-G2  (RFC 9380 §8.8.2 — BLS12381G2_XMD:SHA-256_SSWU_RO_)
    // ─────────────────────────────────────────────────────────────────

    function _hashToG2(bytes32 messageDigest) internal view returns (bytes memory) {
        // 1) u = hash_to_field(digest, count=2)  -> (u0, u1) in Fp2
        (bytes memory u0, bytes memory u1) = _hashToField(messageDigest);

        // 2) q0 = map_to_curve(u0); q1 = map_to_curve(u1)
        bytes memory q0 = _callPrecompile(PRECOMPILE_MAP_FP2_TO_G2, u0, G2_POINT_SIZE);
        bytes memory q1 = _callPrecompile(PRECOMPILE_MAP_FP2_TO_G2, u1, G2_POINT_SIZE);

        // 3) r = q0 + q1
        bytes memory r = _g2Add(q0, q1);

        // 4) p = clear_cofactor(r)
        return _clearCofactor(r);
    }

    /**
     * @dev hash_to_field(digest, count=2, m=2, L=64) for BLS12-381 G2.
     *      Produces two Fp2 elements by reducing four 64-byte chunks mod p.
     */
    function _hashToField(bytes32 messageDigest)
        internal
        view
        returns (bytes memory u0, bytes memory u1)
    {
        bytes memory msgBytes = new bytes(32);
        assembly { mstore(add(msgBytes, 32), messageDigest) }

        // len_in_bytes = count * m * L = 2 * 2 * 64 = 256
        bytes memory uniform = _expandMessageXmd(msgBytes, dst, 256);

        u0 = new bytes(FP2_SIZE);
        u1 = new bytes(FP2_SIZE);

        // u0 = (reduce(uniform[0..64]), reduce(uniform[64..128]))
        // u1 = (reduce(uniform[128..192]), reduce(uniform[192..256]))
        _reduce64ToFp(uniform, 0,   u0, 0);
        _reduce64ToFp(uniform, 64,  u0, FP_SIZE);
        _reduce64ToFp(uniform, 128, u1, 0);
        _reduce64ToFp(uniform, 192, u1, FP_SIZE);
    }

    /**
     * @dev Reduce a 64-byte big-endian integer mod p via the modexp
     *      precompile (base^1 mod p). Writes the 64-byte EIP-2537 Fp
     *      encoding (16 zero pad + 48 BE bytes) into `outFp` at `outOff`.
     */
    function _reduce64ToFp(
        bytes memory src,
        uint256 srcOff,
        bytes memory outFp,
        uint256 outOff
    ) internal view {
        // modexp input layout:
        //   baseLen (32) || expLen (32) || modLen (32) ||
        //   base (baseLen) || exp (expLen) || mod (modLen)
        // baseLen = 64, expLen = 1 (value = 1), modLen = 48
        // Output: 48 bytes (the reduction).
        bytes memory input = new bytes(32 * 3 + 64 + 1 + 48);
        // baseLen = 64
        input[31] = bytes1(uint8(64));
        // expLen = 1
        input[63] = bytes1(uint8(1));
        // modLen = 48
        input[95] = bytes1(uint8(48));
        // base: copy 64 BE bytes
        for (uint256 i = 0; i < 64; i++) input[96 + i] = src[srcOff + i];
        // exp = 1
        input[160] = bytes1(uint8(1));
        // mod = p (48 big-endian bytes)
        // p_hi (128 bits = 16 bytes) || p_lo (256 bits = 32 bytes)
        _writeUint128BE(input, 161, P_HI);
        _writeUint256BE(input, 161 + 16, P_LO);

        (bool ok, bytes memory ret) = PRECOMPILE_MODEXP.staticcall(input);
        if (!ok || ret.length != 48) revert PrecompileFailed(PRECOMPILE_MODEXP);

        // Pack into the 64-byte EIP-2537 Fp layout: 16 zero bytes + 48 BE bytes.
        for (uint256 i = 0; i < 16; i++) outFp[outOff + i] = 0;
        for (uint256 i = 0; i < 48; i++) outFp[outOff + 16 + i] = ret[i];
    }

    // ─────────────────────────────────────────────────────────────────
    // expand_message_xmd (RFC 9380 §5.3.1) over SHA-256
    // ─────────────────────────────────────────────────────────────────

    function _expandMessageXmd(bytes memory msg_, bytes memory dst_, uint256 lenInBytes)
        internal
        view
        returns (bytes memory uniform)
    {
        if (dst_.length > 255) revert DstTooLong();
        uint256 ell = (lenInBytes + SHA256_OUT - 1) / SHA256_OUT;
        if (ell > 255) revert ExpandTooLong();

        // DST_prime = dst || I2OSP(len(dst), 1)
        bytes memory dstPrime = new bytes(dst_.length + 1);
        for (uint256 i = 0; i < dst_.length; i++) dstPrime[i] = dst_[i];
        dstPrime[dst_.length] = bytes1(uint8(dst_.length));

        // msg_prime = Z_pad || msg || I2OSP(lenInBytes, 2) || I2OSP(0, 1) || DST_prime
        bytes memory msgPrime = new bytes(SHA256_BLOCK + msg_.length + 2 + 1 + dstPrime.length);
        // Z_pad is already zero-initialised.
        uint256 o = SHA256_BLOCK;
        for (uint256 i = 0; i < msg_.length; i++) msgPrime[o + i] = msg_[i];
        o += msg_.length;
        // I2OSP(lenInBytes, 2)  (big-endian)
        msgPrime[o]     = bytes1(uint8((lenInBytes >> 8) & 0xff));
        msgPrime[o + 1] = bytes1(uint8(lenInBytes & 0xff));
        o += 2;
        // I2OSP(0, 1)
        msgPrime[o] = 0;
        o += 1;
        for (uint256 i = 0; i < dstPrime.length; i++) msgPrime[o + i] = dstPrime[i];

        bytes32 b0 = _sha256(msgPrime);

        // b_1 = H(b_0 || I2OSP(1, 1) || DST_prime)
        bytes32[] memory b = new bytes32[](ell + 1);
        b[0] = b0;

        bytes memory inp = new bytes(SHA256_OUT + 1 + dstPrime.length);
        assembly { mstore(add(inp, 32), b0) }
        inp[SHA256_OUT] = bytes1(uint8(1));
        for (uint256 i = 0; i < dstPrime.length; i++) inp[SHA256_OUT + 1 + i] = dstPrime[i];
        b[1] = _sha256(inp);

        // b_i = H((b_0 XOR b_{i-1}) || I2OSP(i, 1) || DST_prime)  for i in [2, ell]
        for (uint256 i = 2; i <= ell; i++) {
            bytes32 xored = _xor32(b0, b[i - 1]);
            assembly { mstore(add(inp, 32), xored) }
            inp[SHA256_OUT] = bytes1(uint8(i));
            b[i] = _sha256(inp);
        }

        uniform = new bytes(lenInBytes);
        uint256 written = 0;
        for (uint256 i = 1; i <= ell && written < lenInBytes; i++) {
            bytes32 bi = b[i];
            for (uint256 j = 0; j < SHA256_OUT && written < lenInBytes; j++) {
                uniform[written] = bi[j];
                written++;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Cofactor clearing via chunked G2_MSM
    // ─────────────────────────────────────────────────────────────────

    /**
     * @dev Compute [h] P where h is the stored G2 cofactor.
     *
     * Strategy: G2_MSM scalars must fit in 32 bytes. The BLS12-381 G2
     * cofactor is ~638 bits long. Split into three chunks of ≤ 255 bits
     * each and sum scalar-multiples of P, P_s1 = [2^255] P, and
     * P_s2 = [2^510] P via a single batched G2_MSM call.
     *
     *   [h] P  =  c_0·P  +  c_1·P_s1  +  c_2·P_s2
     *
     * Where c_0 = h[0..255], c_1 = h[255..510], c_2 = h[510..].
     */
    function _clearCofactor(bytes memory P) internal view returns (bytes memory) {
        bytes memory h = cofactor;
        if (h.length == 0) revert CofactorNotConfigured();

        (uint256 c0, uint256 c1, uint256 c2) = _splitCofactor255(h);

        // If the cofactor fits in a single 255-bit chunk, avoid the shifts.
        if (c1 == 0 && c2 == 0) {
            return _g2msmSingle(P, c0);
        }

        uint256 scalar2_255 = (uint256(1) << 255);

        bytes memory P_s1 = _g2msmSingle(P,    scalar2_255);
        if (c2 == 0) {
            return _g2msmTwoPairs(P, c0, P_s1, c1);
        }
        bytes memory P_s2 = _g2msmSingle(P_s1, scalar2_255);
        return _g2msmThreePairs(P, c0, P_s1, c1, P_s2, c2);
    }

    /// @dev Split a big-endian bytes big-integer into three ≤ 255-bit chunks,
    ///      low-to-high.  Accepts up to 96 bytes of cofactor.
    function _splitCofactor255(bytes memory h)
        internal
        pure
        returns (uint256 c0, uint256 c1, uint256 c2)
    {
        // Convert h to (hi, mid, lo) uint256 triple, treating h as a
        // big-endian integer padded to 96 bytes.
        uint256 hLen = h.length;
        if (hLen > 96) revert CofactorNotConfigured();

        uint256 lo;
        uint256 mid;
        uint256 hi;
        // lo = h[hLen-32..hLen]
        if (hLen >= 32) {
            lo = _readUint256BE(h, hLen - 32);
            if (hLen >= 64) {
                mid = _readUint256BE(h, hLen - 64);
                if (hLen >= 96) {
                    hi = _readUint256BE(h, hLen - 96);
                } else {
                    // The top (hLen - 64) bytes as an integer left-aligned in hi.
                    hi = _readUintPartialBE(h, 0, hLen - 64);
                }
            } else {
                mid = _readUintPartialBE(h, 0, hLen - 32);
            }
        } else {
            lo = _readUintPartialBE(h, 0, hLen);
        }

        // Reinterpret as a 768-bit integer H = hi*2^512 + mid*2^256 + lo
        // and split into 255-bit chunks:
        //   c0 = H[0..255]
        //   c1 = H[255..510]
        //   c2 = H[510..765]
        uint256 MASK255 = (uint256(1) << 255) - 1;
        c0 = lo & MASK255;
        // H >> 255 = (mid * 2^256 + lo) >> 255, but mid and lo need to be combined.
        // Equivalently: c1 = ((lo >> 255) | (mid << 1)) & MASK255
        c1 = ((lo >> 255) | (mid << 1)) & MASK255;
        // H >> 510 = ((mid >> 254) | (hi << 2))
        c2 = ((mid >> 254) | (hi << 2));
    }

    function _g2msmSingle(bytes memory P, uint256 scalar) internal view returns (bytes memory) {
        bytes memory input = new bytes(G2_POINT_SIZE + 32);
        _memcpy(input, 0, P, 0, G2_POINT_SIZE);
        _writeUint256BE(input, G2_POINT_SIZE, scalar);
        return _callPrecompile(PRECOMPILE_G2MSM, input, G2_POINT_SIZE);
    }

    function _g2msmTwoPairs(
        bytes memory P0, uint256 s0,
        bytes memory P1, uint256 s1
    ) internal view returns (bytes memory) {
        uint256 pair = G2_POINT_SIZE + 32;
        bytes memory input = new bytes(pair * 2);
        _memcpy(input, 0, P0, 0, G2_POINT_SIZE);
        _writeUint256BE(input, G2_POINT_SIZE, s0);
        _memcpy(input, pair, P1, 0, G2_POINT_SIZE);
        _writeUint256BE(input, pair + G2_POINT_SIZE, s1);
        return _callPrecompile(PRECOMPILE_G2MSM, input, G2_POINT_SIZE);
    }

    function _g2msmThreePairs(
        bytes memory P0, uint256 s0,
        bytes memory P1, uint256 s1,
        bytes memory P2, uint256 s2
    ) internal view returns (bytes memory) {
        uint256 pair = G2_POINT_SIZE + 32;
        bytes memory input = new bytes(pair * 3);
        _memcpy(input, 0,          P0, 0, G2_POINT_SIZE);
        _writeUint256BE(input, G2_POINT_SIZE, s0);
        _memcpy(input, pair,       P1, 0, G2_POINT_SIZE);
        _writeUint256BE(input, pair + G2_POINT_SIZE, s1);
        _memcpy(input, pair * 2,   P2, 0, G2_POINT_SIZE);
        _writeUint256BE(input, pair * 2 + G2_POINT_SIZE, s2);
        return _callPrecompile(PRECOMPILE_G2MSM, input, G2_POINT_SIZE);
    }

    // ─────────────────────────────────────────────────────────────────
    // G2 helpers
    // ─────────────────────────────────────────────────────────────────

    function _g2Add(bytes memory a, bytes memory b) internal view returns (bytes memory) {
        bytes memory input = new bytes(G2_POINT_SIZE * 2);
        _memcpy(input, 0, a, 0, G2_POINT_SIZE);
        _memcpy(input, G2_POINT_SIZE, b, 0, G2_POINT_SIZE);
        return _callPrecompile(PRECOMPILE_G2ADD, input, G2_POINT_SIZE);
    }

    function _pairingCheck(
        bytes memory g1a,
        bytes memory g2a,
        bytes memory g1b,
        bytes calldata g2b
    ) internal view returns (bool) {
        bytes memory input = new bytes(2 * (G1_POINT_SIZE + G2_POINT_SIZE));
        uint256 off = 0;
        _memcpy(input, off, g1a, 0, G1_POINT_SIZE); off += G1_POINT_SIZE;
        _memcpy(input, off, g2a, 0, G2_POINT_SIZE); off += G2_POINT_SIZE;
        _memcpy(input, off, g1b, 0, G1_POINT_SIZE); off += G1_POINT_SIZE;
        _memcpyCalldata(input, off, g2b, 0, G2_POINT_SIZE);

        (bool ok, bytes memory ret) = PRECOMPILE_PAIRING.staticcall(input);
        if (!ok || ret.length != 32) revert PrecompileFailed(PRECOMPILE_PAIRING);
        return uint256(bytes32(ret)) == 1;
    }

    // ─────────────────────────────────────────────────────────────────
    // Primitive helpers
    // ─────────────────────────────────────────────────────────────────

    function _callPrecompile(address p, bytes memory input, uint256 outLen)
        internal
        view
        returns (bytes memory out)
    {
        (bool ok, bytes memory ret) = p.staticcall(input);
        if (!ok || ret.length != outLen) revert PrecompileFailed(p);
        return ret;
    }

    function _sha256(bytes memory input) internal view returns (bytes32 h) {
        (bool ok, bytes memory ret) = PRECOMPILE_SHA256.staticcall(input);
        if (!ok || ret.length != 32) revert PrecompileFailed(PRECOMPILE_SHA256);
        assembly { h := mload(add(ret, 32)) }
    }

    function _xor32(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return bytes32(uint256(a) ^ uint256(b));
    }

    function _memcpy(
        bytes memory dest,
        uint256 dstOffset,
        bytes memory src,
        uint256 srcOffset,
        uint256 len
    ) internal pure {
        for (uint256 i = 0; i < len; i++) {
            dest[dstOffset + i] = src[srcOffset + i];
        }
    }

    function _memcpyCalldata(
        bytes memory dest,
        uint256 dstOffset,
        bytes calldata src,
        uint256 srcOffset,
        uint256 len
    ) internal pure {
        for (uint256 i = 0; i < len; i++) {
            dest[dstOffset + i] = src[srcOffset + i];
        }
    }

    function _readFp(bytes memory src, uint256 off)
        internal
        pure
        returns (uint256 hi, uint256 lo)
    {
        bytes16 topBE;
        bytes32 botBE;
        assembly {
            topBE := mload(add(add(src, 32), add(off, 16)))
            botBE := mload(add(add(src, 32), add(off, 32)))
        }
        hi = uint128(topBE);
        lo = uint256(botBE);
    }

    function _writeFp(bytes memory dest, uint256 off, uint256 hi, uint256 lo) internal pure {
        for (uint256 i = 0; i < 16; i++) dest[off + i] = 0;
        bytes16 topBE = bytes16(uint128(hi));
        bytes32 botBE = bytes32(lo);
        assembly {
            mstore(add(add(dest, 32), add(off, 16)), topBE)
            mstore(add(add(dest, 32), add(off, 32)), botBE)
        }
    }

    function _subModP(uint256 aHi, uint256 aLo, uint256 bHi, uint256 bLo)
        internal
        pure
        returns (uint256 rHi, uint256 rLo)
    {
        if (aHi > bHi || (aHi == bHi && aLo >= bLo)) {
            unchecked {
                rLo = aLo - bLo;
                rHi = aHi - bHi - (aLo < bLo ? 1 : 0);
            }
        } else {
            uint256 dLo;
            uint256 dHi;
            unchecked {
                dLo = bLo - aLo;
                dHi = bHi - aHi - (bLo < aLo ? 1 : 0);
            }
            unchecked {
                rLo = P_LO - dLo;
                rHi = P_HI - dHi - (P_LO < dLo ? 1 : 0);
            }
        }
    }

    function _writeUint256BE(bytes memory dest, uint256 off, uint256 v) internal pure {
        for (uint256 i = 0; i < 32; i++) {
            dest[off + 31 - i] = bytes1(uint8(v & 0xff));
            v >>= 8;
        }
    }

    function _writeUint128BE(bytes memory dest, uint256 off, uint256 v) internal pure {
        for (uint256 i = 0; i < 16; i++) {
            dest[off + 15 - i] = bytes1(uint8(v & 0xff));
            v >>= 8;
        }
    }

    function _readUint256BE(bytes memory src, uint256 off) internal pure returns (uint256 v) {
        for (uint256 i = 0; i < 32; i++) {
            v = (v << 8) | uint8(src[off + i]);
        }
    }

    function _readUintPartialBE(bytes memory src, uint256 off, uint256 len)
        internal
        pure
        returns (uint256 v)
    {
        for (uint256 i = 0; i < len; i++) {
            v = (v << 8) | uint8(src[off + i]);
        }
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}
}
