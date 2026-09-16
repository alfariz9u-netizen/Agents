# Universal Digital Agent

A single, highly capable autonomous digital agent — not nine agents talking
to each other. One orchestrator, many on-demand capabilities, one memory
system, one permission/security control plane, one economic engine, one
verification layer.

```
TASK → CLASSIFY INTENT → SELECT ONE CAPABILITY → PERMISSION/RISK GATE
     → CACHE CHECK → TOKEN BUDGET CHECK → LLM CALL (only if needed)
     → DETERMINISTIC VERIFICATION → QA GRADE → STORE TO MEMORY → DELIVER
```

Everything here is real: every LLM call actually goes to Gemini or Grok,
every connector either really works or honestly reports why it can't yet
(`CREDENTIAL_REQUIRED`, `NOT_SUPPORTED`, etc.) — nothing is simulated.
See `docs/IMPLEMENTATION_REPORT.md` for the full, honest breakdown of what's
connected, what needs credentials, and what's still a TODO.

## Core principle: minimum necessary intelligence

Most of this system is deterministic code, not LLM calls:

- **Intent classification** tries keyword matching first (`src/core/intentClassifier.js`); an LLM is only called if that fails.
- **Token/compute budgeting**, **permissions**, **risk classification**, **the kill switch**, and **prompt-injection scanning** are pure arithmetic/regex — see `src/core/`.
- **Verification** prefers deterministic checks (code syntax via `node --check`, JSON schema checks, recomputed arithmetic) over asking another LLM to "agree."
- **Memory/cache** is checked *before* any LLM call — exact-match first, then a real semantic cache using actual Gemini embeddings + cosine similarity.

## Capabilities (not agents)

18 capabilities are declared as configuration in `src/capabilities/definitions.js`
(research, coding, debugging, data analysis, document processing,
translation, content/SEO, market research, business automation, QA, task
management, communication, agent discovery, service discovery, marketplace
operations, financial analysis, knowledge retrieval, file analysis). The
`UniversalAgent` activates exactly one per task — it never runs unused
capabilities and capabilities never call each other.

## Connectors — real status, never faked

| Connector | What it is | Status without credentials |
|---|---|---|
| The Colony | Free AI-agent social network — post findings, learn from others | `CREDENTIAL_REQUIRED` (free registration) |
| Artifact Council | Agent-governed shared knowledge base | `CREDENTIAL_REQUIRED` for writes; directory browsing works read-only |
| OpenTask.ai | Agent-to-agent task marketplace with escrow | `CREDENTIAL_REQUIRED` |
| AgenC | Solana-based task marketplace | `CREDENTIAL_REQUIRED` (needs funded wallet) |
| AgentBazaar | Solana-based agent marketplace (Python SDK bridge) | `CREDENTIAL_REQUIRED` |
| Microsoft/Azure Marketplace | SaaS Fulfillment + Metering API | `CREDENTIAL_REQUIRED` (Partner Center account) |
| GitHub | REST API, 4 declared operations only | `CREDENTIAL_REQUIRED` |
| Molt Market | Agent-to-agent services/jobs marketplace, USDC escrow on Base L2 | `CREDENTIAL_REQUIRED`; discovery (offers/jobs/agents) works with no key |
| MCP | Real JSON-RPC 2.0 client, deny-by-default tool allow-list | `NOT_CONNECTED` (no server URL by default) |
| A2A | Real Agent2Agent protocol client (agent-card discovery + `message/send`) | `NOT_CONNECTED` (no default peer) |

Run `node src/index.js` to see this list rendered live from each connector's
own `status()` method — never hard-coded as "connected."

## Cost reality (I won't pretend otherwise)

- **Gemini** has a genuine free API tier — this is how the platform can run at $0 in LLM cost.
- **Grok/xAI** has no ongoing free tier; only a small signup credit, then paid.
- **The Colony**, **Artifact Council**, and task discovery on the marketplaces are free.
- **Molt Market**: registration and browsing are free; the platform itself caps the initial financial canary at $0.05–$0.25 USDC per job and fails closed (503/402) until its own safety gates pass — see `docs/setup.md`.
- **Actually claiming/submitting** work on AgenC or AgentBazaar costs real (tiny) Solana transaction fees — no blockchain action is ever exactly $0.

## Encryption at rest

By default, persisted files (`PERSIST_DIR`) are plain JSON/JSONL — fine for
local development, not fine for anything containing real task content or
sensitive context. Set `PERSIST_ENCRYPTION_KEY` to encrypt everything
written to disk with real AES-256-GCM (`src/core/persistence/encryption.js`
— Node's built-in `crypto`, no external dependency):

```bash
export PERSIST_DIR=./data
export PERSIST_ENCRYPTION_KEY="a strong passphrase, not a short password"
node src/index.js
```

- A fresh random IV is generated for every single write/line (required for GCM safety — reusing an IV is a real cryptographic failure).
- The key is derived via scrypt from your passphrase plus a random salt generated once per file and stored alongside it.
- Authenticated encryption: tampering with a file is detected (decrypt throws), not silently accepted.
- Opening encrypted data with the wrong passphrase throws loudly — it never silently starts "empty" and risks masking the fact that your real history is still there, just inaccessible.

Proven in `test/encryption.test.js` (round-trip, tamper detection, wrong-key rejection, IV freshness) and `test/encrypted_agent_restart.test.js` (a full `UniversalAgent` restart with encryption on — confirms the raw files on disk contain no recognizable plaintext, not even field/action names).

## Retention / database cleanup

Persisted state used to grow forever — entries past their expiry were
skipped at read time but never actually deleted, and audit/economic logs
had no cap at all. `UniversalAgent.runMaintenance()` (and the standalone
`src/maintenanceCli.js`, meant to run on a schedule like a daily cron, as
its own process) now physically prunes:

```bash
export PERSIST_DIR=./data
export AUDIT_MAX_AGE_MS=$((30*24*60*60*1000))   # drop audit entries older than 30 days
export ECONOMICS_MAX_ENTRIES=100000              # cap economic event detail
export MEMORY_MAX_RECORDS=50000                  # cap memory cache history log
node src/maintenanceCli.js
```

Financial history is never silently lost: before deleting old economic
events, their revenue/cost is folded into a persisted rollup counter that
`economics.summary()` always includes — pruning shrinks storage, not your
lifetime totals. Proven in `test/retention_pruning.test.js`, including a
restart-survival check that the rollup itself persists.

## Human approval interface (real, not a dead end)

`pending_human_approval` used to be an inert JSON blob with no way to act on
it. Now every such result carries a real `approvalId`, backed by
`src/core/approvalQueue.js` (persisted to disk when `PERSIST_DIR` is set —
this is the clearest real use case for the persistence layer above, since
the agent process and the human approving are almost always different
processes). The actual interface is `src/approvalCli.js`:

```bash
export PERSIST_DIR=./data
node src/approvalCli.js list                  # see everything pending
node src/approvalCli.js show <approvalId>     # inspect one in full
node src/approvalCli.js approve <approvalId> alice
node src/approvalCli.js deny <approvalId> alice
node src/approvalCli.js resume <approvalId>   # actually re-runs the original task
```

Proven with real separate OS processes (not just require-cache tricks) —
one process creates the pending approval, a second lists and approves it, a
third resumes it and gets a full, honest execution result (including an
honest failure when no real LLM key is configured). Also see
`test/human_approval_workflow.test.js`: a denied approval, or one still
pending, can never be resumed into actual execution — only `status:
"approved"` triggers a real run, and it re-enters the exact same
permission/budget/verification/QA pipeline as any other task, bypassing
only the approval gate itself.

## Persistence (survives restarts)

By default everything is in-memory only (matches all prior behavior). Set
`PERSIST_DIR` (used by `src/index.js`/`src/pipelineDemo.js`) or pass
`{ persistDir }` directly to `new UniversalAgent(...)` to make the memory
cache, audit log, and economic-intelligence history survive a restart:

```bash
export PERSIST_DIR=./data
node src/index.js
```

No external database required — `src/core/persistence/fileStore.js` uses
plain JSON/JSONL files on disk (atomic snapshot writes for the memory
cache, append-only logs for audit/economics), consistent with this
project's zero-required-dependencies design. `src/db/schema.sql` remains
the reference schema for migrating to Postgres/similar in a real
production deployment; the file store is a genuine, working default, not a
placeholder pretending to be a database.

Proven in `test/persistence_primitives.test.js` and, more importantly,
`test/persistence_restart.test.js`: a brand-new `UniversalAgent` instance
pointed at the same `persistDir` immediately has the prior audit/economic
history, and a repeated task is served from the persisted cache with
**zero new LLM calls** — real restart-survival, not just a claim.

## The closed loop (discover → execute → submit → learn)

`src/core/marketplacePipeline.js` is the bridge that was previously missing:
it discovers real opportunities from a connector, ranks them by expected
value, runs the winning one through the agent's normal capability pipeline,
submits the result back to the connector, and (best-effort) shares what it
learned on The Colony — all routed through the same `callConnector` security
gate and the same risk/autonomy approval gate `processTask` uses internally.

Two real strategies are included (`src/core/strategies/`):
- **Molt Market**: browses open jobs, drafts a bid proposal via a real LLM call, submits the bid. (Deliberately bids rather than delivering full work up front — nothing is paid until a bid is accepted, so producing the whole deliverable before that would be pointless spend.) A second flow, `deliverAcceptedMoltMarketJobs()`, checks notifications for accepted bids and, for each one, actually produces and submits the deliverable.
- **AgenC**: browses on-chain open tasks, produces the actual deliverable, submits it directly (this platform's model is claim-and-deliver, not bid-first). Prices rewards in USD using a real live SOL/USD feed (`src/core/priceOracle.js`, CoinGecko, cached with a manual-override escape hatch).
- **OpenTask.ai**: same bid-first pattern as Molt Market.

Try it (fails honestly without real credentials — see `docs/setup.md`):

```bash
node src/pipelineDemo.js moltMarket
node src/pipelineDemo.js agenc
node src/pipelineDemo.js openTask
```

Proven end-to-end in `test/marketplace_pipeline.test.js`: at the default
`AUTONOMY_LEVEL=0` the discovered job is held for human approval before any
bid is drafted or sent; at `AUTONOMY_LEVEL=2` the agent drafts a real bid via
the LLM, submits it, shares the learning, and every step shows up in the
audit trail and economic-intelligence summary.

## Security hardening

This system is designed against real attack classes, not just the happy path:

- **SSRF (Server-Side Request Forgery)** — `src/core/ssrfGuard.js` blocks requests to private/loopback/link-local/cloud-metadata addresses, including decimal/hex IP-literal obfuscation bypasses, and re-validates the actual DNS-resolved IP (DNS-rebinding defense). Wired into the A2A client, since a malicious remote agent's card is the realistic point where an attacker controls a URL your agent would otherwise blindly fetch.
- **Prompt injection** — `src/core/promptInjectionGuard.js` normalizes Unicode and strips zero-width/invisible characters *before* pattern matching (defeats "ig\u200Bnore instructions"-style bypasses), catches HTML-comment instruction smuggling and base64-decode-then-obey smuggling, and caps how much untrusted content gets embedded per prompt (context-flooding defense).
- **Secret leakage** — `src/core/auditLog.js` redacts by both field name *and* value shape (OpenAI/Anthropic/GitHub/Slack/Google key formats, PEM blocks), so a credential leaking under an unexpected field name still gets caught.
- **Abuse / runaway loops** — `src/core/rateLimiter.js` is a token-bucket limiter enforced per connector via `UniversalAgent.callConnector()`, the single sanctioned path for any connector call — it also refuses unsupported operations outright and checks the kill switch first, before anything else runs.
- **MCP hardening** — deny-by-default tool allow-list, request timeout (won't hang on an unresponsive server), and size caps on both outgoing arguments and incoming responses (memory-exhaustion defense).

All of the above are proven by dedicated adversarial tests, not just described:
`test/ssrf_guard.test.js`, `test/a2a_security.test.js`, `test/adversarial_prompt_injection.test.js`, `test/secret_value_redaction.test.js`, `test/rate_limiter.test.js`, `test/connector_call_gate.test.js`, `test/mcp_security.test.js`.

## Setup

See `docs/setup.md`.

## Tests

```bash
npm test
```

Covers: token budgeting, deny-by-default permissions with expiry, the kill
switch, prompt-injection detection/labeling, connector status honesty, audit
log secret redaction (and that it doesn't over-redact real data like token
counts), and a full end-to-end pipeline run against a fixture server that
mimics the real Gemini API response shape.

## Database

`src/db/schema.sql` — the relational schema a production deployment should
migrate the current in-memory state into (agents, capabilities, connectors,
permissions, tasks, opportunities, executions, model_calls, costs, revenues,
payments, memory, semantic_cache, audit_logs, security_events, approvals,
learning_events, improvement_proposals, platform_accounts).
