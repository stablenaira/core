# Integrating with StableNaira (`SNR`)

Reference for anything that reads or writes the token: bridges, exchanges,
wallets, payment rails, indexers.

Always integrate against the **ERC1967 proxy address**, never the
implementation. The implementation address changes on every upgrade.

---

## Basics

| | |
|---|---|
| Standard | ERC20 + [EIP-2612 `permit`](https://eips.ethereum.org/EIPS/eip-2612) |
| **Decimals** | **2** |
| `VERSION` | `"2.0"` |
| Upgradeability | UUPS behind ERC1967 — the address is stable, the code is not |

> **Two decimals, not eighteen.** ₦1.00 is `100` base units. This is the single
> most common integration mistake: an amount computed as `1e18` is
> ₦10,000,000,000,000,000, and a UI that assumes 18 decimals will display every
> balance as effectively zero. Read `decimals()` — do not hardcode.

Balances, transfers, allowances and `permit` behave exactly as standard ERC20.
Everything below covers what is *not* standard.

---

## Transfers can revert for compliance reasons

Standard ERC20 calls (`transfer`, `transferFrom`) revert when:

| Condition | Error | Transient? |
|---|---|---|
| Token is paused | `EnforcedPause()` | Yes — retry later |
| Sender is frozen | `ERC20InvalidSender(address)` | Only if unfrozen |
| Recipient is frozen | `ERC20InvalidReceiver(address)` | Only if unfrozen |

Check `paused()` and `frozen(address)` before quoting a transfer as guaranteed.
Treat a pause as a temporary halt and surface it as such, rather than as a
failed transaction.

Balances can also change without a `Transfer` from the holder's own action:
`seizeFunds` force-transfers under compliance authority and emits both a standard
`Transfer` and a `FundsSeized(from, to, amount)` event. **Indexers that
reconstruct balances from `Transfer` alone remain correct** — seizure emits one.

---

## Minting: two separate paths

There is no single "mint" permission. Which function you call depends on which
role you hold, and they are not interchangeable.

### Bridge issuance — `mint`, synchronous

```solidity
function mint(address to, uint256 amount) external returns (bool);
```

Requires `BRIDGE_ROLE`. Settles in one transaction. This is what a
`TokenMessenger` calls after an attestation is verified. The signature is
unchanged from v1, so an existing bridge integration needs no code change —
only the role changes (`MINTER_ROLE` → `BRIDGE_ROLE`).

Consumes the caller's **mint rate-limit allowance**, which refills linearly.

### Treasury issuance — `queueMint` / `commitMint`, timelocked

```solidity
function queueMint(address to, uint256 amount) external returns (uint256 actionId);
function commitMint(uint256 actionId, address to, uint256 amount) external;
```

`queueMint` needs `MINTER_ROLE`; `commitMint` needs `DEFAULT_ADMIN_ROLE` and
only succeeds after the timelock (≥ 1 hour) and before the 30-day expiry. The
arguments passed to `commitMint` must match those queued **exactly** — they are
hashed and compared.

Read `pendingAction(actionId)` for `(actionHash, eta)`; `eta == 0` means the
action does not exist, was committed, or was cancelled.

---

## Burning

```solidity
function burn(uint256 amount) external;                          // anyone, own balance
function burnFrom(address account, uint256 amount) external;     // BRIDGE_ROLE only
function redeemRequest(uint256 amount, string calldata ref) external;  // anyone
```

**`burnFrom` requires no ERC20 allowance.** It is gated on `BRIDGE_ROLE` alone,
which keeps `depositForBurn` a single user transaction with no `approve` step.
It consumes the caller's **burn rate-limit allowance**.

`redeemRequest` burns the caller's own tokens and emits
`RedeemRequested(account, amount, offChainReference)` — use it to tie an on-chain
burn to an off-chain fiat payout reference.

---

## Rate limits

Each bridge has two independent refilling buckets — one for minting in, one for
burning out — sharing a `capacity` and `period`. Each refills linearly from
empty to full over `period`. They are independent, so heavy inbound traffic
cannot throttle outbound transfers.

```solidity
function bridgeMintAvailable(address bridge) external view returns (uint256);
function bridgeBurnAvailable(address bridge) external view returns (uint256);
function bridgeLimit(address bridge) external view returns (BridgeLimit memory);
```

Exhausting a bucket reverts with:

```solidity
error BridgeRateLimitExceeded(uint256 requested, uint256 available);
```

**This is transient.** The allowance refills with time, so a relayer should
back off and retry rather than treating the message as failed. Query
`bridgeMintAvailable` / `bridgeBurnAvailable` to compute how long to wait, or to
pre-flight a large transfer and split it.

A bridge whose `capacity` is `0` is disabled — either never registered, or
killed by `removeBridge`. That state is **not** transient; it needs governance.

---

## Error reference

| Error | Meaning |
|---|---|
| `EnforcedPause()` | Token is paused |
| `ERC20InvalidSender(address)` | Sender frozen |
| `ERC20InvalidReceiver(address)` | Recipient frozen |
| `ERC20InsufficientBalance(...)` | Standard ERC20 |
| `AccessControlUnauthorizedAccount(address,bytes32)` | Caller lacks the role in the second argument |
| `BridgeRateLimitExceeded(uint256,uint256)` | Rate limit exhausted — transient, refills |
| `MintCapExceeded()` | Would push `totalSupply()` past `mintCap()` |
| `ZeroAddress()` | Zero address where one is not permitted |
| `FrozenRecipient(address)` | Seizure target is frozen |
| `ActionNotFound(uint256)` | No such queued action — committed, cancelled, or never existed |
| `ActionNotReady(uint256,uint64,uint64)` | Timelock has not elapsed |
| `ActionExpired(uint256,uint64,uint64)` | Past `eta + 30 days`; must be re-queued |
| `ActionMismatch(uint256,bytes32,bytes32)` | Commit args do not match what was queued |
| `LastAdminProtected()` | Would remove the final admin |
| `BridgeMustBeContract(address)` | `BRIDGE_ROLE` cannot be granted to an EOA |

---

## Events worth indexing

```solidity
event BridgeMinted(address indexed bridge, address indexed to,   uint256 amount);
event BridgeBurned(address indexed bridge, address indexed from, uint256 amount);
event MintCommitted(uint256 indexed actionId, address indexed to, uint256 amount);
event RedeemRequested(address indexed account, uint256 amount, string offChainReference);
event FundsSeized(address indexed from, address indexed to, uint256 amount);
event AccountFrozen(address indexed account);
event AccountUnfrozen(address indexed account);
event BridgeUpdated(address indexed bridge, uint96 capacity, uint48 period);
event BridgeRemoved(address indexed bridge);
event ActionQueued(uint256 indexed actionId, bytes32 indexed actionHash, uint64 eta);
```

`BridgeMinted` / `BridgeBurned` distinguish cross-chain flow from treasury
issuance, which `Transfer` alone cannot. Reserve reconciliation should use
`MintCommitted` and `RedeemRequested` — those are the events that correspond to
actual fiat movement. **Bridge mints and burns are not reserve movements**; they
relocate existing supply between chains.

`ActionQueued` is the one to alert on: it fires for every pending privileged
change, including upgrades.

---

## Upgrades

The proxy address is permanent; the implementation behind it is not. An upgrade
can add functions and, in principle, change behaviour of existing ones.

Upgrades are timelocked and **content-addressed** — the queued hash covers both
the new implementation address and the initializer calldata, so the committed
upgrade is exactly the one that was queued and publicly visible for at least an
hour. Watch `UpgradeQueued(actionId, newImpl)` if you need advance notice.

Integrators holding significant balances should monitor `ActionQueued` /
`UpgradeQueued` on the token and decide their own policy for the delay window.

---

## Checklist

- [ ] Integrate against the **proxy** address
- [ ] Read `decimals()` (**2**) — never hardcode 18
- [ ] Handle `EnforcedPause` and the frozen-sender/receiver errors as distinct, user-visible states
- [ ] Treat `BridgeRateLimitExceeded` as transient — back off and retry
- [ ] Do **not** add an `approve` step before `depositForBurn`
- [ ] Index `BridgeMinted` / `BridgeBurned` separately from `MintCommitted` / `RedeemRequested`
- [ ] Monitor `ActionQueued` and `UpgradeQueued`
