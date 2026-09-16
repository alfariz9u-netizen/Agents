"use strict";

const GeminiClient = require("./geminiClient");
const GrokClient = require("./grokClient");

/**
 * Routes agent LLM calls to Gemini and/or Grok based on LLM_PROVIDER,
 * falling back to whichever provider is actually configured.
 *
 * LLM_PROVIDER=gemini   -> Gemini only
 * LLM_PROVIDER=grok     -> Grok only
 * LLM_PROVIDER=auto (default) -> try Gemini first (it has a real free tier),
 *                                 fall back to Grok if Gemini isn't configured
 *                                 or the call fails.
 */
class LlmRouter {
  constructor() {
    this.gemini = new GeminiClient();
    this.grok = new GrokClient();
    this.preferred = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  }

  get providers() {
    const order = [];
    if (this.preferred === "grok") {
      order.push(this.grok, this.gemini);
    } else if (this.preferred === "gemini") {
      order.push(this.gemini, this.grok);
    } else {
      // auto: Gemini first because it has a genuine free tier.
      order.push(this.gemini, this.grok);
    }
    return order;
  }

  async generate(systemPrompt, userPrompt) {
    const errors = [];
    for (const provider of this.providers) {
      if (!provider.isConfigured) {
        errors.push(`${provider.constructor.name}: not configured (missing API key)`);
        continue;
      }
      try {
        const result = await provider.generate(systemPrompt, userPrompt);
        return { ...result, provider: provider.constructor.name };
      } catch (err) {
        errors.push(`${provider.constructor.name}: ${err.message}`);
      }
    }
    throw new Error(
      `No LLM provider could fulfill the request. Set GEMINI_API_KEY and/or XAI_API_KEY.\n` +
        errors.join("\n")
    );
  }
}

module.exports = LlmRouter;
