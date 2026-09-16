"use strict";

/**
 * Autonomy levels (spec section 23). Deterministic gate — the level number
 * controls what the agent may do WITHOUT stopping for human approval.
 * High-risk actions remain gated regardless of level (see riskEngine.js).
 */
const AUTONOMY_LEVELS = {
  0: { name: "MANUAL", description: "Every external action requires approval." },
  1: { name: "ASSISTED", description: "Agent can research and prepare actions, not execute them." },
  2: { name: "LIMITED_AUTONOMY", description: "Agent can perform approved low-risk actions automatically." },
  3: { name: "CONTROLLED_AUTONOMY", description: "Agent can execute predefined workflows within strict budgets and permissions." },
};

function getLevel(levelNumber) {
  return AUTONOMY_LEVELS[levelNumber] || AUTONOMY_LEVELS[0];
}

function currentLevel() {
  return Number(process.env.AUTONOMY_LEVEL ?? 0);
}

module.exports = { AUTONOMY_LEVELS, getLevel, currentLevel };
