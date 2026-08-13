# StableNaira — Moving `DEFAULT_ADMIN_ROLE` & `MINTER_ROLE` to a Multisig (BSC)

This guide sets up a **Gnosis Safe (Safe{Wallet}) multisig** on BNB Smart Chain and
makes it the holder of the two most dangerous roles on the StableNaira token:
`DEFAULT_ADMIN_ROLE` and `MINTER_ROLE`. It then removes those roles from the
single operator EOA.

> **Why this matters.** The StableNaira contract documents this as audit finding
> **HIGH-03**: `MINTER_ROLE` can mint unlimited supply *and* `burnFrom` any
> holder's balance with no allowance. Today both `DEFAULT_ADMIN_ROLE` and
> `MINTER_ROLE` sit on a **single EOA** (`0x2503Cba0edfEe3F790D14bA141b92B11816EC987`),
> which is exactly the configuration the audit says to avoid. One leaked key =
> total control. Moving these behind an M-of-N multisig means no single key can
> mint, burn, pause, freeze, seize, or upgrade.

---

## ⚠️ Which version is this for?

**Parts 0–5 of this guide describe the contract as currently deployed on BSC
mainnet (v1).** They stay valid regardless of what is in the repository — verify
against the live contract before executing, as the closing note says.

The repository has since moved to **v2.0**, which changes several things this
runbook depends on. If and when the proxy is upgraded, re-read
[§ After the v2 upgrade](#after-the-v2-upgrade) at the end — in particular, **the
admin Safe loses the ability to call `burnFrom`**, which breaks the burn
remediation in Part 6.

Check which is live before starting:

```bash
cast call $TOKEN "VERSION()(string)" --rpc-url $RPC     # "1.0" → this guide as written
```

---

## 0. Reference — addresses, roles, selectors (BSC mainnet, chainId 56)

| Thing | Value |
|---|---|
| SNR token (proxy — **this is the `to` for every call**) | `0x6B6f93a12705b6eB60490A8b8a9aC15b3B1ce0f2` |
| Current admin + minter EOA (to be removed) | `0x2503Cba0edfEe3F790D14bA141b92B11816EC987` |
| CCTP TokenMessenger — **keeps** `MINTER_ROLE` (needed for the bridge) | `0xbE1Ed9d08141d4c8331Ba30ECb64fF42F1512F31` |
| Compromised operator — must hold **no** roles | `0xde6E09456f7996A63AB3f31936e49C8EF6a0F419` |
| Your new Safe | `<SAFE_ADDRESS>` (created in Part 1) |

**Role IDs** (`bytes32`):

| Role | ID |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x0000000000000000000000000000000000000000000000000000000000000000` |
| `MINTER_ROLE` | `0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6` |
| `PAUSER_ROLE` | `0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a` |
| `FREEZER_ROLE` | `0x92de27771f92d6942691d73358b3a4673e4880de8356f8f2cf452be87e02d363` |
| `SEIZER_ROLE` | `0xe770a2b882b0a3a025be15ffce2d5d54f5d719264e701933268dd62f79db677f` |

**Function selectors** (for raw-calldata execution):

| Function | Selector |
|---|---|
| `grantRole(bytes32,address)` | `0x2f2ff15d` |
| `revokeRole(bytes32,address)` | `0xd547741f` |
| `renounceRole(bytes32,address)` | `0x36568abe` |
| `hasRole(bytes32,address)` | `0x91d14854` |
| `getRoleMember(bytes32,uint256)` | `0x9010d07c` |
| `getRoleMemberCount(bytes32)` | `0xca15c873` |
| `addMinter(address)` | `0x983b2d56` |
| `removeMinter(address)` | `0x3092afd5` |
| `mint(address,uint256)` | `0x40c10f19` |
| `burnFrom(address,uint256)` | `0x79cc6790` |
| `pause()` / `unpause()` | `0x8456cb59` / `0x3f4ba83a` |
| `owner()` | `0x8da5cb5b` |

---

## ⚠️ Critical rules — read before doing anything

1. **Never remove the old admin until the Safe admin is proven working.** If the
   only `DEFAULT_ADMIN_ROLE` member is removed, governance is **permanently
   bricked** — `DEFAULT_ADMIN_ROLE` is its own admin, so with zero admins no one
   can ever grant it again. Always follow the order: **grant to Safe → verify Safe
   can act → then remove the EOA.**
2. **`owner()` expects exactly one admin.** The contract's `owner()` view reverts
   (`SingleAdminExpected`) unless `DEFAULT_ADMIN_ROLE` has **exactly one** member.
   During the migration you will briefly have two (EOA + Safe); that's fine, but
   the **end state must be exactly one: the Safe.**
   *(On v2 it returns `address(0)` rather than reverting — but the end state is
   the same.)*
3. **Do not revoke the bridge's `MINTER_ROLE`.** The CCTP TokenMessenger
   (`0xbE1Ed9…`) must keep `MINTER_ROLE` to mint on cross-chain receive. Only the
   **EOA** loses minter.
4. Every call in this guide is sent **to the token proxy** `0x6B6f93…ce0f2`,
   `value = 0`.

---

## Part 1 — Create the Safe on BSC

1. Go to **https://app.safe.global** and connect a signer wallet. Select network
   **BNB Smart Chain**.
2. **Create new Safe.** Add the signer addresses (owners) and set the threshold.
   - **Recommended: 3-of-5** (or at minimum 2-of-3) using **hardware wallets**
     (Ledger/Trezor) held by distinct, trusted individuals.
   - Do **not** reuse the compromised operator key or the current EOA as the sole
     signer. Fresh keys on fresh hardware.
   - Spread signers across people/locations; back up each seed offline.
3. Deploy the Safe (costs a little BNB). **Record the Safe address** →
   `<SAFE_ADDRESS>`.
4. **Fund the Safe with BNB** for future gas (admin/mint transactions).

Best practices: enable a spending/recovery policy only if you understand it; keep
the signer list small and known; document who holds which key.

---

## Part 2 — Grant both roles to the Safe (executed by the current EOA)

These two transactions are sent **from the current admin EOA** `0x2503…` (it still
holds `DEFAULT_ADMIN_ROLE`, so it can grant). Send them **to the token**
`0x6B6f93…ce0f2`.

**2a. Grant `MINTER_ROLE` to the Safe** — use the convenience wrapper:
```bash
export RPC="https://bsc-mainnet.core.chainstack.com/791cf8d664a568890c4e2cde8308c902"
export ADMIN_PK=<current admin EOA private key 0x2503...>
export TOKEN=0x6B6f93a12705b6eB60490A8b8a9aC15b3B1ce0f2
export SAFE=<SAFE_ADDRESS>

# addMinter(SAFE)  (equivalent to grantRole(MINTER_ROLE, SAFE))
cast send $TOKEN "addMinter(address)" $SAFE --rpc-url $RPC --private-key $ADMIN_PK
```

**2b. Grant `DEFAULT_ADMIN_ROLE` to the Safe:**
```bash
cast send $TOKEN "grantRole(bytes32,address)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  $SAFE --rpc-url $RPC --private-key $ADMIN_PK
```

(If you prefer raw calldata for a hardware-wallet UI, build it with
`cast calldata "grantRole(bytes32,address)" <ROLE_ID> <SAFE>`.)

---

## Part 3 — Verify the Safe actually controls the contract (do NOT skip)

**3a. Read-check the roles landed** (no key needed):
```bash
# expect: true
cast call $TOKEN "hasRole(bytes32,address)(bool)" 0x00...00 $SAFE --rpc-url $RPC          # admin (use full 32-zero role)
cast call $TOKEN "hasRole(bytes32,address)(bool)" \
  0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6 $SAFE --rpc-url $RPC  # minter
```

**3b. Prove the Safe can exercise admin — execute one harmless admin tx *from the
Safe*** before removing the EOA. In the Safe UI → **New Transaction → Transaction
Builder**, enter the token address, and call a reversible admin function, e.g.
grant `PAUSER_ROLE` to the Safe itself:
- To: `0x6B6f93…ce0f2`
- Method: `grantRole(bytes32,address)`
- `role`: `0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a` (PAUSER)
- `account`: `<SAFE_ADDRESS>`

Collect the required signatures and **execute**. If it succeeds, the Safe's
`DEFAULT_ADMIN_ROLE` is live. (You can `revokeRole(PAUSER_ROLE, SAFE)` afterward if
you don't want the Safe to hold pauser.)

Only proceed to Part 4 once this Safe-signed transaction has **confirmed on-chain**.

---

## Part 4 — Remove the roles from the old EOA (executed by the Safe)

Now that the Safe is a proven admin, use **the Safe** to strip the EOA. In the Safe
Transaction Builder (to: token `0x6B6f93…ce0f2`):

**4a. Revoke minter from the EOA:**
- Method `removeMinter(address)` → `account = 0x2503Cba0edfEe3F790D14bA141b92B11816EC987`
  *(or `revokeRole(MINTER_ROLE, 0x2503…)`)*

**4b. Revoke admin from the EOA:**
- Method `revokeRole(bytes32,address)`
  - `role = 0x00…00` (DEFAULT_ADMIN_ROLE)
  - `account = 0x2503Cba0edfEe3F790D14bA141b92B11816EC987`

You can batch 4a + 4b into a single Safe transaction.

> Alternative: the EOA can remove *itself* by calling
> `renounceRole(0x00…00, 0x2503…)` from its own key. Either works; doing it from
> the Safe means you never need the EOA to sign again.

---

## Part 5 — Final verification (the end state)

```bash
# exactly ONE admin, and it is the Safe:
cast call $TOKEN "getRoleMemberCount(bytes32)(uint256)" 0x00...00 --rpc-url $RPC        # expect 1
cast call $TOKEN "getRoleMember(bytes32,uint256)(address)" 0x00...00 0 --rpc-url $RPC   # expect SAFE
cast call $TOKEN "owner()(address)" --rpc-url $RPC                                       # expect SAFE

# old EOA holds nothing:
cast call $TOKEN "hasRole(bytes32,address)(bool)" 0x00...00 0x2503Cba0edfEe3F790D14bA141b92B11816EC987 --rpc-url $RPC  # false
cast call $TOKEN "hasRole(bytes32,address)(bool)" 0x9f2df0...956a6 0x2503Cba0edfEe3F790D14bA141b92B11816EC987 --rpc-url $RPC  # false

# minter is now { Safe, bridge } — confirm the bridge still has it:
cast call $TOKEN "hasRole(bytes32,address)(bool)" 0x9f2df0...956a6 0xbE1Ed9d08141d4c8331Ba30ECb64fF42F1512F31 --rpc-url $RPC  # true

# compromised operator holds nothing (all roles):
cast call $TOKEN "hasRole(bytes32,address)(bool)" 0x00...00 0xde6E09456f7996A63AB3f31936e49C8EF6a0F419 --rpc-url $RPC  # false
```

Also audit `PAUSER_ROLE`, `FREEZER_ROLE`, `SEIZER_ROLE` the same way and move any
that still sit on the old/compromised EOAs to the Safe (or to your intended
operational holders).

---

## Part 6 — Using the Safe as minter / admin day-to-day

Everything privileged now goes through the Safe (New Transaction → Transaction
Builder, `to = 0x6B6f93…ce0f2`, `value = 0`):

| Action | Method | Args |
|---|---|---|
| Mint on issuance | `mint(address,uint256)` | recipient, amount (base units, 2 decimals) |
| Burn a holder (compromise cleanup) | `burnFrom(address,uint256)` | account, amount |
| Pause / unpause | `pause()` / `unpause()` | — |
| Freeze / unfreeze | `freezeAddress(address)` / `unfreezeAddress(address)` | account |
| Seize | `seizeFunds(address,address,uint256)` | from, to, amount |
| Grant/revoke a role | `grantRole` / `revokeRole` | role, account |

- The **burn remediation** from the incident (`burn-targets.csv` /
  `snr-burnfrom-calldata.csv`) is a list of `burnFrom` calls — import them into the
  Safe Transaction Builder as a **batch** (each: to = token, value 0, the row's
  calldata), sign, execute. Remember: unpaused + target not frozen, and `sync()`
  each Pancake pair after burning it.

  > **⚠️ v2 only:** this batch **reverts** if the proxy has been upgraded to
  > v2.0 — `burnFrom` is `BRIDGE_ROLE`-only there, and the admin Safe does not
  > hold it. Check `VERSION()` first; if it returns `"2.0"`, use the
  > seize-then-burn procedure in
  > [§ After the v2 upgrade](#the-burn-remediation-rewritten) instead.
- **Operational note:** every mint/burn now needs M signatures, which is slower
  than an automated hot key. That is the intended tradeoff for a fiat-backed
  stablecoin's admin. If you need automated issuance, consider a **separate,
  lower-privilege minter** (e.g. a dedicated minting Safe or a capped minter) so
  the high-value admin Safe isn't used for routine mints — but never an
  unprotected EOA.

---

## Part 7 — Recommended target posture

- **Admin Safe:** 3-of-5 hardware-wallet signers, distinct people. This holds
  `DEFAULT_ADMIN_ROLE` and controls upgrades (via the queue/commit timelock),
  pausing, and role management.
- **Minter:** ideally held **only by the CCTP bridge** for cross-chain, plus the
  admin Safe (or a dedicated minter Safe) for issuance/redemption. **No EOA should
  ever hold `MINTER_ROLE`** — that's the HIGH-03 rule.
- **Upgrade timelock:** now that admin is a Safe, consider raising the UUPS
  timelock via `setTimelock(uint256)` (seconds) so even a Safe-approved upgrade has
  a public delay window. `queueUpgrade` → wait → `commitUpgrade`.
- **Never** leave `DEFAULT_ADMIN_ROLE` with zero members, and keep it at exactly
  one (the Safe) so `owner()` resolves.

---

## After the v2 upgrade

Everything below applies **only once the proxy runs v2.0**
(`VERSION()` returns `"2.0"`). Until then, follow Parts 0–6 as written.

### What breaks

| Part | v1 behaviour | v2 behaviour |
|---|---|---|
| **Part 6 — burn remediation** | Admin Safe calls `burnFrom(holder, amount)` | **Reverts.** `burnFrom` is `BRIDGE_ROLE`-only |
| **Part 6 — mint on issuance** | `mint(to, amount)` in one Safe tx | `queueMint` → wait ≥ 1 h → `commitMint` |
| **Rule 2 — `owner()`** | Reverts `SingleAdminExpected` with ≠ 1 admin | Returns `address(0)` instead; still keep it at exactly one |
| **Rule 1 — brick risk** | Removing the last admin bricks governance | Contract refuses (`LastAdminProtected`) — but keep the ordering discipline anyway |
| **Rule 3 — bridge role** | Bridge keeps `MINTER_ROLE` | Bridge needs **`BRIDGE_ROLE`**; `MINTER_ROLE` no longer permits minting |

### The burn remediation, rewritten

The `snr-burnfrom-calldata.csv` batch **will not execute on v2**. Replace each
`burnFrom(holder, amount)` with a seizure to a treasury address, then one burn of
the total:

```
1. seizeFunds(holder, TREASURY, amount)   # SEIZER_ROLE · one row per target · batch in the Safe
2. burn(total)                            # from TREASURY, destroys the supply
```

This works while the target is **frozen** and while the token is **paused** —
seizure deliberately bypasses both — and it is more auditable than the old path,
since `FundsSeized(from, to, amount)` names both parties on-chain.

Two constraints: `TREASURY` must not itself be frozen (`FrozenRecipient`), and
the final `burn` does **not** work while paused, so unpause before that step.

### Migrating the bridge to `BRIDGE_ROLE`

`MINTER_ROLE` no longer permits minting, so the bridge must be re-granted before
cross-chain transfers resume. It is timelocked:

```
queueAddBridge(BRIDGE, capacity, periodSeconds)   # → actionId
   … wait ≥ 1 hour …
commitAddBridge(actionId, BRIDGE, capacity, periodSeconds)
```

`capacity` is in base units (2 decimals) per `periodSeconds`, and it is the
ceiling on what a compromised bridge can mint or burn per period. Size it to
plausible peak volume — see
[operations.md § 2](operations.md#2-sizing-the-rate-limits). Then revoke the
bridge's now-useless `MINTER_ROLE`.

### Additional role ID and selectors (v2)

| Role | ID |
|---|---|
| `BRIDGE_ROLE` | `0x52ba824bfabc2bcfcdf7f0edbb486ebb05e1836c90e78047efeb949990f72e5f` |

| Function | Selector |
|---|---|
| `queueMint(address,uint256)` | `0x79ba1453` |
| `commitMint(uint256,address,uint256)` | `0xb36939ad` |
| `queueAddBridge(address,uint96,uint48)` | `0x8ba8507b` |
| `commitAddBridge(uint256,address,uint96,uint48)` | `0x0b70888c` |
| `removeBridge(address)` | `0x04df017d` |
| `queueSetMintCap(uint256)` | `0x7c5b4b93` |
| `commitSetMintCap(uint256,uint256)` | `0xf7fda097` |
| `cancelAction(uint256)` | `0xd5ecdb6d` |
| `queueUpgrade(address,bytes)` | `0x9a066e56` |
| `commitUpgrade(uint256,address,bytes)` | `0x0fb09e32` |
| `burn(uint256)` | `0x42966c68` |
| `seizeFunds(address,address,uint256)` | `0x92c4a4b3` |
| `pendingAction(uint256)` | `0x19afaa07` |
| `bridgeMintAvailable(address)` | `0x19702c1c` |
| `bridgeBurnAvailable(address)` | `0x760049c3` |

`setMintCap(uint256)` no longer exists — it is now
`queueSetMintCap` / `commitSetMintCap`. The four per-type cancel functions
(`cancelMint`, `cancelUpgrade`, `cancelSetTimelock`, `cancelSetMinTimelock`)
have been collapsed into a single `cancelAction(uint256)`.

Day-to-day operations on v2 are in
[operations.md](operations.md); integration details are in
[token-integration.md](token-integration.md).

---

*Generated for the StableNaira BSC deployment. Verify every address, role ID and
`VERSION()` against the live contract before executing — treat this as a
checklist, not a substitute for review.*
