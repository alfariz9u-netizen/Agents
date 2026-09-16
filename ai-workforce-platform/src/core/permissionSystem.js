"use strict";

/**
 * Deny-by-default permission system (spec sections 17-18). Deterministic,
 * no LLM involved. Grants are scoped to Agent + Task + Resource + Action +
 * Time and expire automatically.
 */

const PERMISSIONS = Object.freeze([
  "READ_PUBLIC_WEB",
  "READ_FILES",
  "READ_EMAIL",
  "SEND_EMAIL",
  "READ_GITHUB",
  "WRITE_GITHUB",
  "CREATE_PULL_REQUEST",
  "PUBLISH",
  "SEND_MESSAGE",
  "USE_EXTERNAL_API",
  "USE_MCP_TOOL",
  "USE_A2A",
  "SUBMIT_TASK",
  "RECEIVE_PAYMENT",
  "MAKE_PAYMENT",
  "WITHDRAW_FUNDS",
  "MODIFY_AGENT",
  "MODIFY_SYSTEM",
]);

class PermissionSystem {
  constructor() {
    this.grants = new Map(); // grantId -> grant
  }

  grant({ agentId, taskId, resource, action, durationMs, riskLevel }) {
    if (!PERMISSIONS.includes(action)) {
      throw new Error(`Unknown permission action: ${action}`);
    }
    const grantId = `${agentId}:${taskId}:${resource}:${action}`;
    const grant = {
      grantId,
      agentId,
      taskId,
      resource,
      action,
      riskLevel: riskLevel || "LOW",
      grantedAt: Date.now(),
      expiresAt: durationMs ? Date.now() + durationMs : null,
      status: "APPROVED",
    };
    this.grants.set(grantId, grant);
    return grant;
  }

  revoke(grantId) {
    const grant = this.grants.get(grantId);
    if (grant) grant.status = "REVOKED";
    return grant;
  }

  revokeAllForTask(taskId) {
    for (const grant of this.grants.values()) {
      if (grant.taskId === taskId) grant.status = "REVOKED";
    }
  }

  /**
   * Deny by default: only APPROVED, unexpired grants for the exact
   * agent+task+resource+action pass.
   */
  check({ agentId, taskId, resource, action }) {
    const grantId = `${agentId}:${taskId}:${resource}:${action}`;
    const grant = this.grants.get(grantId);
    if (!grant) return { allowed: false, reason: "No grant exists for this agent/task/resource/action." };
    if (grant.status !== "APPROVED") return { allowed: false, reason: `Grant status is ${grant.status}.` };
    if (grant.expiresAt && Date.now() > grant.expiresAt) {
      grant.status = "EXPIRED";
      return { allowed: false, reason: "Grant expired." };
    }
    return { allowed: true, grant };
  }
}

module.exports = { PermissionSystem, PERMISSIONS };
