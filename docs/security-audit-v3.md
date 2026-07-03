# Echo V3 Security Audit

**Scope:** `EchoMemoryRegistryV3.sol`, `contracts/shims/ReentrancyGuardUpgradeable.sol`, `keeper/index.js`, `echo-sdk.js` (`createWeb3AuthSigner`), `tools/funding-bridge.js`

**Audited by:** Internal review — Claude Sonnet 4.6

**Date:** 2026-06-21

**Previous audit:** [Devin AI — V1 security audit](../security-audit-report.md) (fixed 11 vulnerabilities, 11 tests added)

---

## Summary

| Severity | Found | Fixed | Documented only |
|---|---|---|---|
| Critical | 0 | — | — |
| High | 0 | — | — |
| Medium | 1 | 1 | — |
| Low | 4 | 4 | — |
| Informational | 4 | — | 4 |

No critical or high severity issues were found. All medium and low findings have been remediated in the same commit as this report.

---

## Findings

### [MEDIUM-01] `addKeeper` accepted `address(0)` and emitted duplicate events

**File:** `contracts/EchoMemoryRegistryV3.sol` — `addKeeper()`

**Description:** The function had no guard against `keeper == address(0)` and would emit a `KeeperAdded` event every call, even if the address was already authorized. While `address(0)` cannot sign transactions and therefore cannot call `keeperDeductRenewal`, polluted event logs could mislead off-chain monitoring tools into believing a new keeper had been added.

**Fix:** Added `if (keeper == address(0)) revert NotAuthorized()` and wrapped the state mutation + event emission in `if (!_authorizedKeepers[keeper])` so the event only fires on a real state change. Same pattern applied symmetrically to `removeKeeper`.

---

### [LOW-01] `grantVaultAccess` and `revokeVaultAccess` returned `NotVaultOwner` for non-existent vaults

**File:** `contracts/EchoMemoryRegistryV3.sol`

**Description:** If a caller passed a `vaultId` that had never been created, `_vaultOwner[vaultId]` returns `address(0)`, which never equals `msg.sender`, so both functions reverted with `NotVaultOwner`. This is misleading — the caller is not "the wrong owner," the vault simply doesn't exist.

**Fix:** Added `if (_vaultOwner[vaultId] == address(0)) revert VaultNotFound()` before the ownership check in both functions, giving callers an accurate error.

---

### [LOW-02] Keeper fee not sanity-checked in `keeper/index.js`

**File:** `keeper/index.js`

**Description:** `config.keeperFeeWei` was read from the environment without validation. A typo (e.g. extra zeros) could produce a fee larger than any user's balance. The contract would reject such a deduction, but the keeper would log errors on every vault and confuse operators into thinking the contract was broken.

**Fix:** Added a startup check that throws if `keeperFeeWei > 1 FIL`, with an explicit error message pointing to the misconfiguration. The threshold is intentionally conservative — legitimate fees for Synapse re-pinning are measured in milliwei, not whole FIL.

---

### [LOW-03] `createWeb3AuthSigner` gave an opaque error in Node.js

**File:** `echo-sdk.js`

**Description:** `createWeb3AuthSigner` calls `ethers.BrowserProvider` internally, which requires browser globals (`window`, `document`, `localStorage`). When called from Node.js it would throw deep inside Web3Auth's modal initialization with an error unrelated to the real problem.

**Fix:** Added an explicit `typeof window === 'undefined'` check at the top of the function that throws a clear, actionable error message pointing the caller to use `ethers.Wallet` directly instead.

---

### [LOW-04] Stripe webhook in `funding-bridge.js` had no idempotency guard

**File:** `tools/funding-bridge.js`

**Description:** Stripe's at-least-once delivery guarantee means `payment_intent.succeeded` can be delivered more than once if the endpoint returns 5xx or times out. Without idempotency, the same payment could trigger multiple `fundRenewal()` calls, each spending FIL from the bridge wallet.

**Fix:** Added an in-process `Set` (`processedIntents`) that tracks handled payment intent IDs. Duplicate deliveries are detected and skipped before any on-chain action. Noted in comments that a persistent store (Redis, DB) is needed for multi-process deployments.

---

## Informational Findings (no code change required)

### [INFO-01] Keeper trust model: authorized keepers can drain the full renewalBalance

`keeperDeductRenewal` allows a keeper to specify any `amount` up to the user's full `renewalBalance`. If the contract owner's key is compromised, an attacker could add a malicious keeper that drains all funded vaults. This is standard admin-key risk, not a code bug.

**Mitigations available to deployers:**
- Use a multisig (e.g. Gnosis Safe) as the contract owner
- Monitor `KeeperAdded` events on-chain
- Keep `renewalBalance` funded only to near-term renewal costs (a few months at a time)
- Users can call `withdrawRenewal()` at any time to pull their balance back

The V3 contract already documents this trade-off in the `addKeeper` NatSpec.

---

### [INFO-02] Vault ownership is immutable

Once created, a vault's owner (`_vaultOwner[vaultId]`) is never updated. There is no `transferVaultOwnership` function. Loss of the owner's key permanently prevents new members from being added or removed.

**Design rationale:** Ownership transfer introduces complex edge cases (transfer to zero, transfer to existing member, etc.) with no clear safe default. The recommended recovery path is creating a new vault under a fresh ID and migrating members manually. Document this in your team onboarding.

---

### [INFO-03] `_vaultMemberList` is append-only and unbounded

`grantVaultAccess` appends to `_vaultMemberList[vaultId]`. Revoking access sets the member's flag to `false` but does not remove them from the list. Vaults with many thousands of grants/revokes over time could make `getVaultMembers` expensive in gas.

**Impact:** Low. Normal team vaults have tens to hundreds of members, not thousands. The function is view-only (no gas in off-chain calls), and callers are already expected to filter through `hasVaultAccess`. No change made.

---

### [INFO-04] `ReentrancyGuardUpgradeable` shim storage layout must match OZ v4

`contracts/shims/ReentrancyGuardUpgradeable.sol` was created because OZ contracts-upgradeable v5.6 removed this contract. The shim reproduces the OZ v4 storage layout: `uint256 private _status` (1 slot) + `uint256[49] private __gap` (49 slots = 50 total), which matches OZ v4 exactly.

**Relevant only when upgrading an existing V1 proxy:** If V1 was originally deployed with a version of OZ that used a different `__gap` size, the `_status` slot would be misaligned in the upgraded V3 implementation. For fresh deployments this is not a concern. Operators upgrading an existing proxy should verify the OZ version used at original deploy time matches the shim's assumption.

---

## CEI Pattern Verification

`keeperDeductRenewal` follows Checks-Effects-Interactions correctly:

```solidity
// Checks
if (!_authorizedKeepers[msg.sender]) revert NotKeeper();
if (amount == 0 || amount > vault.renewalBalance) revert InsufficientRenewalBalance();

// Effects
vault.renewalBalance -= amount;       // ← state written BEFORE external call

// Interactions
(bool ok, ) = msg.sender.call{value: amount}("");
if (!ok) revert TransferFailed();

emit KeeperReimbursed(msg.sender, user, amount);
```

Combined with the inherited `nonReentrant` modifier, reentrancy into `keeperDeductRenewal` (or any other `nonReentrant` function on this contract) during the external call is blocked at the EVM level.

---

## Scope exclusions

- **V1 contract logic** — covered by the Devin V1 audit
- **Synapse SDK / Filecoin storage** — third-party, out of scope
- **Web3Auth library internals** — third-party, out of scope
- **Stripe API security** — third-party, out of scope
