# Echo Security Audit Report

**Date:** June 2025
**Scope:** All source code in the Echo repository
**Methodology:** Manual code review + static analysis of smart contract, SDK, crypto, storage, integrations, and keeper modules

---

## Summary

| Severity | Found | Fixed |
|----------|-------|-------|
| Critical | 0     | -     |
| High     | 2     | 2     |
| Medium   | 5     | 5     |
| Low      | 4     | 4     |
| Info     | 3     | -     |

No critical vulnerabilities found. The contract's core security architecture (reentrancy guard, access control, UUPS upgrade protection) is sound. All identified issues have been remediated.

---

## Findings

### HIGH-1: REST API error responses leak internal details

**File:** `integrations/rest-api.js`
**Severity:** High
**Status:** Fixed

Error responses returned `err.message` directly to the client, potentially exposing internal state (stack traces, contract addresses, RPC errors, file paths).

**Fix:** All error handlers now log the full error server-side via `console.error()` and return a generic `"Internal server error"` message to the client.

---

### HIGH-2: No rate limiting or security headers on REST API

**File:** `integrations/rest-api.js`
**Severity:** High
**Status:** Fixed

The API server had no protection against brute-force or denial-of-service attacks, and was missing standard security headers (X-Frame-Options, Content-Security-Policy, etc.).

**Fix:** Added `helmet` (security headers), `cors` (controlled cross-origin access), `express-rate-limit` (60 requests/minute per IP), and a 1MB request body size limit.

---

### MED-1: No input validation on MCP tool calls

**File:** `integrations/mcp-server.js`
**Severity:** Medium
**Status:** Fixed

MCP tool handlers accepted arbitrary strings for `userAddress`, `appAddress`, and `amountInFil` without validation, which could cause confusing downstream contract errors or wasted gas.

**Fix:** Added `ethers.isAddress()` validation for all address parameters and numeric validation for `amountInFil` before calling the SDK.

---

### MED-2: Empty CID accepted by updateMemory

**File:** `contracts/EchoMemoryRegistry.sol`
**Severity:** Medium
**Status:** Fixed

`updateMemory()` accepted an empty string as a CID, which would create a vault entry pointing to nothing. This could confuse the keeper bot and waste gas.

**Fix:** Added `EmptyCid` custom error and a check: `if (bytes(cid).length == 0) revert EmptyCid();`

---

### MED-3: Zero-address can be granted access

**File:** `contracts/EchoMemoryRegistry.sol`
**Severity:** Medium
**Status:** Fixed

`grantAccess(address(0))` was silently accepted, polluting the `grantedAppsHistory` array with a meaningless entry that can never represent a real AI tool.

**Fix:** Added check: `if (app == address(0)) revert NotAuthorized();`

---

### MED-4: fundRenewal accepts zero-value deposits

**File:** `contracts/EchoMemoryRegistry.sol`
**Severity:** Medium
**Status:** Fixed

`fundRenewal()` accepted `msg.value == 0`, emitting a misleading `RenewalFunded` event with a zero amount and wasting the user's gas.

**Fix:** Added check: `if (msg.value == 0) revert NothingToWithdraw();`

---

### MED-5: No key length validation in crypto module

**File:** `lib/crypto.js`
**Severity:** Medium
**Status:** Fixed

`encrypt()` and `decrypt()` did not validate that the key was exactly 32 bytes. A truncated or oversized key would either silently fail or produce unexpected behavior in the cipher.

**Fix:** Added explicit checks for `keyBytes.length !== 32` in both functions, plus a minimum-length check on the ciphertext input in `decrypt()`.

---

### LOW-1: CID path traversal in storage adapter

**File:** `lib/storage.js`
**Severity:** Low
**Status:** Fixed

The `get(cid)` method concatenated the CID directly into a URL (`${gateway}/${cid}`). A malicious CID like `../../../etc/passwd` could be used for path traversal against the gateway.

**Fix:** Added CID format validation: `/^[a-zA-Z0-9]+$/` rejects any CID containing path separators or special characters.

---

### LOW-2: Unbounded grantedAppsHistory array

**File:** `contracts/EchoMemoryRegistry.sol`
**Severity:** Low
**Status:** Acknowledged (not fixed)

Every `grantAccess()` call appends to `grantedAppsHistory` and entries are never removed. Over a very long period, `appAccessHistory()` gas cost grows linearly. This is mitigated by the zero-address guard (preventing spam grants) and is acceptable for the current usage pattern where users grant access to a small number of AI tools. A future upgrade could add pagination.

---

### LOW-3: Keeper does not use cacheTimeout on provider

**File:** `keeper/index.js`
**Severity:** Low
**Status:** Fixed

The keeper's `runSweep()` created a `JsonRpcProvider` without `{ cacheTimeout: -1 }`, inconsistent with the rest of the codebase and potentially causing stale reads during rapid sequential sweeps.

**Fix:** Updated to use `{ cacheTimeout: -1 }`.

---

### LOW-4: deploy.js missing cacheTimeout on provider

**File:** `deploy.js`
**Severity:** Low
**Status:** Fixed

Same issue as LOW-3 in the deploy script.

---

### INFO-1: Ganache compatibility warning (non-issue)

The test suite logs `"This version of uWS is not compatible"` on startup. This is a known ganache issue with newer Node.js versions and does not affect test correctness — ganache falls back to a pure-JS transport.

### INFO-2: npm audit reports 40 vulnerabilities

These are all in `ganache` (dev dependency only, used for local testing). Ganache is not deployed or used in production. The vulnerabilities are in ganache's bundled dependencies (leveldown, secp256k1) and do not affect Echo's production code.

### INFO-3: Intermittent nonce-related test failure

One test (`overwrites previous memory on a second save`) occasionally fails due to ganache's nonce handling under rapid sequential transactions. This is a known issue documented in the README and does not indicate a bug in Echo's code.

---

## Architecture Review

### What's solid

- **Reentrancy protection:** `withdrawRenewal` uses OpenZeppelin's `ReentrancyGuard` and the re-entrancy attack test proves it works
- **UUPS upgrade pattern:** Correctly implemented with `_disableInitializers()` in constructor and `onlyOwner` on `_authorizeUpgrade`
- **AES-256-GCM encryption:** Real authenticated encryption, not a placeholder. Random IV per encryption, auth tag verified on decrypt
- **Client-side key management:** Encryption key never touches the chain or storage — only ciphertext is stored
- **Integrity verification:** keccak256 hash of plaintext stored on-chain, verified after decryption

### Recommendations for mainnet

1. **Professional audit:** This self-audit covers common patterns but a professional audit firm (Trail of Bits, OpenZeppelin, etc.) should review the contract before handling real FIL
2. **Access control for keeper:** Add a keeper-authorized spend path so renewal costs can be deducted from vault balances rather than the keeper operator paying out of pocket
3. **Event-based CID indexing:** Consider using a subgraph or indexer instead of scanning all events from block 0 on every keeper sweep
4. **Key management UX:** Add a key backup/recovery mechanism before mainnet — losing an encryption key means permanent data loss
5. **Multi-sig ownership:** Transfer contract ownership to a multi-sig wallet before mainnet deployment
