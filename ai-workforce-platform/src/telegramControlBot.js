#!/usr/bin/env node
"use strict";

/**
 * Telegram control-plane bot for the Universal Digital Agent.
 *
 * Lets an authorized human:
 *   - submit tasks to any of the agent's 18 capabilities from a phone,
 *   - watch everything the agent does in real time (audit trail, dashboard,
 *     economics, connector status),
 *   - approve/deny/resume tasks that are held for human approval, and
 *   - hit the kill switch remotely.
 *
 * SECURITY MODEL (deny-by-default, same spirit as the rest of this project):
 *   - TELEGRAM_ALLOWED_CHAT_IDS: comma-separated chat ids allowed to talk to
 *     the bot at all. Empty/unset -> the bot ignores EVERYONE (fails closed,
 *     not open) until you configure it.
 *   - TELEGRAM_ADMIN_CHAT_IDS: comma-separated chat ids allowed to run
 *     approve/deny/run/pause/unpause. Defaults to TELEGRAM_ALLOWED_CHAT_IDS
 *     if unset (so a single-user deployment works out of the box) — set it
 *     explicitly to a smaller set if other chat ids should only be able to
 *     submit tasks, not approve high-risk ones or hit the kill switch.
 *   - Unauthorized senders get NO reply at all (not even an error) so the
 *     bot's existence isn't confirmed to strangers; the attempt is still
 *     recorded as a HIGH-risk audit entry.
 *   - Every task submitted through the bot still goes through the exact
 *     same permission/risk/budget/verification/QA pipeline as any other
 *     task (`UniversalAgent.processTask`) — this bot has no bypass.
 *   - The bot's own replies (status, confirmations, results) are treated as
 *     the human control channel itself and are NOT gated by the kill
 *     switch — an emergency stop must never also disable your ability to
 *     see status or un-pause. Task EXECUTION is still fully gated: if the
 *     kill switch is engaged, `processTask`/`callConnector` refuse to run
 *     and the bot just relays that refusal back to you.
 *
 * Run:
 *   export TELEGRAM_BOT_TOKEN=...
 *   export TELEGRAM_ALLOWED_CHAT_IDS=123456789
 *   export PERSIST_DIR=./data            # optional but recommended — see below
 *   node src/telegramControlBot.js
 *
 * PERSIST_DIR matters here for the same reason it matters for
 * src/approvalCli.js: approvals created by an autonomous run (e.g. the
 * marketplace pipeline) and approvals resolved from Telegram are often
 * different process lifetimes, and audit/economics history you want to
 * inspect via /tasks and /status should survive a bot restart.
 *
 * See docs/telegram-bot.md for the full command reference.
 */

const { buildAgent } = require("./index");
const TelegramConnector = require("./connectors/telegram");
const { CAPABILITIES } = require("./capabilities/definitions");
const { STATUS } = require("./core/connectorRegistry");

const POLL_TIMEOUT_SECONDS = 30;
const MAX_MESSAGE_CHARS = 3500; // stays safely under Telegram's 4096-char limit

/**
 * Maps each capability to the one input field its buildUserPrompt() actually
 * reads (see src/capabilities/definitions.js) — this is what lets a single
 * free-text Telegram message be routed straight into ANY capability via
 * `/task <capability> <text>` without the bot having to guess.
 */
const PRIMARY_FIELD = {
  research: "topic",
  webResearch: "query",
  dataAnalysis: "request",
  coding: "spec",
  debugging: "error",
  documentProcessing: "content",
  translationLocalization: "sourceText",
  contentSeo: "topic",
  marketResearch: "market",
  businessAutomation: "process",
  qualityAssurance: "deliverableText",
  taskManagement: "context",
  communication: "context",
  agentDiscovery: "need",
  serviceDiscovery: "need",
  marketplaceOperations: "listingText",
  financialAnalysis: "question",
  knowledgeRetrieval: "question",
  fileAnalysis: "fileContent",
};

function parseChatIdSet(envValue) {
  return new Set(
    String(envValue || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** Splits text into Telegram-safe chunks without cutting words mid-line where possible. */
function chunkMessage(text, size = MAX_MESSAGE_CHARS) {
  const out = [];
  let rest = String(text ?? "");
  if (rest.length === 0) return [""];
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size; // no good newline break — hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TelegramControlBot {
  constructor({ agent, telegram, allowedChatIds, adminChatIds } = {}) {
    this.agent = agent || buildAgent();
    this.telegram = telegram || new TelegramConnector();
    this.allowedChatIds = allowedChatIds || parseChatIdSet(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
    const explicitAdmins = adminChatIds || parseChatIdSet(process.env.TELEGRAM_ADMIN_CHAT_IDS);
    this.adminChatIds = explicitAdmins.size > 0 ? explicitAdmins : this.allowedChatIds;
    this._offset = 0;
    this._running = false;

    // Registered like every other connector so /connectors and the dashboard
    // show this bot's own real status — never hard-coded as "connected".
    this.agent.connectors.register("telegram", {
      instance: this.telegram,
      capabilities: ["sendMessage"],
      statusFn: () => this.telegram.status(),
    });
  }

  isAuthorized(chatId) {
    return this.allowedChatIds.has(String(chatId));
  }

  isAdmin(chatId) {
    return this.adminChatIds.has(String(chatId));
  }

  /** See the class doc comment: deliberately NOT gated by the kill switch. */
  async reply(chatId, text) {
    for (const part of chunkMessage(text)) {
      try {
        await this.telegram.sendMessage(chatId, part);
        this.agent.audit.record({ agentId: this.agent.agentId, connector: "telegram", action: "sendMessage", result: "SUCCESS", riskLevel: "LOW" });
      } catch (err) {
        this.agent.audit.record({ agentId: this.agent.agentId, connector: "telegram", action: "sendMessage", result: "ERROR", error: err.message, riskLevel: "LOW" });
        throw err;
      }
    }
  }

  async start() {
    if (this.telegram.status() !== STATUS.CONNECTED) {
      throw new Error("Telegram connector is not CONNECTED — set TELEGRAM_BOT_TOKEN.");
    }
    if (this.allowedChatIds.size === 0) {
      console.warn(
        "WARNING: TELEGRAM_ALLOWED_CHAT_IDS is empty. Deny-by-default means this bot will not respond to ANYONE until you set it."
      );
    }
    await this.telegram.getMe(); // fail loudly now if the token is invalid, not on the first message
    await this.telegram.deleteWebhook().catch(() => {}); // polling and webhooks are mutually exclusive

    this._running = true;
    console.log("Telegram control bot started (long polling). Ctrl+C to stop.");
    while (this._running) {
      let updates;
      try {
        updates = await this.telegram.getUpdates({ offset: this._offset, timeoutSeconds: POLL_TIMEOUT_SECONDS });
      } catch (err) {
        console.error("getUpdates failed, retrying in 5s:", err.message);
        await sleep(5000);
        continue;
      }
      for (const update of updates) {
        this._offset = update.update_id + 1;
        try {
          await this._handleUpdate(update);
        } catch (err) {
          console.error("Error handling update:", err);
        }
      }
    }
  }

  stop() {
    this._running = false;
  }

  async _handleUpdate(update) {
    const message = update.message;
    if (!message || typeof message.text !== "string") return; // ignore non-text updates (stickers, edits, etc.)

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (!this.isAuthorized(chatId)) {
      this.agent.audit.record({
        agentId: this.agent.agentId,
        connector: "telegram",
        action: "UNAUTHORIZED_ACCESS_ATTEMPT",
        result: `chatId=${chatId} text="${text.slice(0, 80)}"`,
        riskLevel: "HIGH",
      });
      return; // no reply — don't confirm the bot's existence to strangers
    }

    const from = message.from ? message.from.username || message.from.first_name || String(message.from.id) : "unknown";

    try {
      await this._handleCommand(chatId, text, from);
    } catch (err) {
      await this.reply(chatId, `Error: ${err.message}`);
    }
  }

  async _handleCommand(chatId, text, from) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const argText = text.slice(cmdRaw.length).trim();

    switch (cmd) {
      case "/start":
      case "/help":
        return this.reply(chatId, this._helpText());

      case "/status":
      case "/dashboard":
        return this.reply(chatId, this._fmtDashboard(this.agent.dashboard()));

      case "/connectors":
        return this.reply(chatId, this._fmtConnectors(this.agent.connectors.list()));

      case "/tasks": {
        const n = Math.max(1, Math.min(50, Number(rest[0]) || 10));
        return this.reply(chatId, this._fmtAuditEntries(this.agent.audit.all().slice(-n)));
      }

      case "/trace": {
        const taskId = rest[0];
        if (!taskId) return this.reply(chatId, "Usage: /trace <taskId>");
        const entries = this.agent.audit.forTask(taskId);
        return this.reply(chatId, entries.length ? this._fmtAuditEntries(entries) : `No audit entries for taskId "${taskId}".`);
      }

      case "/economics":
        return this.reply(chatId, JSON.stringify(this.agent.economics.summary(), null, 2));

      case "/approvals": {
        const status = ["pending", "approved", "denied"].includes(rest[0]) ? rest[0] : "pending";
        return this.reply(chatId, this._fmtApprovals(this.agent.approvals.list({ status })));
      }

      case "/approve":
      case "/deny": {
        if (!this.isAdmin(chatId)) return this.reply(chatId, "This command requires an admin chat id (see TELEGRAM_ADMIN_CHAT_IDS).");
        const id = rest[0];
        if (!id) return this.reply(chatId, `Usage: ${cmd} <approvalId>`);
        const record = this.agent.approvals.resolve(id, cmd === "/approve" ? "approved" : "denied", from);
        const resumeHint = record.status === "approved" && record.resumable ? ` Run /run ${id} to execute it.` : "";
        return this.reply(chatId, `${record.status === "approved" ? "Approved" : "Denied"} ${id}.${resumeHint}`);
      }

      case "/run": {
        if (!this.isAdmin(chatId)) return this.reply(chatId, "This command requires an admin chat id.");
        const id = rest[0];
        if (!id) return this.reply(chatId, "Usage: /run <approvalId>");
        const result = await this.agent.resumeTask(id);
        return this.reply(chatId, result.status ? this._fmtTaskResult(result) : JSON.stringify(result, null, 2));
      }

      case "/pause": {
        if (!this.isAdmin(chatId)) return this.reply(chatId, "This command requires an admin chat id.");
        this.agent.killSwitch.stopAll(`Stopped via Telegram by ${from}`);
        return this.reply(chatId, "Kill switch engaged. The agent will refuse every external action until /unpause.");
      }

      case "/unpause": {
        if (!this.isAdmin(chatId)) return this.reply(chatId, "This command requires an admin chat id.");
        this.agent.killSwitch.resumeAll();
        return this.reply(chatId, "Kill switch cleared. The agent will act normally again.");
      }

      case "/task": {
        const [capability, ...bodyParts] = rest;
        if (!capability || !CAPABILITIES[capability]) {
          return this.reply(chatId, `Usage: /task <capability> <text>\n\nCapabilities:\n${Object.keys(CAPABILITIES).join(", ")}`);
        }
        const field = PRIMARY_FIELD[capability] || "topic";
        return this._submit(chatId, capability, { [field]: bodyParts.join(" ") });
      }

      case "/ask":
        return this._submit(chatId, "knowledgeRetrieval", { question: argText });

      case "/research":
        return this._submit(chatId, "research", { topic: argText });

      case "/code":
        return this._submit(chatId, "coding", { spec: argText });

      case "/translate": {
        const [locale, ...words] = rest;
        if (!locale || words.length === 0) return this.reply(chatId, "Usage: /translate <locale> <text>\nExample: /translate ar-SA Hello, how are you?");
        return this._submit(chatId, "translationLocalization", { targetLocale: locale, sourceText: words.join(" ") });
      }

      default:
        if (text.startsWith("/")) {
          return this.reply(chatId, `Unknown command.\n\n${this._helpText()}`);
        }
        // Plain text with no leading slash: treat it as a general question —
        // knowledgeRetrieval is LOW risk (READ_FILES) and runs without
        // needing human approval at the default autonomy level.
        return this._submit(chatId, "knowledgeRetrieval", { question: text });
    }
  }

  async _submit(chatId, capabilityName, input) {
    if (!input || Object.values(input).every((v) => !v)) {
      return this.reply(chatId, "Please include some text after the command.");
    }
    const taskId = `tg-${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.reply(chatId, `Working on it — task ${taskId} (${capabilityName})...`);
    const result = await this.agent.processTask({ id: taskId, type: capabilityName, input, sourceConnector: "telegram" });
    return this.reply(chatId, this._fmtTaskResult(result));
  }

  _fmtTaskResult(result) {
    if (result.status === "success") {
      const m = result.meta || {};
      return `✅ ${result.taskId} (${result.capability})\n\n${result.output}\n\n[cached=${Boolean(m.cached)} qa=${m.qaScore ?? "-"} tokens=${m.tokenUsage ?? "-"} model=${m.model || "-"}]`;
    }
    if (result.status === "pending_human_approval") {
      return (
        `⏳ Held for human approval\n` +
        `approvalId: ${result.approvalId}\n` +
        `capability: ${result.capability}\n` +
        `risk: ${result.riskLevel}\n\n` +
        `An admin can run: /approve ${result.approvalId}  then  /run ${result.approvalId}`
      );
    }
    return `❌ Failed: ${result.reason}`;
  }

  _fmtDashboard(d) {
    return [
      `Agent: ${d.agentId}`,
      `Autonomy level: ${JSON.stringify(d.autonomyLevel)}`,
      `Kill switch: ${d.killSwitch.globalStopped ? "🛑 STOPPED" : "✅ running"}${
        d.killSwitch.stoppedConnectors.length ? `\n  Stopped connectors: ${d.killSwitch.stoppedConnectors.join(", ")}` : ""
      }`,
      `Persist dir: ${d.persistDir || "(in-memory only — set PERSIST_DIR to survive restarts)"}`,
      `Pending approvals: ${d.pendingApprovals}`,
      `Audit entries: ${d.auditEntryCount}`,
      `Daily token usage: ${JSON.stringify(d.dailyTokenUsage)}`,
      `Economics: ${JSON.stringify(d.economics)}`,
    ].join("\n");
  }

  _fmtConnectors(list) {
    return list.map((c) => `${c.name}: ${c.status}`).join("\n");
  }

  _fmtAuditEntries(entries) {
    if (!entries.length) return "(no matching audit entries)";
    return entries
      .map((e) => `${e.timestamp}  [${e.riskLevel}]  task=${e.taskId || "-"}  ${e.action} -> ${e.result}${e.error ? `  ERROR: ${e.error}` : ""}`)
      .join("\n");
  }

  _fmtApprovals(list) {
    if (!list.length) return "(none)";
    return list
      .map((r) => `${r.id}\n  status=${r.status}  capability=${r.capability || "-"}  risk=${r.riskLevel}  requested=${r.requestedAt}`)
      .join("\n\n");
  }

  _helpText() {
    return [
      "Universal Digital Agent — Telegram control bot",
      "",
      "Visibility:",
      "/status — dashboard (autonomy, kill switch, tokens, economics)",
      "/connectors — real status of every connector",
      "/tasks [n] — last n audit entries (default 10)",
      "/trace <taskId> — full audit trail for one task",
      "/economics — economic-intelligence summary",
      "",
      "Submit work:",
      "/ask <question>   (or just send plain text)",
      "/research <topic>",
      "/code <spec>",
      "/translate <locale> <text>",
      `/task <capability> <text> — any of: ${Object.keys(CAPABILITIES).join(", ")}`,
      "",
      "Approvals (admin only):",
      "/approvals [pending|approved|denied]",
      "/approve <approvalId>",
      "/deny <approvalId>",
      "/run <approvalId> — execute an approved task",
      "",
      "Kill switch (admin only):",
      "/pause — stop all external actions immediately",
      "/unpause — resume",
    ].join("\n");
  }
}

async function main() {
  const bot = new TelegramControlBot();
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    bot.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });
  await bot.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = TelegramControlBot;
module.exports.chunkMessage = chunkMessage;
module.exports.parseChatIdSet = parseChatIdSet;
module.exports.PRIMARY_FIELD = PRIMARY_FIELD;
