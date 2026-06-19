# Echo — technical scaffold

A working implementation of the portable AI-memory layer described in the
product concept: one smart contract on Filecoin's EVM (FEVM) that any AI
companion app can integrate against, so a user's memory survives switching
apps, bans, or a company shutting down.

This isn't a sketch — every piece below actually runs. The contract compiles,
the full test suite passes against a real local chain, and the SDK does real
AES-256-GCM encryption, not a placeholder. What's still missing before a real
launch is scoped honestly at the bottom.

## What's in here

- **`contracts/EchoMemoryRegistry.sol`** — the on-chain piece. Holds a pointer
  (CID) to each user's encrypted memory file, the access-control logic
  deciding which AI apps can read it, a FIL renewal endowment per user, and a
  re-entrancy guard on the function that pays FIL out.
- **`echo-sdk.js`** — the client library an AI app integrates: `saveMemory`,
  `loadMemory`, `grantAccess`, `revokeAccess`, `fundRenewal`. Uses real
  AES-256-GCM encryption (`lib/crypto.js`) and wraps the signer in an
  `ethers.NonceManager` — more on why below.
- **`lib/crypto.js`** — real AES-256-GCM: Web Crypto API in-browser (where
  this actually runs), Node's `crypto` module as a fallback so the file is
  testable directly in Node.
- **`lib/storage.js`** — Lighthouse storage adapter. Implements the
  `put(bytes)->cid` / `get(cid)->bytes` interface EchoClient expects, backed
  by real Filecoin storage via [Lighthouse](https://lighthouse.storage).
  Upload via `uploadBuffer`, retrieval via IPFS gateway.
- **`test/EchoMemoryRegistry.test.js`** — 13 tests against the raw contract on
  a local in-memory chain, including a test that deploys an actual malicious
  contract and tries to exploit re-entrancy, to prove the guard works rather
  than just exists.
- **`test/EchoClient.e2e.test.js`** — 5 tests against the *full* SDK: real
  encryption, a real deployed contract, an in-memory stand-in for the
  Filecoin storage adapter. Covers the full save → grant → load flow, wrong
  decryption keys, revoked access, and renewal funding.
- **`deploy.js`** — deploys to Filecoin's Calibration testnet.
- **`compile.js`** / **`compile-helper.js`** — compile the contract(s) and
  produce the ABI (`EchoMemoryRegistry.abi.json`, already generated).

Run `npm test` yourself — 18 tests, all passing, no network access required.

## How the pitch maps to the code

| Pitch claim | Where it lives |
|---|---|
| "Memory never disappears" | `fundRenewal()` / `renewalBalanceOf()` — the FIL endowment pattern mirroring Filecoin's perpetual-storage actor concept |
| "You control who reads it" | `grantAccess()` / `revokeAccess()` / `hasAccess()` — a data-access-control actor pattern |
| "Switch apps, keep your memory" | Any app holding the right ABI + a granted address can call `getMemory()` — that's the whole portability story, tested end-to-end in `EchoClient.e2e.test.js` |
| "Verifiable, not just promised" | `integrityHash` stored on-chain at write time, checked client-side via keccak256 on every decrypt |

## Bugs this testing process actually found and fixed

Worth knowing about, since they'd bite a real deployment too:

- **EVM version mismatch.** Solidity 0.8.24's default target uses the `PUSH0`
  opcode, which isn't supported by every EVM implementation a contract might
  land on. Pinned `evmVersion: 'london'` in every compile path so the
  contract doesn't quietly depend on an opcode some chains (or older FEVM
  versions) won't recognize.
- **Stale nonce reads.** Sending several transactions back-to-back from the
  same address (save, then grant, then revoke) intermittently failed or hung
  because the provider served a momentarily stale "pending nonce" rather than
  the real one. Fixed by wrapping signers in `ethers.NonceManager` (tracks
  the next nonce locally instead of re-querying) and disabling the provider's
  short-lived read cache (`cacheTimeout: -1`). If you ever see a transaction
  "hang forever" against a fast-mining chain, this is usually why.

## What's intentionally still stubbed out

- **Auto-renewal keeper.** `fundRenewal()` holds a real FIL balance per user,
  but nothing yet actually renews a storage deal from it. That needs either
  an off-chain keeper bot (faster to ship) or a dedicated FVM actor (closer
  to the actual pitch).

## Using real Filecoin storage (Lighthouse)

The SDK ships with a Lighthouse adapter for real Filecoin storage:

```javascript
const { EchoClient, generateEncryptionKey, createLighthouseStorage } = require('./echo-sdk');

const storage = createLighthouseStorage(process.env.LIGHTHOUSE_API_KEY);
const client  = new EchoClient(rpcUrl, contractAddress, signer, storage);

// Now saveMemory/loadMemory use real Filecoin storage
const key = await generateEncryptionKey();
await client.saveMemory({ stack: ['Go', 'PostgreSQL'], task: 'listing endpoint' }, key);
```

Get a free API key at [files.lighthouse.storage](https://files.lighthouse.storage).
Premium users can pass a custom gateway: `createLighthouseStorage(key, { gateway: 'https://your-gateway.io/ipfs' })`.

## Verifying it yourself

```
npm install
npm run compile   # compiles the contract, regenerates the ABI
npm test          # 18 tests, real local chain, no network needed
```

## Deploying to Filecoin Calibration testnet

1. Get a wallet funded with test FIL from the Calibration faucet.
2. `export PRIVATE_KEY=0x...` (never commit a real key).
3. `npm run deploy`
4. Copy the printed contract address into wherever `echo-sdk.js` gets
   instantiated.

## Suggested next steps for a real build

1. ~~Wire the `storage` adapter to an actual Filecoin upload/retrieval SDK.~~
   **Done** — `lib/storage.js` uses Lighthouse.
2. Decide on the renewal-keeper approach (off-chain bot vs. FVM actor) and
   build it — right now the endowment is funded but inert.
3. Add an upgradability pattern (UUPS proxy is the common choice) before any
   mainnet deployment, so the contract can evolve without forcing every
   integrated tool to migrate to a new address.
4. Get a real audit before this touches real user data or real FIL at scale
   — this scaffold is tested for correctness, not reviewed for security.
5. Build the first real AI platform integration (e.g. a ChatGPT / Claude
   plugin that reads and writes Echo context).
