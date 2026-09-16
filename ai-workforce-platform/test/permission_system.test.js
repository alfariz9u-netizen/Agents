"use strict";

const assert = require("node:assert");
const { PermissionSystem } = require("../src/core/permissionSystem");

function main() {
  const perms = new PermissionSystem();

  const denied = perms.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
  assert.strictEqual(denied.allowed, false);
  console.log("PASS: deny-by-default with no grant");

  perms.grant({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL", durationMs: 50 });
  const allowed = perms.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
  assert.strictEqual(allowed.allowed, true);
  console.log("PASS: explicit grant allows the action");

  perms.revoke(allowed.grant.grantId);
  const revoked = perms.check({ agentId: "a1", taskId: "t1", resource: "t1", action: "SEND_EMAIL" });
  assert.strictEqual(revoked.allowed, false);
  console.log("PASS: revoked grant is denied");
}

async function testExpiry() {
  const perms = new PermissionSystem();
  perms.grant({ agentId: "a1", taskId: "t2", resource: "t2", action: "PUBLISH", durationMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const expired = perms.check({ agentId: "a1", taskId: "t2", resource: "t2", action: "PUBLISH" });
  assert.strictEqual(expired.allowed, false);
  console.log("PASS: time-bound grant expires automatically");
}

main();
testExpiry().then(() => console.log("\nPermission system tests passed."));
