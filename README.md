# StableNaira — core contracts

Fiat-backed NGN stablecoin (`SNR`) and a burn-and-mint cross-chain bridge, on
EVM chains. Solidity 0.8.28, OpenZeppelin v5, Hardhat.

The token is a UUPS-upgradeable ERC20 with compliance controls (pause, freeze,
seize) and a queue → commit timelock on every sensitive admin operation. The
bridge is a CCTP-style burn-and-mint router with an off-chain validator quorum
attesting messages between chains.

---

## Contracts

| Contract | Proxy | Purpose |
|---|---|---|
| [`StableNaira`](contracts/StableNaira.sol) | UUPS | The `SNR` token. **2 decimals.** Roles, timelock, compliance controls. |
| [`StableNairaUUPSDeployer`](contracts/StableNairaUUPSDeployer.sol) | — | One-shot atomic deploy of implementation + ERC1967 proxy + `initialize`. |
| [`TokenMessenger`](contracts/cctp/TokenMessenger.sol) | UUPS | Burn on source, mint on destination. One per chain. |
| [`MessageTransmitter`](contracts/cctp/MessageTransmitter.sol) | UUPS | Message envelope, nonces, replay protection. |
| [`ValidatorRegistry`](contracts/cctp/ValidatorRegistry.sol) | UUPS | Validator set and signing threshold. |
| [`MultisigVerifier`](contracts/cctp/verifiers/MultisigVerifier.sol) | — | Verifies a quorum of validator signatures over a message. |
| [`StableNairaPriceOracle`](contracts/StableNairaPriceOracle.sol) | — | Signed-quorum NGN/USD price feed (`Ownable2Step`). |

`StableNaira` and the three bridge contracts share
[`TimelockedUpgradeable`](contracts/cctp/utils/TimelockedUpgradeable.sol), a
queue → commit mixin with a hardcoded **1-hour floor**, a 365-day ceiling, and a
**30-day expiry** on queued actions.

---

## Two kinds of minting

The single most important thing to understand about this token: **minting is
split into two paths that are not interchangeable.**

| | Treasury issuance | Bridge issuance |
|---|---|---|
| Role | `MINTER_ROLE` | `BRIDGE_ROLE` |
| Call | `queueMint` → wait → `commitMint` | `mint` — single transaction |
| Delay | ≥ 1 hour | none |
| Bound | `mintCap` | refilling rate limit + `mintCap` |
| Held by | admin multisig | the local `TokenMessenger` only |

They are separated because they are **economically different operations**:

- **Treasury issuance creates new supply** against a new fiat deposit into
  reserves. It should wait for governance, so it is timelocked.
- **Bridge issuance creates no new supply.** It restores tokens already burned
  on a peer chain against the same reserve, so the total across all chains is
  unchanged. It *must* settle in one transaction — the user's tokens are already
  burned on the source chain, and a delayed mint would strand them.

A synchronous mint path is exactly the risk a timelock exists to bound, so
bridge issuance is capped by a **per-bridge refilling rate limit** instead. A
compromised bridge mints at most its remaining allowance rather than an
unbounded amount, leaving time for the kill switch.

`BRIDGE_ROLE` is granted only through the timelocked `queueAddBridge` /
`commitAddBridge` path, **rejects EOAs**, and is revoked instantly by
`removeBridge` — which `PAUSER_ROLE` can call, so incident responders do not
wait on a multisig quorum.

> **Why a role and not a type check.** "Is the caller a TokenMessenger" has no
> honest on-chain answer: ERC-165 `supportsInterface` returns whatever an
> attacker's contract wants, and `extcodesize` passes for any contract. The only
> sound version is a governance-managed allowlist — which is what `BRIDGE_ROLE`
> is.

### Burning

`burnFrom` requires `BRIDGE_ROLE` and **no ERC20 allowance**, so
`depositForBurn` stays a single user transaction with no `approve` step. The
trade-off is deliberate and load-bearing: a bridge holding `BRIDGE_ROLE` can
burn *any* holder's balance, so the **burn rate limit is the only bound** on a
bridge compromise. It refills independently of the mint bucket, so heavy inbound
traffic cannot throttle outbound transfers.

This makes off-chain monitoring a control, not a nicety — see
[docs/operations.md](docs/operations.md).

---

## Roles

| Role | Can do | Should be held by |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Queue **and** commit every timelocked action; grant/revoke roles; `unpause` | Admin multisig, exactly one member |
| `MINTER_ROLE` | `queueMint` only (committing needs admin) | Admin multisig / issuance Safe |
| `BRIDGE_ROLE` | `mint` and `burnFrom`, both rate-limited | The local `TokenMessenger`. **Never an EOA** — the contract rejects them |
| `PAUSER_ROLE` | `pause`, `removeBridge` | On-call responders |
| `FREEZER_ROLE` | `freezeAddress` / `unfreezeAddress` | Compliance |
| `SEIZER_ROLE` | `seizeFunds` | Compliance |

Role IDs and function selectors:
[docs/multisig-admin-minter-setup.md](docs/multisig-admin-minter-setup.md).

**The last admin cannot be removed.** `_revokeRole` refuses to drop the final
`DEFAULT_ADMIN_ROLE` holder. Without that guard, a `renounceRole` would leave
the token permanently unpausable, unupgradeable, and unable to mint — terminal
if it happened while paused. A grant-then-renounce handover still works.

---

## Timelock

Every sensitive operation is `queueX` → wait → `commitX`. **Both sides are
admin-gated**: an unauthenticated commit would let anyone front-run the admin's
`cancelAction`, closing the cancellation window at `eta` instead of at
execution.

| Constant | Value |
|---|---|
| `MIN_FLOOR_TIMELOCK` | 1 hour — hardcoded; not even a compromised admin can go lower |
| `MAX_TIMELOCK` | 365 days |
| `ACTION_GRACE_PERIOD` | 30 days after `eta`, then the action is dead and must be re-queued |

Timelocked: `mint`, `setMintCap`, `addBridge`, `upgrade`, `setTimelock`,
`setMinTimelock`. Immediate: `pause`, `freeze`, `seize`, `removeBridge` — all
of which reduce capability or are compliance actions that cannot wait.

Cancel any pending action with `cancelAction(actionId)`. There is deliberately
one cancel function rather than one per type: the per-type wrappers all called
the same untyped primitive and implied a type safety that did not exist.

---

## Compliance controls

- **Pause** blocks all transfers, mints and burns. `PAUSER_ROLE` or admin can
  pause; **only admin can unpause.**
- **Freeze** blocks an address as sender or receiver.
- **Seize** force-transfers from an address, deliberately bypassing both the
  pause guard and the freeze check on the source — seizure has to work exactly
  when an account is frozen and the token is paused. It **rejects a frozen
  recipient**, which would otherwise lock the seized funds permanently.

To destroy funds taken from a bad actor, seize to a treasury address and then
`burn` — see [docs/operations.md](docs/operations.md#5-incident-response).

---

## Development

```bash
npm install
npx hardhat compile
npx hardhat test          # 138 tests
npm run ci                # typecheck → storage-layout check → tests
```

### Storage-layout guard

Every proxied contract's storage layout is pinned to a committed baseline in
`storage-layout.json`. A variable that moves slot, changes type, or disappears
does not fail loudly on upgrade — it **silently reinterprets live state**.

```bash
npm run layout:check      # verify against the baseline (runs in CI)
npm run layout:accept     # re-baseline after an intentional change
```

It fails the build if a non-gap variable moves, if the total footprint grows
(state added without shrinking `__gap`), or if a struct's members are reordered
— including structs inside a mapping, whose own type label would not change.

Treat a `layout:accept` appearing in a diff as a change needing review on its
own. It is only safe when no proxy holds real state.

> Reordering the OpenZeppelin base contracts is harmless — they all use ERC-7201
> namespaced storage and occupy no sequential slots. The real hazards are
> inserting another *non-namespaced* base, and adding state to
> `TimelockedUpgradeable` without shrinking `__tlGap` — the latter shifts every
> slot in all four proxies at once.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck →
compile → layout check → tests on every push and PR.

---

## Deployment

### Current state: BSC is token-only — the bridge is not deployed

BNB Smart Chain runs **only the token**. The bridge stack has not been deployed
against it, so **cross-chain transfers do not work on any chain.**

| | |
|---|---|
| Token (proxy) | `0x1638CFb26F17F81fb20295221A5075Aec363257F` |
| Implementation | `0x87d7cf767Ba7496820bfB5A475382b017FA7B29C` — `VERSION 2.0` |
| Admin | Safe `0xA72B530De83510B96eAab4fc5147Bb7a127934De`, holding every role |
| `BRIDGE_ROLE` | **no members** |
| `mintCap` | `0` — no supply ceiling |

Deployed 2026-08-13 with `npm run deploy:token:deterministic:mainnet`, which
deploys the token alone. `BRIDGE_ROLE` is empty, so nothing can mint except the
Safe via the timelocked `queueMint` → `commitMint` path.

Earlier stacks exist on chain from previous deployments. **They are not part of
this deployment** — different token, pre-audit code, keys outside the Safe. Do
not wire anything to them.

### What multichain requires

Per chain, all four of these must be deployed and owned by the Safe:

| Contract | Why it is required |
|---|---|
| `ValidatorRegistry` | The signer set and threshold. Nothing can attest a cross-chain message without it |
| `MultisigVerifier` | Checks quorum signatures. Its registry is fixed in the constructor, so a new registry always forces a new verifier |
| `MessageTransmitter` | Message envelope, nonces, replay protection |
| `TokenMessenger` | Burns on the source chain, mints on the destination. This is the contract that needs `BRIDGE_ROLE` |

Then, on the token, the Safe must run `queueAddBridge` → wait ≥ 1 hour →
`commitAddBridge` to grant the local `TokenMessenger` its `BRIDGE_ROLE` and rate
limit. **Until that commit lands the bridge cannot mint or burn**, so a stack
that is fully deployed but not yet granted is still non-functional.

Cross-chain also needs at least two chains wired to each other: each side
registers the other's `TokenMessenger` as the remote router for its domain
(`PHASE=queue-wires` → `PHASE=commit-wires`).

`PHASE=deploy` deploys a token unless the network spec pins one. Set
`tokenAddress` on the network in
[the deploy template](ignition/parameters/deploy-stable-naira-stack.template.json)
to bind the bridge to a token that already exists — it is set for `mainnet`, so
BSC will reuse the token above rather than deploy a duplicate.

### Unresolved before any bridge deployment

- **`validatorRegistry.validators` / `threshold`** — still the old operator key
  at 1-of-1. Validators must be EOAs (the verifier uses `ecrecover`, so the Safe
  cannot be one), and the contract enforces a strict majority,
  `2 × threshold > count`.
- **`oracle.reporters` / `quorum`** — same placeholder, also EOAs.
- **`token.mintCap`** — `"0"` means uncapped, and `deploy.ts` skips the cap step
  entirely when it is `"0"`.

---

Deploying is phased, driven by `PHASE=` against `scripts/deploy.ts`:

```bash
npm run deploy:testnet          # PHASE=deploy      stack + queue token actions
npm run queue-wires:testnet     # PHASE=queue-wires queue remote routers
npm run commit-wires:testnet    # PHASE=commit-wires commit routers + token actions
npm run verify:testnet          # PHASE=verify      explorer verification
```

**The token grant is timelocked, so deployment is not complete when
`PHASE=deploy` finishes.** That phase *queues* `BRIDGE_ROLE` and the mint cap;
`PHASE=commit-wires` settles them once the eta elapses. **The bridge cannot mint
or burn until that commit lands.** Wire the routers first, then commit
everything together.

Size the rate limit deliberately in the deploy template. `bridgeCapacity` /
`bridgePeriodSeconds` are pinned there at 10,000,000.00 NGN per rolling day —
stated explicitly rather than inherited from the script's fallback, so the value
shows up in review. Set it to plausible peak daily cross-chain volume, **not** to
total supply.

Supported networks are configured in [hardhat.config.ts](hardhat.config.ts):
BNB Smart Chain, Ethereum, Base, Arbitrum, Polygon, Avalanche, Optimism and
Asset Chain, plus their testnets.

---

## Documentation

| Doc | Covers |
|---|---|
| [docs/token-integration.md](docs/token-integration.md) | Integrating with the token: ABI surface, mint/burn semantics, error handling |
| [docs/operations.md](docs/operations.md) | Deploy, upgrade, timelock, rate-limit tuning, monitoring, incident response |
| [docs/multisig-admin-minter-setup.md](docs/multisig-admin-minter-setup.md) | Moving admin roles to a Gnosis Safe, with role IDs and selectors |

---

## Security model in one paragraph

Governance is an M-of-N multisig holding `DEFAULT_ADMIN_ROLE`; it queues and
commits every sensitive change behind a minimum 1-hour delay it cannot lower,
and it cannot remove itself. The bridge holds only `BRIDGE_ROLE`, which permits
synchronous mint and burn bounded by refilling rate limits and killable in one
transaction by any pauser. Compliance can pause, freeze and seize immediately.
Upgrades are content-addressed — the queued hash pins the implementation address
*and* the initializer calldata — and the storage layout is enforced in CI so a
refactor cannot silently corrupt live state.

**Out of scope and unreviewed here:** off-chain reserve attestation, operational
key management, the validator quorum's off-chain signing infrastructure, and the
price oracle's reporter set.
