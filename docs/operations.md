# StableNaira — operations runbook

Deploying, upgrading, tuning the rate limits, monitoring, and responding to an
incident. Assumes `DEFAULT_ADMIN_ROLE` is held by a multisig — if it is not, do
[docs/multisig-admin-minter-setup.md](multisig-admin-minter-setup.md) first.

---

## 1. Deployment is not finished when `PHASE=deploy` returns

Granting the bridge its role is timelocked, so a deploy spans two sessions
separated by at least the timelock.

```bash
npm run deploy:testnet          # PHASE=deploy       — stack + QUEUE token actions
npm run queue-wires:testnet     # PHASE=queue-wires  — QUEUE remote routers
#   … wait out the timelock (≥ 1 hour) …
npm run commit-wires:testnet    # PHASE=commit-wires — COMMIT routers + token actions
npm run verify:testnet          # PHASE=verify       — explorer verification
```

**Until `commit-wires` lands, the bridge holds no role and cannot mint or
burn.** Cross-chain transfers will fail. That is expected — wire the routers
during the wait, then commit everything together.

`PHASE=wait-and-commit` blocks until the eta and then commits, if you prefer one
command. `PHASE=summary` prints the recorded state of every chain.

Deployment state, including queued `actionId`s and their etas, is persisted to
`ignition/deployments/<network>/addresses.json`. **Do not lose this file** — the
actionIds are how you commit later.

### Verify a deployment is actually live

```bash
PHASE=smoke npx hardhat run scripts/deploy.ts --network <net>
```

This reports role wiring and rate-limit headroom, and queues a test treasury
mint. It cannot mint-and-assert in one pass, because treasury minting is
timelocked.

---

## 2. Sizing the rate limits

Set in the deploy template under `common.token`:

```jsonc
"bridgeCapacity": "1000000000",     // base units (2 decimals) → ₦10,000,000.00
"bridgePeriodSeconds": 86400        // refills fully over one day
```

Each bridge gets two independent buckets, mint and burn, each refilling linearly
to `capacity` over `period`.

**`bridgeCapacity` is the most important security parameter in the deployment.**
Because `burnFrom` needs no allowance, this number — not a per-user approval —
is the ceiling on what a compromised bridge can destroy in one period.

- Size it to **plausible peak volume per period**, not to total supply. A
  capacity equal to supply is the same as no limit at all.
- Too tight and legitimate transfers fail with `BridgeRateLimitExceeded` during
  a volume spike. That is transient and self-heals, but it is user-visible.
- Start conservative and raise it with observed volume. Raising is timelocked;
  killing is instant.

Change it later via `queueAddBridge` → `commitAddBridge` with the same bridge
address and new numbers. The commit resets both buckets to full.

---

## 3. Routine operations

Everything privileged is sent to the token **proxy**, `value = 0`.

| Task | Call | Delay |
|---|---|---|
| Issue against a fiat deposit | `queueMint(to, amount)` → `commitMint(id, to, amount)` | ≥ 1 h |
| Change the supply ceiling | `queueSetMintCap(cap)` → `commitSetMintCap(id, cap)` | ≥ 1 h |
| Add / re-limit a bridge | `queueAddBridge(b, cap, period)` → `commitAddBridge(id, b, cap, period)` | ≥ 1 h |
| Upgrade | `queueUpgrade(impl, data)` → `commitUpgrade(id, impl, data)` | ≥ 1 h |
| Raise the timelock | `setTimelock(n)` → `commitSetTimelock(id, n)` | ≥ 1 h |
| Cancel anything pending | `cancelAction(id)` | immediate |
| Pause / unpause | `pause()` / `unpause()` | immediate |
| Freeze / unfreeze | `freezeAddress(a)` / `unfreezeAddress(a)` | immediate |
| Seize | `seizeFunds(from, to, amount)` | immediate |
| Kill a bridge | `removeBridge(b)` | immediate |

Commit arguments must match what was queued **exactly** — they are hashed and
compared, and a mismatch reverts with `ActionMismatch`. Record every `actionId`
and its arguments when queueing.

Queued actions **expire 30 days after their eta** (`ActionExpired`) and must be
re-queued, which restarts the full delay.

Both queue and commit require admin. This is deliberate: an unauthenticated
commit would let anyone front-run `cancelAction`, closing the cancellation
window at the eta rather than at execution.

---

## 4. Monitoring

Because `burnFrom` needs no allowance, **monitoring is a control, not a
convenience.** The rate limit bounds the damage per period; monitoring is what
turns that window into a response.

Alert on:

| Signal | Why |
|---|---|
| `ActionQueued` not initiated by your team | Someone with admin queued a privileged change — including an upgrade |
| `UpgradeQueued` | Always. You have ≥ 1 hour to review or cancel |
| `BridgeBurned` volume above expected | The primary compromise indicator |
| `BridgeMinted` volume above expected | Should correlate 1:1 with peer-chain burns |
| `BridgeMinted` without a matching peer-chain `DepositForBurn` | Attestation or bridge compromise |
| `bridgeMintAvailable` / `bridgeBurnAvailable` near zero | Either a spike, or an attack in progress |
| `FundsSeized`, `AccountFrozen` | Compliance actions — confirm they were authorised |
| `Paused` | Confirm intentional |

Reserve reconciliation uses `MintCommitted` and `RedeemRequested`, **not**
`BridgeMinted` / `BridgeBurned` — bridge flow relocates existing supply between
chains and is not a reserve movement.

---

## 5. Incident response

### Suspected bridge compromise

```
removeBridge(bridge)      # instant · PAUSER_ROLE or admin · no timelock
```

Revokes `BRIDGE_ROLE` and zeroes both buckets in one transaction. Deliberately
available to `PAUSER_ROLE` so responders do not wait on a multisig quorum.
Restoring the bridge goes back through the timelocked `queueAddBridge`.

If the blast radius is wider than one bridge, `pause()` stops all movement.
Note **only admin can unpause** — pausing is a one-way door until the multisig
convenes.

### Clawing back and destroying funds

> **Changed in v2.** The admin can no longer call `burnFrom` — it is
> `BRIDGE_ROLE`-only now. Any runbook or calldata batch built around
> `burnFrom(holder, amount)` from the admin Safe **will revert** with
> `AccessControlUnauthorizedAccount`.

The replacement is two steps, and it works while the target is frozen and while
the token is paused:

```
1. freezeAddress(badActor)                        # optional, stops further movement
2. seizeFunds(badActor, treasury, amount)         # SEIZER_ROLE  → emits FundsSeized
3. burn(amount)                                   # from treasury, destroys supply
```

Verified end to end: seizure succeeds against a frozen account, and the
subsequent self-burn reduces `totalSupply`. This is more auditable than the old
path — `FundsSeized` names both parties on-chain, where a bare `burnFrom` did
not.

The seizure destination must **not** be frozen (`FrozenRecipient`), since the
freeze check is skipped on both sides and the funds would be locked.

For a batch remediation, convert each row to a `seizeFunds` call to a single
treasury address, execute as one multisig batch, then a single `burn` of the
total. If the token is paused, seizure still works; the final `burn` does not —
unpause, or burn after resuming.

### Suspected admin key compromise

1. `cancelAction(id)` every pending action you did not queue — **before its
   eta**, since after that you are racing an attacker who only needs the
   multisig to be slow.
2. Add a new admin, then revoke the compromised one. The last admin cannot be
   removed (`LastAdminProtected`), so add before removing.
3. Consider `pause()` while rotating.

---

## 6. Upgrades

```bash
# 1. Confirm the new implementation is storage-compatible. This is not optional.
npm run layout:check

# 2. Queue, review, commit.
queueUpgrade(newImpl, initData)      # → actionId, eta
#   … ≥ 1 hour, publicly visible …
commitUpgrade(actionId, newImpl, initData)
```

The queued hash covers the implementation address **and** the initializer
calldata, so the committed upgrade is provably the one that was queued.

`layout:check` compares against the committed `storage-layout.json` and fails on
a moved variable, a changed type, a grown footprint, or reordered struct members
— including structs inside a mapping. It runs in CI ahead of the tests.

**Never run `layout:accept` to make a failing upgrade pass.** That command
re-baselines and is only correct when no proxy holds real state. Treat a
`layout:accept` in a diff as a change requiring review on its own.

When adding state to an upgraded implementation: append the new variable after
the existing ones and shrink `__gap` by exactly the number of slots consumed.
Adding state to `TimelockedUpgradeable` shifts every slot in all four proxies at
once — shrink `__tlGap` too, and expect `layout:check` to tell you if you got it
wrong.

---

## 7. Recommended posture

- **Admin:** 3-of-5 hardware-wallet multisig, distinct holders, exactly one
  `DEFAULT_ADMIN_ROLE` member so `owner()` resolves to it.
- **`BRIDGE_ROLE`:** the local `TokenMessenger` and nothing else. The contract
  rejects EOAs outright.
- **`MINTER_ROLE`:** the admin multisig or a dedicated issuance Safe. It can
  only *queue*; committing needs admin, so this role alone cannot mint.
- **`PAUSER_ROLE`:** on-call responders with fast keys — they hold the two
  instant kill switches (`pause`, `removeBridge`) and nothing that can move
  value.
- **Timelock:** consider raising above the 1-hour floor once operations are
  steady. `setTimelock` is itself timelocked, so raising it takes effect after
  the *current* delay.
