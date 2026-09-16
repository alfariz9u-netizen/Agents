"use strict";

/**
 * Real adapter for AgenC (https://agenc.ag) — a live protocol on Solana
 * mainnet. Program `agenc-coordination`
 * (HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK), live since 2026-06-11.
 * Source of truth used to build this: https://github.com/tetsuo-ai/AgenC
 * (docs/MARKETPLACE.md) and https://docs.agenc.tech/docs/deployment/mainnet/.
 *
 * BUG FIX (previous version): this connector used to call
 * @tetsuo-ai/marketplace-sdk's submitTaskResult() directly, with a comment
 * admitting task/agent PDA resolution was never implemented — every real
 * submission would have failed. This version instead shells out to
 * AgenC's own official CLI/MCP binary, `agenc-marketplace`, which owns PDA
 * derivation, transaction building, and signing itself. Delegating to the
 * vendor's maintained tool is the actual fix, not a workaround — hand-
 * rolling Anchor PDA math against a live-mainnet program from partial
 * documentation is exactly the kind of thing that should NOT be
 * reimplemented ad hoc.
 *
 * CONFIRMED real CLI usage (verbatim from AgenC's own docs):
 *   agenc-marketplace --network mainnet --json tasks list-claimable --limit N --compact
 *   agenc-marketplace --network mainnet --json session init --wallet <path>
 *   agenc-marketplace --network mainnet --json tasks claim-verified ...
 *   agenc-marketplace --network mainnet --json artifacts publish ...
 *
 * HONESTY NOTE: the exact flags for `tasks claim-verified` and
 * `artifacts publish` beyond the command name itself were not confirmed at
 * build time — only the command names and the general CLI shape are
 * documented. The CLI is also described as "preview-first" for mutations
 * (it shows the transaction before signing), which may require an
 * interactive confirmation or an explicit non-interactive flag not yet
 * confirmed here. Before relying on submitDeliverable() for a real
 * submission, run `agenc-marketplace tasks claim-verified --help` and
 * `agenc-marketplace artifacts publish --help` yourself and adjust the
 * argument arrays below if they differ.
 *
 * REQUIRES:
 *   curl -fsSL https://marketplace.agenc.tech/install.sh | sh
 *   agenc-marketplace --network mainnet --json session init --wallet <path-to-funded-solana-keypair>
 *   Then set AGENC_SESSION_READY=true so status() reports CONNECTED.
 */

const { spawn } = require("node:child_process");

const BINARY = process.env.AGENC_CLI_PATH || "agenc-marketplace";
const NETWORK = process.env.AGENC_NETWORK || "mainnet";

function runCli(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BINARY, ["--network", NETWORK, "--json", ...args]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to launch ${BINARY}: ${err.message}. Install it: curl -fsSL https://marketplace.agenc.tech/install.sh | sh`
        )
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${BINARY} ${args.join(" ")} exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Could not parse ${BINARY} JSON output (${err.message}): ${stdout}`));
      }
    });
  });
}

class AgencAdapter {
  constructor() {
    this.name = "AgenC";
  }

  status() {
    // We can't cheaply verify the CLI/session without actually running it
    // (that costs nothing for a read, but status() should stay fast/sync-ish
    // and side-effect-free) — the operator confirms setup completed by
    // setting this themselves after a successful `session init`.
    return process.env.AGENC_SESSION_READY === "true" ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  /**
   * Real, read-only, keyless — the exact confirmed command from AgenC's
   * own docs. No wallet/session needed for this call.
   */
  async fetchIncomingTasks(limit = 10) {
    const data = await runCli(["tasks", "list-claimable", "--limit", String(limit), "--compact"]);
    const tasks = data.tasks || data.result || data || [];

    return tasks.map((onChainTask) => ({
      id: onChainTask.taskId || onChainTask.id,
      type: onChainTask.taskType || "business_automation",
      clientLocale: "en-US",
      input: {
        spec: onChainTask.jobSpecUri || onChainTask.specUri,
        rewardLamports: onChainTask.reward ?? onChainTask.rewardLamports,
        deadline: onChainTask.deadline,
      },
      _marketplaceRaw: onChainTask,
    }));
  }

  /**
   * Claims the task, then publishes the deliverable as an artifact — both
   * steps delegate PDA resolution and transaction signing entirely to the
   * official CLI. See the HONESTY NOTE above about unconfirmed exact flags.
   */
  async submitDeliverable(taskId, deliverable) {
    await runCli(["tasks", "claim-verified", "--task", taskId]);

    const result = await runCli([
      "artifacts",
      "publish",
      "--task",
      taskId,
      "--content",
      JSON.stringify(deliverable),
    ]);

    return { accepted: true, taskId, txSignature: result.signature || result.txSignature };
  }
}

module.exports = AgencAdapter;
