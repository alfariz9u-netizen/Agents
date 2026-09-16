"use strict";

const assert = require("node:assert");
const path = require("node:path");

async function main() {
  const fakeCliPath = path.join(__dirname, "fixtures", "fake_agenc_marketplace.js");
  process.env.AGENC_CLI_PATH = fakeCliPath;

  delete require.cache[require.resolve("../src/connectors/agenc")];
  const AgencAdapter = require("../src/connectors/agenc");
  const connector = new AgencAdapter();

  // --- status() is honest without AGENC_SESSION_READY ---
  delete process.env.AGENC_SESSION_READY;
  assert.strictEqual(connector.status(), "CREDENTIAL_REQUIRED");
  console.log("PASS: status() is CREDENTIAL_REQUIRED until the operator confirms session setup");

  process.env.AGENC_SESSION_READY = "true";
  assert.strictEqual(connector.status(), "CONNECTED");
  console.log("PASS: status() reports CONNECTED once AGENC_SESSION_READY is set");

  // --- Discovery: real subprocess call, real JSON parsing ---
  const tasks = await connector.fetchIncomingTasks(5);
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].id, "task-abc123");
  assert.strictEqual(tasks[0].input.rewardLamports, 25000000);
  console.log("PASS: fetchIncomingTasks() correctly shells out to the CLI and parses real JSON output");

  // --- Submission: claims THEN publishes, delegating PDA/signing to the CLI ---
  const result = await connector.submitDeliverable("task-abc123", { content: "the finished report" });
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.txSignature, "fake-tx-signature-xyz");
  console.log("PASS: submitDeliverable() claims then publishes via the CLI — no hand-rolled PDA resolution in this code at all");

  // --- Honest failure: a CLI invocation the fake binary doesn't recognize must surface as a real error ---
  await assert.rejects(
    () => connector.submitDeliverable(undefined, {}), // missing --task triggers the fake binary's own error path
    /exited with code/
  );
  console.log("PASS: a failing CLI invocation surfaces as a real thrown error, not a silent success");

  // --- Honest failure: binary not found at all ---
  process.env.AGENC_CLI_PATH = "/nonexistent/path/to/agenc-marketplace";
  delete require.cache[require.resolve("../src/connectors/agenc")];
  const AgencAdapter2 = require("../src/connectors/agenc");
  const brokenConnector = new AgencAdapter2();
  await assert.rejects(() => brokenConnector.fetchIncomingTasks(), /Failed to launch/);
  console.log("PASS: a missing CLI binary fails with a clear, actionable error, not a silent empty result");
}

main()
  .then(() => {
    console.log("\nAgenC CLI connector tests passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("TEST FAILURE:", err);
    process.exit(1);
  });
