#!/usr/bin/env node
"use strict";

/**
 * Stands in for the real `agenc-marketplace` binary in tests, so
 * agenc_cli.test.js proves the connector's subprocess/JSON-parsing logic
 * against a script that behaves the same way (argv in, JSON on stdout,
 * exit code signaling success/failure) without needing the real binary,
 * a Solana wallet, or network access.
 */

const args = process.argv.slice(2);

function findFlag(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

if (args.includes("list-claimable")) {
  process.stdout.write(
    JSON.stringify({
      tasks: [
        {
          taskId: "task-abc123",
          taskType: "research_report",
          jobSpecUri: "ipfs://fakespec",
          reward: 25000000, // lamports
          deadline: "2026-12-31T00:00:00Z",
        },
      ],
    })
  );
  process.exit(0);
}

if (args.includes("claim-verified")) {
  const task = findFlag("--task");
  if (!task || task === "undefined") {
    process.stderr.write("missing --task");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ claimed: true, task }));
  process.exit(0);
}

if (args.includes("publish") && args.includes("artifacts")) {
  process.stdout.write(JSON.stringify({ signature: "fake-tx-signature-xyz", published: true }));
  process.exit(0);
}

process.stderr.write(`unknown fake CLI invocation: ${args.join(" ")}`);
process.exit(1);
