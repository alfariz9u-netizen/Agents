# Telegram control bot

`src/telegramControlBot.js` connects the Universal Digital Agent to a
Telegram bot so you can control it and watch everything it does from your
phone. It's a thin human-interface layer: every task it submits still goes
through the exact same `UniversalAgent.processTask()` pipeline as any other
task (classify → permission/risk gate → cache → budget → LLM call → verify
→ QA → deliver) — this bot has no bypass for any of that.

## 1. Create the bot

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
follow the prompts, and it will hand you a token shaped like
`123456789:AAExampleTokenTextGoesHere`.

To find your own numeric chat id, message
[@userinfobot](https://t.me/userinfobot) (or any similar "what's my id"
bot) and it will reply with it.

## 2. Configure

```bash
export TELEGRAM_BOT_TOKEN=123456789:AAExampleTokenTextGoesHere
export TELEGRAM_ALLOWED_CHAT_IDS=123456789          # comma-separated; deny-by-default if unset
export TELEGRAM_ADMIN_CHAT_IDS=123456789            # optional; defaults to TELEGRAM_ALLOWED_CHAT_IDS

# Same as running the agent normally — everything in docs/setup.md still applies:
export GEMINI_API_KEY=your_key_here
export PERSIST_DIR=./data                            # recommended, see below
export PERSIST_ENCRYPTION_KEY="a strong passphrase"   # recommended whenever PERSIST_DIR is set
export AUTONOMY_LEVEL=0                               # 0 = everything needs approval (default)
```

`PERSIST_DIR` matters here for the same reason it matters for
`src/approvalCli.js`: if anything else (e.g. `src/pipelineDemo.js` or a
scheduled marketplace run) creates an approval in a different process, you
need shared, on-disk state for `/approvals` and `/approve` in the bot to
see it. Even for a single always-on bot process, `PERSIST_DIR` means
`/tasks` and `/status` survive a restart instead of resetting to empty.

## 3. Run it

```bash
node src/telegramControlBot.js
```

It validates the token immediately (fails loudly if it's wrong, rather than
on your first message), clears any webhook (long polling and webhooks are
mutually exclusive on Telegram's side), and starts polling. Stop it with
Ctrl+C.

Consider running it under a process supervisor (systemd, pm2, etc.) for
anything long-lived, since it's a persistent long-polling loop, not a
one-shot CLI like `src/approvalCli.js`.

## 4. Security model

- **Deny-by-default.** `TELEGRAM_ALLOWED_CHAT_IDS` is an explicit allow-list.
  If it's empty/unset, the bot responds to **no one** — it fails closed, not
  open. Unauthorized senders get no reply at all (not even an error, so the
  bot's existence isn't confirmed to strangers probing it); the attempt is
  still recorded in the audit log as a `HIGH`-risk
  `UNAUTHORIZED_ACCESS_ATTEMPT` entry, visible via `/tasks`.
- **Two tiers.** `TELEGRAM_ADMIN_CHAT_IDS` (a subset of the allow-list, or
  the same set if unset) is required for approving/denying/resuming tasks
  and for the kill switch. A chat id in the allow-list but not the admin
  list can submit and watch tasks, but can't approve high-risk work or stop
  the agent.
- **No pipeline bypass.** Every `/ask`, `/research`, `/code`, `/task`, etc.
  goes through `UniversalAgent.processTask()` unmodified — permissions,
  risk classification, human-approval gating at the configured
  `AUTONOMY_LEVEL`, token budgeting, and QA grading all still apply exactly
  as documented in the main README.
- **The kill switch can't lock you out of itself.** `/pause` and `/unpause`
  still reply to confirm, and `/status` still works, even while the kill
  switch is engaged — the bot's own reply channel is treated as the human
  control interface, not as an "external action" the kill switch gates.
  Actual task **execution** is still fully blocked while paused; the bot
  just relays that refusal back to you instead of silently doing nothing.

## 5. Command reference

**Visibility**
| Command | What it does |
|---|---|
| `/status` | Dashboard: autonomy level, kill switch, pending approvals, token usage, economics |
| `/connectors` | Real status of every registered connector (never hard-coded as "connected") |
| `/tasks [n]` | Last `n` audit-log entries (default 10) |
| `/trace <taskId>` | Full audit trail for one specific task |
| `/economics` | Economic-intelligence summary (revenue/cost totals) |

**Submitting work** — all 18 declared capabilities are reachable:
| Command | Capability |
|---|---|
| `/ask <question>` or plain text with no leading `/` | `knowledgeRetrieval` |
| `/research <topic>` | `research` |
| `/code <spec>` | `coding` |
| `/translate <locale> <text>` | `translationLocalization` |
| `/task <capability> <text>` | any capability by name (bot replies with the full list if you get the name wrong) |

Each task gets a `tg-<chatId>-<timestamp>-<random>` task id. If the
capability's risk level requires human approval at the current
`AUTONOMY_LEVEL`, the bot replies with the `approvalId` and the exact
follow-up commands to run it.

**Approvals (admin only)**
| Command | What it does |
|---|---|
| `/approvals [pending\|approved\|denied]` | List approval requests (defaults to `pending`) |
| `/approve <approvalId>` | Approve a held task |
| `/deny <approvalId>` | Deny it |
| `/run <approvalId>` | Actually execute an approved task (`UniversalAgent.resumeTask`) |

**Kill switch (admin only)**
| Command | What it does |
|---|---|
| `/pause` | Engage the global kill switch — every external action refuses to run |
| `/unpause` | Clear it |

## 6. Tests

```bash
node test/telegram_bot.test.js
```

Covers command routing, the deny-by-default/admin-tier authorization
model, correct capability→field mapping for `/task`, and — specifically —
that engaging the kill switch never disables the bot's own status/
confirmation replies while still fully blocking real task execution. Uses
in-memory fakes for both the Telegram API and the agent, so it needs no
network access or API keys, consistent with the rest of this project's test
suite.
