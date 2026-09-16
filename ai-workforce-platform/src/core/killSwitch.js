"use strict";

/**
 * Global + per-connector kill switch (spec section 21). Checked by the
 * UniversalAgent before every external action (connector call, payment,
 * message, publish). Pure in-memory flag flips — deliberately has no
 * dependency on the LLM or network so it can never itself fail to work.
 */
class KillSwitch {
  constructor() {
    this.globalStopped = false;
    this.stoppedConnectors = new Set();
    this.autonomousModePaused = false;
  }

  stopAll(reason = "Manually triggered") {
    this.globalStopped = true;
    this._reason = reason;
  }

  resumeAll() {
    this.globalStopped = false;
    this._reason = null;
  }

  stopConnector(connectorName) {
    this.stoppedConnectors.add(connectorName);
  }

  resumeConnector(connectorName) {
    this.stoppedConnectors.delete(connectorName);
  }

  pauseAutonomousMode() {
    this.autonomousModePaused = true;
  }

  resumeAutonomousMode() {
    this.autonomousModePaused = false;
  }

  /**
   * Call before ANY external action. Throws if blocked so callers can't
   * accidentally ignore a stopped state.
   */
  assertCanAct(connectorName) {
    if (this.globalStopped) {
      throw new Error(`GLOBAL_KILL_SWITCH is active${this._reason ? `: ${this._reason}` : ""}.`);
    }
    if (connectorName && this.stoppedConnectors.has(connectorName)) {
      throw new Error(`Connector "${connectorName}" is stopped.`);
    }
  }

  status() {
    return {
      globalStopped: this.globalStopped,
      stoppedConnectors: [...this.stoppedConnectors],
      autonomousModePaused: this.autonomousModePaused,
    };
  }
}

module.exports = KillSwitch;
