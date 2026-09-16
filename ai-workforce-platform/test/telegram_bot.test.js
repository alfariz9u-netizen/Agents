"use strict";

const assert = require("node:assert");
const TelegramControlBot = require("../src/telegramControlBot");
const { chunkMessage, parseChatIdSet } = TelegramControlBot;
const { CAPABILITIES } = require("../src/capabilities/definitions");

/** Minimal fake standing in for TelegramConnector — records every send, never touches the network. */
class FakeTelegram {
  constructor() {
    this.sent = []; // { chatId, text }
    this._status = "CONNECTED";
  }
  status() {
    return this._status;
  }
  async getMe() {
    return { id: 1, username: "fake_bot" };
  }
  async deleteWebhook() {
    return true;
  }
  async getUpdates() {
    return [];
  }
  async sendMessage(chatId, text) {
    this.sent.push({ chatId, text });
    return { message_id: this.sent.length };
  }
}

/** Minimal fake standing in for UniversalAgent — just enough surface for the bot to drive. */
class FakeAgent {
  constructor() {
    this.agentId = "fake-agent";
    this._auditEntries = [];
    this._killStopped = false;
    this._approvals = new Map();
    this.connectors = {
      _registered: {},
      register: (name, entry) => {
        this.connectors._registered[name] = entry;
      },
      list: () => Object.entries(this.connectors._registered).map(([name, e]) => ({ name, status: e.statusFn() })),
    };
    this.audit = {
      record: (entry) => this._auditEntries.push(entry),
      all: () => [...this._auditEntries],
      forTask: (taskId) => this._auditEntries.filter((e) => e.taskId === taskId),
    };
    this.approvals = {
      list: ({ status } = {}) => [...this._approvals.values()].filter((r) => !status || r.status === status),
      resolve: (id, status, by) => {
        const r = this._approvals.get(id);
        if (!r) throw new Error(`no such approval ${id}`);
        r.status = status;
        r.resolvedBy = by;
        return r;
      },
      get: (id) => this._approvals.get(id),
    };
    this.killSwitch = {
      stopAll: () => {
        this._killStopped = true;
      },
      resumeAll: () => {
        this._killStopped = false;
      },
    };
    this.economics = { summary: () => ({ totalRevenueUsd: 0, totalCostUsd: 0 }) };
    this.lastProcessedTask = null;
    this.dashboard = () => ({
      agentId: this.agentId,
      autonomyLevel: 0,
      killSwitch: { globalStopped: this._killStopped, stoppedConnectors: [], autonomousModePaused: false },
      persistDir: null,
      pendingApprovals: [...this._approvals.values()].filter((r) => r.status === "pending").length,
      auditEntryCount: this._auditEntries.length,
      dailyTokenUsage: {},
      economics: { totalRevenueUsd: 0, totalCostUsd: 0 },
    });
  }

  seedApproval(id, overrides = {}) {
    this._approvals.set(id, { id, status: "pending", capability: "coding", riskLevel: "MEDIUM", requestedAt: new Date().toISOString(), resumable: true, ...overrides });
  }

  async processTask(task) {
    this.lastProcessedTask = task;
    if (this._killStopped) throw new Error("GLOBAL_KILL_SWITCH is active.");
    return { status: "success", taskId: task.id, capability: task.type, output: `handled: ${JSON.stringify(task.input)}`, meta: { cached: false, qaScore: 95, tokenUsage: 42, model: "fake-model" } };
  }

  async resumeTask(id) {
    return { status: "success", taskId: `resumed-${id}`, capability: "coding", output: "resumed ok", meta: {} };
  }
}

function makeBot({ allowed = ["111"], admins = null } = {}) {
  const telegram = new FakeTelegram();
  const agent = new FakeAgent();
  const bot = new TelegramControlBot({
    agent,
    telegram,
    allowedChatIds: new Set(allowed),
    adminChatIds: admins ? new Set(admins) : undefined,
  });
  return { bot, telegram, agent };
}

async function testChunking() {
  const short = chunkMessage("hello", 100);
  assert.deepStrictEqual(short, ["hello"]);

  const long = "a".repeat(250);
  const parts = chunkMessage(long, 100);
  assert.ok(parts.length >= 3, "long text without newlines should be hard-split into multiple parts");
  assert.strictEqual(parts.join(""), long, "chunking must not lose or duplicate any characters");
  console.log("PASS: chunkMessage splits long text safely and losslessly");
}

async function testParseChatIdSet() {
  assert.deepStrictEqual(parseChatIdSet("111, 222 ,333"), new Set(["111", "222", "333"]));
  assert.deepStrictEqual(parseChatIdSet(""), new Set());
  assert.deepStrictEqual(parseChatIdSet(undefined), new Set());
  console.log("PASS: parseChatIdSet handles whitespace, empty, and unset values");
}

async function testDenyByDefaultForUnauthorizedChat() {
  const { bot, telegram, agent } = makeBot({ allowed: ["111"] });
  await bot._handleUpdate({ update_id: 1, message: { chat: { id: 999 }, text: "/status", from: { username: "stranger" } } });

  assert.strictEqual(telegram.sent.length, 0, "an unauthorized chat id must get no reply at all");
  const flagged = agent._auditEntries.find((e) => e.action === "UNAUTHORIZED_ACCESS_ATTEMPT");
  assert.ok(flagged, "the unauthorized attempt must still be audited");
  assert.strictEqual(flagged.riskLevel, "HIGH");
  console.log("PASS: unauthorized chat ids are silently ignored but still audited as HIGH risk");
}

async function testAuthorizedStatusCommand() {
  const { bot, telegram } = makeBot({ allowed: ["111"] });
  await bot._handleUpdate({ update_id: 1, message: { chat: { id: 111 }, text: "/status", from: { username: "owner" } } });
  assert.strictEqual(telegram.sent.length, 1);
  assert.ok(telegram.sent[0].text.includes("Agent: fake-agent"));
  console.log("PASS: authorized chat id gets a real dashboard reply for /status");
}

async function testTaskCommandRoutesToCorrectCapabilityAndField() {
  const { bot, agent } = makeBot({ allowed: ["111"] });
  await bot._handleCommand(111, "/task coding write a fizzbuzz function", "owner");
  assert.strictEqual(agent.lastProcessedTask.type, "coding");
  assert.deepStrictEqual(agent.lastProcessedTask.input, { spec: "write a fizzbuzz function" });
  console.log("PASS: /task <capability> <text> routes into the exact field that capability's prompt builder reads");
}

async function testUnknownCapabilityIsRejectedCleanly() {
  const { bot, telegram } = makeBot({ allowed: ["111"] });
  await bot._handleCommand(111, "/task not_a_real_capability hello", "owner");
  const lastMsg = telegram.sent[telegram.sent.length - 1].text;
  assert.ok(lastMsg.includes("Capabilities:"));
  for (const name of Object.keys(CAPABILITIES)) {
    assert.ok(lastMsg.includes(name), `usage message should list capability "${name}"`);
  }
  console.log("PASS: an unknown /task capability lists every real capability instead of guessing");
}

async function testPlainTextDefaultsToKnowledgeRetrieval() {
  const { bot, agent } = makeBot({ allowed: ["111"] });
  await bot._handleCommand(111, "what is the speed of light?", "owner");
  assert.strictEqual(agent.lastProcessedTask.type, "knowledgeRetrieval");
  assert.strictEqual(agent.lastProcessedTask.input.question, "what is the speed of light?");
  console.log("PASS: plain text with no leading slash defaults to the low-risk knowledgeRetrieval capability");
}

async function testApprovalCommandsRequireAdmin() {
  const { bot, telegram, agent } = makeBot({ allowed: ["111", "222"], admins: ["111"] });
  agent.seedApproval("approval-1");

  await bot._handleCommand(222, "/approve approval-1", "non_admin");
  assert.ok(telegram.sent[0].text.includes("admin chat id"), "non-admin must be refused, not silently allowed");
  assert.strictEqual(agent._approvals.get("approval-1").status, "pending", "a non-admin approve attempt must not change approval state");

  await bot._handleCommand(111, "/approve approval-1", "the_admin");
  assert.strictEqual(agent._approvals.get("approval-1").status, "approved");
  console.log("PASS: /approve is refused for non-admin chat ids and honored for admin chat ids");
}

async function testPauseDoesNotLockOutTheReplyChannel() {
  const { bot, telegram, agent } = makeBot({ allowed: ["111"] });

  await bot._handleCommand(111, "/pause", "owner");
  assert.strictEqual(agent._killStopped, true);
  assert.ok(telegram.sent[telegram.sent.length - 1].text.includes("Kill switch engaged"), "pausing must still confirm via reply — the control channel can't lock itself out");

  await bot._handleCommand(111, "/status", "owner");
  assert.ok(telegram.sent[telegram.sent.length - 1].text.includes("STOPPED"), "status must still be readable while paused");

  await bot._handleCommand(111, "/unpause", "owner");
  assert.strictEqual(agent._killStopped, false);
  console.log("PASS: engaging the kill switch never disables the bot's own status/confirmation replies");
}

async function testKillSwitchStillBlocksTaskExecution() {
  const { bot, telegram, agent } = makeBot({ allowed: ["111"] });
  agent.killSwitch.stopAll();

  // Route through _handleUpdate (not _handleCommand directly) so the same
  // try/catch a real incoming message goes through is exercised here too.
  await bot._handleUpdate({ update_id: 1, message: { chat: { id: 111 }, text: "/ask why is the sky blue?", from: { username: "owner" } } });
  const lastMsg = telegram.sent[telegram.sent.length - 1].text;
  assert.ok(lastMsg.includes("Error:"), "task submission must surface the kill-switch refusal, not silently succeed");
  console.log("PASS: task execution itself is still fully blocked by the kill switch, even though replies work");
}

async function main() {
  await testChunking();
  await testParseChatIdSet();
  await testDenyByDefaultForUnauthorizedChat();
  await testAuthorizedStatusCommand();
  await testTaskCommandRoutesToCorrectCapabilityAndField();
  await testUnknownCapabilityIsRejectedCleanly();
  await testPlainTextDefaultsToKnowledgeRetrieval();
  await testApprovalCommandsRequireAdmin();
  await testPauseDoesNotLockOutTheReplyChannel();
  await testKillSwitchStillBlocksTaskExecution();
}

main()
  .then(() => console.log("\nTelegram control bot tests passed."))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
