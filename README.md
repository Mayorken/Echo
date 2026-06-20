# Echo — Universal AI Context Portability

The infrastructure layer that makes AI context portable — the same way OAuth
made identity portable across the web. One smart contract on Filecoin's EVM
(FEVM) that any AI tool can integrate against, so a user's accumulated context
survives switching platforms, bans, or a company shutting down.

This isn't a sketch — every piece below actually runs. The contract compiles,
the full test suite passes against a real local chain, and the SDK does real
AES-256-GCM encryption, not a placeholder. What's still missing before a real
launch is scoped honestly at the bottom.

## The problem

Every knowledge worker who uses AI tools faces the same invisible tax: when
you switch, you start over.

A developer builds months of context with a coding assistant — stack
preferences, architecture decisions, naming conventions, how they like code
explained. All of it lives inside one company's servers. Switch to a better
model, get your account suspended, or have the platform reset its
infrastructure — and everything is gone.

Nobody has fixed this because no centralized company has an incentive to:
lock-in is a feature for them, not a bug.

## What Echo does

Echo sits underneath AI tools rather than being one itself. Every piece of
context an AI learns about a user or project gets encrypted on the user's
device and stored on Filecoin under a smart contract the user controls. That
contract decides which AI tools are allowed to read it, and the user can
change that at any time.

Switch from one AI to another, and the new one picks up exactly where the
last one left off. No re-explaining. No starting over. No platform holding
months of accumulated context hostage.

## A real scenario

A developer is building an API with Codex. Codex knows their Go codebase,
their encryption approach, their preferred patterns. They want Claude's
opinion on the storage architecture. They switch — Claude reads their Echo
context and responds with full awareness of the project, no introduction
needed. They ask Gemini to review the overall design. Same context, complete
picture. They revoke Codex's access at the end of the session. All of this
happens seamlessly because the context was never inside any of those platforms
— it was always the developer's, stored on Filecoin, readable only by whoever
they authorize.

## What's in here

- **`contracts/EchoMemoryRegistry.sol`** — the on-chain piece. UUPS-upgradeable
  (via OpenZeppelin), deployed behind an ERC1967 proxy. Holds a pointer (CID)
  to each user's encrypted context file, the access-control logic deciding
  which AI tools can read it, a FIL renewal endowment per user, and OZ's
  `ReentrancyGuardUpgradeable` on the withdrawal function.
- **`contracts/EchoMemoryRegistryV2.sol`** — example upgrade target that adds a
  `version()` getter. Used by the test suite to prove the upgrade flow works.
- **`echo-sdk.js`** — the client library an AI tool integrates: `saveMemory`,
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
- **`index.html`** — an interactive demo showing a developer switching between
  Codex, Claude, and Gemini mid-project with zero context loss — the core
  portability scenario in action.
- **`test/EchoMemoryRegistry.test.js`** — 13 tests against the raw contract on
  a local in-memory chain, including a test that deploys an actual malicious
  contract and tries to exploit re-entrancy, to prove the guard works rather
  than just exists.
- **`test/EchoClient.e2e.test.js`** — 5 tests against the *full* SDK: real
  encryption, a real deployed contract, an in-memory stand-in for the
  Filecoin storage adapter. Covers the full save → grant → load flow, wrong
  decryption keys, revoked access, and renewal funding.
- **`keeper/`** — auto-renewal keeper bot. `scanner.js` finds funded vaults
  via contract events, `renewer.js` checks deal status and re-pins via
  Lighthouse, `index.js` orchestrates periodic sweeps. `keeper.js` is the
  CLI entry point.
- **`integrations/`** — AI platform integration adapters:
  - `rest-api.js` — Express HTTP API wrapping all Echo SDK operations.
  - `mcp-server.js` — MCP tool server for Claude Desktop (stdio transport).
  - `openapi.json` — OpenAPI 3.0 spec for ChatGPT Actions compatibility.
- **`deploy.js`** — deploys implementation + ERC1967 proxy to Filecoin's
  Calibration testnet.
- **`compile.js`** / **`compile-helper.js`** — compile the contract(s) and
  produce the ABI (`EchoMemoryRegistry.abi.json`, already generated).

Run `npm test` yourself — 114 tests passing, no network access required.

## How the pitch maps to the code

| Pitch claim | Where it lives |
|---|---|
| "Context never disappears" | `fundRenewal()` / `renewalBalanceOf()` — the FIL endowment pattern mirroring Filecoin's perpetual-storage actor concept |
| "You control who reads it" | `grantAccess()` / `revokeAccess()` / `hasAccess()` — a data-access-control actor pattern |
| "Switch tools, keep your context" | Any AI tool holding the right ABI + a granted address can call `getMemory()` — that's the whole portability story, tested end-to-end in `EchoClient.e2e.test.js` |
| "Verifiable, not just promised" | `integrityHash` stored on-chain at write time, checked client-side via keccak256 on every decrypt |

## Why Filecoin specifically

The portability promise only works if the underlying storage is genuinely
permanent and genuinely user-controlled. A centralized database can be
deleted, modified, acquired, or shut down.

Filecoin's perpetual-storage mechanism means a user funds a one-time
endowment and a smart contract keeps renewing the storage deal indefinitely —
no subscription, no company decision to reverse. Proof of Data Possession
means the integrity of stored context is mathematically verifiable, not just
claimed. And programmable access control via the Filecoin Virtual Machine
means the user's permissions aren't a policy someone could quietly change —
they're code running on a public network.

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

## Contract upgradability (UUPS)

The contract is deployed behind an ERC1967 proxy using the UUPS pattern
(OpenZeppelin v5). This means:

- The **proxy address is permanent** — AI tools integrate against it and never
  need to change their contract address when the implementation is upgraded.
- **Only the owner** (set at deploy time via `initialize()`) can authorize an
  upgrade by calling `upgradeToAndCall(newImpl, data)`.
- **All user data is preserved** across upgrades — vaults, access lists,
  renewal balances, and granted-app history all live in proxy storage.

To upgrade in production:
```bash
# 1. Deploy the new implementation
node -e "const {ethers}=require('ethers'); const {compileAll}=require('./compile-helper'); ..."

# 2. Call upgradeToAndCall on the proxy (from the owner wallet)
proxy.upgradeToAndCall(newImplAddress, '0x')
```

The test suite exercises the full V1→V2 upgrade cycle: deploy V1 behind proxy,
write data, upgrade to V2, verify all storage is intact and `version()` returns 2.

## Auto-renewal keeper bot

The keeper monitors funded vaults and automatically re-pins context whose
Filecoin storage deal is expiring or missing.

```bash
# One-time sweep:
RPC_URL=https://api.calibration.node.glif.io/rpc/v1 \
CONTRACT_ADDRESS=0x... \
LIGHTHOUSE_API_KEY=your-key \
node keeper.js --once

# Long-running daemon (sweeps every hour by default):
node keeper.js
```

**How it works:**
1. `keeper/scanner.js` scans `MemoryUpdated` events to find vaults with both
   a CID and a non-zero `renewalBalance`
2. `keeper/renewer.js` checks each CID's Filecoin deal status via
   `lighthouse.dealStatus` — classifies as `active`, `expiring`, or `no-deal`
3. For expiring or missing deals, it re-pins by fetching the data from the
   IPFS gateway and re-uploading via `lighthouse.uploadBuffer`

**Environment variables:**

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | Yes | FEVM RPC endpoint |
| `CONTRACT_ADDRESS` | Yes | EchoMemoryRegistry proxy address |
| `LIGHTHOUSE_API_KEY` | Yes | Lighthouse API key for re-pinning |
| `KEEPER_INTERVAL_MS` | No | Sweep interval in ms (default: 3600000 = 1 hour) |
| `KEEPER_FROM_BLOCK` | No | Block to start scanning from (default: 0) |
| `KEEPER_GATEWAY` | No | Custom IPFS gateway URL |

**Current limitation:** the keeper operator pays for re-pinning via their
Lighthouse API key. The on-chain `renewalBalance` tracks the user's funding
commitment but isn't deducted automatically — that requires a contract upgrade
to add a keeper-authorized spend path (planned).

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
4. The script deploys the implementation + ERC1967 proxy and prints both
   addresses. Use the **proxy address** when instantiating `EchoClient`.

## AI platform integrations

Echo ships with integration adapters for the two dominant AI platform patterns:

### REST API (all platforms)

A standard HTTP API wrapping the Echo SDK. Works with ChatGPT Actions,
Gemini, or any AI tool with HTTP capabilities.

```bash
RPC_URL=https://api.calibration.node.glif.io/rpc/v1 \
CONTRACT_ADDRESS=0x... \
PRIVATE_KEY=0x... \
LIGHTHOUSE_API_KEY=your-key \
ENCRYPTION_KEY=hex-encoded-32-byte-key \
node integrations/rest-api.js
```

Endpoints: `POST /context/save`, `GET /context/load/:userAddress`,
`POST /access/grant`, `POST /access/revoke`, `GET /access/list/:userAddress`,
`POST /renewal/fund`, `POST /key/generate`, `GET /health`.

### ChatGPT Actions (OpenAPI)

Import `integrations/openapi.json` as a ChatGPT Action schema. Point the
server URL at your running REST API. ChatGPT can then save/load/manage
Echo context directly from conversations.

### Claude Desktop (MCP)

Add Echo as an MCP tool server in `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": ["path/to/Echo/integrations/mcp-server.js"],
      "env": {
        "RPC_URL": "https://api.calibration.node.glif.io/rpc/v1",
        "CONTRACT_ADDRESS": "0x...",
        "PRIVATE_KEY": "0x...",
        "LIGHTHOUSE_API_KEY": "your-key",
        "ENCRYPTION_KEY": "hex-encoded-32-byte-key"
      }
    }
  }
}
```

Claude Desktop will then have 7 tools: `echo_save_context`,
`echo_load_context`, `echo_grant_access`, `echo_revoke_access`,
`echo_list_access`, `echo_fund_renewal`, `echo_generate_key`.

### Environment variables (integrations)

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | Yes | FEVM RPC endpoint |
| `CONTRACT_ADDRESS` | Yes | EchoMemoryRegistry proxy address |
| `PRIVATE_KEY` | Yes | Wallet private key for signing txs |
| `LIGHTHOUSE_API_KEY` | Yes | Lighthouse API key for Filecoin storage |
| `ENCRYPTION_KEY` | No | Hex-encoded 32-byte key (generated if omitted) |
| `PORT` | No | REST API port (default: 3000) |

## Suggested next steps for a real build

1. ~~Wire the `storage` adapter to an actual Filecoin upload/retrieval SDK.~~
   **Done** — `lib/storage.js` uses Lighthouse.
2. ~~Add an upgradability pattern (UUPS proxy).~~
   **Done** — contract is now UUPS-upgradeable via OpenZeppelin v5.
3. ~~Build the auto-renewal keeper.~~
   **Done** — `keeper/` monitors funded vaults and re-pins expiring CIDs via Lighthouse.
4. ~~Build the first AI platform integration.~~
   **Done** — REST API, MCP server for Claude Desktop, and OpenAPI spec for ChatGPT Actions.
5. Get a real audit before this touches real user data or real FIL at scale
   — this scaffold is tested for correctness, not reviewed for security.
6. Add a keeper-authorized spend path to the contract so the keeper can
   deduct re-pinning costs from each vault's `renewalBalance` automatically.
