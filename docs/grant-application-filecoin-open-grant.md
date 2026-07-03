# Open Grant Proposal: Echo — Universal AI Context Portability on Filecoin FEVM

**Proposal Category:** FVM / Integrations / Developer Tooling

**Proposer:** Kenneth Obasi (kennethumoekpe@gmail.com)

**GitHub Repository:** https://github.com/Mayorken/Echo

**Do you agree to open source all work you do that receives Filecoin grant funding?** Yes

**Project is:** Active (deployed to Calibration testnet, full test suite passing, live
demo running)

---

## Project Description

### The Problem

Every developer using AI tools pays an invisible tax: when you switch tools, you
start over.

A developer builds months of context with a coding assistant — their stack
preferences, architecture decisions, naming conventions, how they want code
explained. All of it lives inside one company's servers. Switch to a better
model, get your account suspended, or have the platform change its
infrastructure — and everything is gone.

Nobody has fixed this because no centralized company has an incentive to.
Lock-in is a feature for them, not a bug. Attempts to solve this with a
centralized database just move the trust problem — whoever runs the database
becomes the new gatekeeper.

### The Solution

Echo is a protocol layer that sits underneath AI tools rather than being one
itself. It treats AI context the same way OAuth treats identity — as a portable,
user-owned primitive that any tool can access with permission and no tool can
hold hostage.

The architecture is simple:

1. A user's context is encrypted on their device (AES-256-GCM) and stored on
   Filecoin via the Synapse SDK
2. A smart contract on FEVM holds the CID pointer and access list — the user
   controls which AI tools can read their context
3. Any AI tool with the right ABI and a granted address can call `getMemory()`
   and load full context instantly
4. An auto-renewal keeper monitors CIDs and re-pins expiring Filecoin deals from
   a pre-funded on-chain endowment

Switch from Claude to Gemini to Codex mid-project — the new tool picks up
exactly where the last one left off. No re-explaining. No starting over. And
because the storage lives on Filecoin rather than inside any AI company, no
platform can take it away.

### What Is Already Built

Echo is not a sketch. Every component below is deployed and working:

| Component | Status |
|---|---|
| `EchoMemoryRegistryV3.sol` — UUPS-upgradeable FEVM smart contract | Deployed: `0x962C42f208d89D5bF1698E3397BC78176D70cE0c` (Calibration) |
| Team Vaults — on-chain RBAC shared context for engineering teams | Complete |
| Keeper spend path — `keeperDeductRenewal()`, CEI + nonReentrant | Complete |
| `echo-sdk.js` — JavaScript SDK with real AES-256-GCM encryption | Complete |
| Synapse SDK storage adapter — real Filecoin deals on every `saveMemory()` | Complete |
| Auto-renewal keeper bot — scans events, checks deal status, re-pins | Complete |
| REST API — 13 endpoints, rate-limited, helmet-hardened | Complete |
| MCP server — 13 tools for Claude Desktop (stdio JSON-RPC transport) | Complete |
| OpenAPI 3.0 spec — ChatGPT Actions compatible | Complete |
| Funding bridge — Stripe webhook → `fundRenewal()` on-chain | Complete |
| Security audit — 0 critical/high, 5 medium/low remediated | Complete |
| Live demo — `npm run demo`, 6 scenarios, real chain, no external deps | Complete |

The contract has been live on Calibration testnet since June 21, 2026.
Running `npm run smoke` executes 8 live on-chain checks against it in seconds.

### Why Filecoin Specifically

The portability promise only holds if the underlying storage is genuinely
permanent and user-controlled.

Filecoin's perpetual-storage mechanism means a user funds a one-time endowment
and Echo's keeper keeps renewing the storage deal indefinitely — no
subscription, no company decision to reverse. Proof of Data Possession means
the integrity of stored context is mathematically verifiable, not just claimed.
And programmable access control via FEVM means the user's permissions aren't a
policy someone could quietly change — they're code running on a public network.

Echo creates real, ongoing Filecoin storage demand. Every `saveMemory()` call
makes a new Filecoin deal. Every keeper run renews expiring deals. As AI tool
adoption grows, so does the FIL locked in storage — permanently.

---

## Value to the Filecoin Ecosystem

**Demand-side storage:** Each Echo user generates multiple Filecoin storage
deals over their lifetime. A user who switches between three AI tools per week
creates a new deal on each context save and renewal. This is genuine paid
on-chain deal demand — exactly the usage Filecoin's 2026 roadmap is targeting.

**Three AI platforms connected to Filecoin storage today:** The MCP server
connects Claude Desktop users to Filecoin. The OpenAPI spec connects ChatGPT
users. The REST API connects every other AI tool with HTTP capabilities. Echo
is the first protocol that bridges mainstream AI tools to Filecoin at the
storage layer.

**Developer tooling that hides blockchain complexity:** The REST API and SDK
are Web2-native. A developer who has never used a blockchain can integrate Echo
with `npm install` and three lines of code. Every integration brings more
Filecoin storage usage without requiring the developer to understand Filecoin.

**Novel FVM use case:** On-chain access control for off-chain AI context
pointers is a new primitive. The keeper spend path — where an authorized
address pulls reimbursement from a user's on-chain balance after servicing
their storage deal — demonstrates a self-sustaining economic model built
entirely on FEVM.

---

## Deliverables

This grant funds four concrete deliverables:

### Deliverable 1: Mainnet Deployment and External Security Audit

- Engage a named external auditing firm (target: Cyfrin Updraft or Sherlock)
  for a formal audit of `EchoMemoryRegistryV3.sol` and supporting contracts
- Remediate any findings and publish the audit report
- Deploy `EchoMemoryRegistryV3` to Filecoin mainnet behind ERC1967 proxy
- Transfer contract ownership to a Gnosis Safe multisig (removes single-key
  admin risk)
- Verify contract source code on Filfox block explorer
- Deploy keeper daemon on mainnet, pointed at Synapse mainnet storage

### Deliverable 2: Hosted Gateway MVP

A hosted, Web2-accessible interface that lets developers and end-users use Echo
without self-hosting anything:

- **Social login** — Web3Auth integration (Google / GitHub sign-in), no wallet
  or seed phrase required, non-custodial key derivation
- **REST API with API key auth** — hosted instance of the existing REST API
  behind standard API key authentication (developers get a key on signup)
- **User dashboard** — single-page app showing: stored context, which tools
  have access, vault memberships, renewal balance and expiry estimate
- **Fiat funding** — Stripe checkout flow converts USD to FIL and calls
  `fundRenewal()` on-chain (the Stripe bridge is already built; this wires it
  to a payment UI)

### Deliverable 3: Published npm Package and Developer Documentation

- Publish `echo-sdk` to npm with TypeScript types
- Hosted documentation site covering: quickstart, SDK API reference,
  REST API reference, MCP configuration guide, integration tutorials for
  Claude Desktop, ChatGPT, and Gemini
- Three end-to-end integration guides (one per AI platform) published as
  open-source sample repositories
- One video walkthrough demonstrating the full portability scenario

### Deliverable 4: Keeper Operations and Monitoring

- Mainnet keeper deployed and running on a reliable host (Railway or Fly.io)
- Grafana monitoring dashboard tracking: vaults scanned, deals renewed, fees
  collected, errors
- Alerting on failed re-pins (PagerDuty or similar)
- Public status page so users can verify their vault's renewal status
- Operational runbook published in the repository

---

## Development Roadmap

### Milestone 1 — External Audit + Mainnet Deployment

**Duration:** 3 weeks
**Budget: $15,000**

| Task | Detail |
|---|---|
| External security audit | Engage Cyfrin or Sherlock; provide V3 source + internal audit report to reduce scope; remediate findings |
| Mainnet contract deployment | `npm run deploy` against mainnet RPC; verify addresses |
| Gnosis Safe setup | Deploy Safe on FEVM mainnet; `transferOwnership()` to Safe address |
| Contract verification | Submit source to Filfox; confirm bytecode match |
| Synapse mainnet wallet | Fund wallet with FIL + USDFC; configure keeper with `SYNAPSE_PRIVATE_KEY` |
| Keeper mainnet launch | Deploy keeper daemon; confirm first sweep runs cleanly |

**Verifiable completion criteria:**
- Audit report published in `/docs/` with firm name and findings
- Contract visible on Filfox mainnet explorer with verified source
- `owner()` on mainnet proxy returns a Gnosis Safe address
- Keeper logs show at least one successful mainnet sweep

---

### Milestone 2 — Hosted Gateway MVP

**Duration:** 4 weeks
**Budget: $20,000**

| Task | Detail |
|---|---|
| Web3Auth social login | Integrate `@web3auth/modal` into a React frontend; Google + GitHub providers; returns ethers Signer to SDK |
| API key auth middleware | Add API key generation + validation layer to REST API; keys scoped per user wallet |
| User dashboard | React SPA: context viewer, access list, vault list, renewal balance with expiry estimate |
| Stripe checkout → fundRenewal | Frontend checkout flow; webhook calls existing `fundRenewal()` on-chain |
| Hosting + domain | Deploy API on Railway or Fly.io; deploy frontend on Vercel; custom domain |

**Verifiable completion criteria:**
- Live URL reachable; sign in with Google; context saved and loaded end-to-end
- API key generation working; `curl` with key hits hosted REST API successfully
- Stripe test checkout successfully funds an on-chain vault
- Dashboard shows correct vault state for a signed-in user

---

### Milestone 3 — npm Package + Developer Documentation

**Duration:** 3 weeks
**Budget: $10,000**

| Task | Detail |
|---|---|
| npm publish | Add TypeScript type definitions; publish `echo-sdk` to npm registry |
| Documentation site | Docusaurus or similar; quickstart, SDK reference, REST API reference, MCP guide |
| Integration guides | Three sample repos: Claude Desktop, ChatGPT Actions, Gemini REST integration |
| Video walkthrough | Screen-recorded demo: developer switches between Claude and Gemini with zero context loss |

**Verifiable completion criteria:**
- `npm install echo-sdk` installs successfully
- Documentation site live at a public URL
- Three sample repositories public on GitHub with working READMEs
- Video published and linked from the main README

---

### Milestone 4 — Keeper Operations + Monitoring

**Duration:** 2 weeks
**Budget: $5,000**

| Task | Detail |
|---|---|
| Monitoring dashboard | Grafana instance tracking keeper sweep metrics |
| Alerting | PagerDuty or equivalent for failed re-pins or keeper crashes |
| Public status page | User-facing uptime page; shows last sweep time and vault health |
| Operational runbook | Published in `/docs/keeper-ops.md` |

**Verifiable completion criteria:**
- Grafana dashboard accessible at a public URL (read-only)
- Status page live with current keeper uptime and last-sweep timestamp
- Runbook published and linked from README

---

## Total Budget Summary

| Milestone | Duration | Cost |
|---|---|---|
| M1 — External Audit + Mainnet Deployment | 3 weeks | $15,000 |
| M2 — Hosted Gateway MVP | 4 weeks | $20,000 |
| M3 — npm Package + Documentation | 3 weeks | $10,000 |
| M4 — Keeper Operations + Monitoring | 2 weeks | $5,000 |
| **Total** | **12 weeks** | **$50,000** |

### Budget Rationale

**M1 — $15,000:** External smart contract audits from reputable firms (Cyfrin,
Sherlock, Trail of Bits) range from $10,000–$30,000 for a contract of this
scope. The internal audit report is already written and will reduce auditor time
significantly. Remainder covers deployment gas, Gnosis Safe setup, and keeper
hosting for the first month.

**M2 — $20,000:** The hosted gateway is the highest-leverage deliverable for
Web2 adoption. It requires frontend development (React, Web3Auth), backend
infrastructure (API key management, hosted REST API), and Stripe integration.
The Stripe webhook handler is already built; this milestone wires it to a
payment UI and deploys everything.

**M3 — $10,000:** Documentation is consistently the gap between a working
protocol and an adopted one. Three AI platforms require three distinct
integration paths. TypeScript types and an npm package lower the bar for Web2
developers who have never used ethers.js.

**M4 — $5,000:** A production keeper with monitoring and alerting is the
difference between Echo being a prototype and a service users can depend on.
Hosting costs and tooling are included.

---

## Team

**Kenneth Obasi** — Project Lead and Primary Developer

- Built the complete Echo infrastructure described in this proposal:
  `EchoMemoryRegistryV3.sol`, `echo-sdk.js`, keeper bot, REST API, MCP server,
  OpenAPI spec, funding bridge, and security audit
- Hands-on across Solidity, JavaScript/Node.js, ethers.js v6, Filecoin FEVM,
  Synapse SDK storage, and MCP protocol
- Repository: https://github.com/Mayorken/Echo

The codebase is open source and fully reviewable. The grant committee can run
`npm run demo` to see every component working end-to-end on a local chain in
under 2 minutes, or `npm run smoke` to verify the live Calibration deployment
in seconds.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| External audit finds critical issues requiring significant rework | Low | Internal audit already found and fixed 5 issues. V3 has CEI pattern, nonReentrant, and zero-address guards. Auditor scope is well-defined. |
| Web3Auth social login has UX friction on FEVM | Medium | Web3Auth supports custom EVM chains; Calibration and mainnet are EVM-compatible. Fallback: private key import for developers who prefer it. |
| Synapse mainnet storage costs exceed expectations | Low | USDFC-denominated pricing is predictable; the keeper fee mechanism already accounts for re-pinning costs. |
| Low initial developer adoption | Medium | MCP integration means every Claude Desktop user is one config block away from Echo. ChatGPT Actions integration means ChatGPT Plus users can try it with no code. The hosted gateway removes all self-hosting friction. |
| Single-developer team creates bus-factor risk | Medium | All code is open source, fully documented, and structured for handoff. Grant milestones are concrete and independently verifiable. |

---

## Additional Information

**Contract on Calibration testnet:**
`0x962C42f208d89D5bF1698E3397BC78176D70cE0c`
Verify live: `npm run smoke` (outputs block number, version, owner, 5 view calls)

**Quick local verification:**
```bash
git clone https://github.com/Mayorken/Echo
cd echo-contracts
npm install
npm run demo      # 6 scenarios, real chain, ~30 seconds
```

**Why now:** The AI tool market is consolidating around 3–4 dominant platforms
(Claude, ChatGPT, Gemini, Copilot). The window to establish context portability
as a protocol-level primitive — before each platform builds its own walled
garden solution — is the next 12–18 months. Echo is the only working
implementation of this primitive on Filecoin.

**Grant contact:** grants@fil.org / #grants-help on Filecoin Slack

**Application submitted via GitHub issue:** https://github.com/filecoin-project/devgrants
