"use strict";

/**
 * Real connector for the Telegram Bot API (https://core.telegram.org/bots/api).
 * This is the transport layer only — pure HTTP calls to Telegram, no agent
 * logic. `src/telegramControlBot.js` is what wires this into a UniversalAgent
 * as a human control-plane interface.
 *
 * Fixed domain (api.telegram.org) with a token supplied only via env/config —
 * never a caller-controlled URL — so this does NOT need ssrfGuard, consistent
 * with the other fixed-domain connectors (Colony, Molt Market, etc.).
 *
 * REQUIRES:
 *   - TELEGRAM_BOT_TOKEN — create a bot with https://t.me/BotFather (the
 *     "/newbot" command), which hands back a token shaped like
 *     "123456789:AAExampleTokenTextGoesHere".
 */

const API_ROOT = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";

class TelegramConnector {
  constructor({ token } = {}) {
    this.name = "Telegram";
    this.token = token || process.env.TELEGRAM_BOT_TOKEN || null;
  }

  get isConfigured() {
    return Boolean(this.token);
  }

  status() {
    return this.isConfigured ? "CONNECTED" : "CREDENTIAL_REQUIRED";
  }

  _url(method) {
    if (!this.isConfigured) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set. Create a bot via https://t.me/BotFather and set it.");
    }
    return `${API_ROOT}/bot${this.token}/${method}`;
  }

  async _call(method, body) {
    const response = await fetch(this._url(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Telegram ${method} returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok || data.ok !== true) {
      throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
    }
    return data.result;
  }

  /** Verifies the token is valid and returns basic bot info (id, username, ...). */
  async getMe() {
    return this._call("getMe");
  }

  /**
   * Long polling requires no webhook to be set on this token (the two are
   * mutually exclusive on Telegram's side). Safe to call even if no webhook
   * was ever set.
   */
  async deleteWebhook() {
    return this._call("deleteWebhook", { drop_pending_updates: false });
  }

  /**
   * Long-poll for new updates. `offset` should be the highest
   * `update_id` seen so far, plus one — Telegram then only returns updates
   * the caller hasn't acknowledged yet.
   */
  async getUpdates({ offset, timeoutSeconds = 30, allowedUpdates = ["message"] } = {}) {
    return this._call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: allowedUpdates,
    });
  }

  /**
   * @param {string|number} chatId
   * @param {string} text - plain text; Telegram's 4096-char message limit is
   *   the caller's responsibility to respect (see `chunkMessage` in
   *   src/telegramControlBot.js).
   */
  async sendMessage(chatId, text, { replyToMessageId } = {}) {
    return this._call("sendMessage", {
      chat_id: chatId,
      text,
      reply_to_message_id: replyToMessageId,
      disable_web_page_preview: true,
    });
  }
}

module.exports = TelegramConnector;
