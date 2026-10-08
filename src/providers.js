"use strict";

/**
 * AI provider chain for the ARIA Developer API.
 *
 * The developer API is a gateway: one ARIA key gives access to ARIA's
 * provider chain (Gemini -> DeepSeek -> Mistral -> OpenAI). Providers are
 * tried in order; the first healthy one answers. Callers can also pin a
 * provider with a model name like "aria-gemini".
 *
 * Provider keys — where they come from (in order):
 *   1. Environment variables (GEMINI_API_KEY, ...) — explicit override.
 *   2. Firestore `config/api_keys` — the SAME doc the admin panel's
 *      "API Keys" page writes. So rotating a key in the panel automatically
 *      updates the developer API within ~5 minutes. No redeploy needed.
 * Keys never leave the server.
 *
 * PROVIDER_MODE=stub  -> no network; returns a canned answer (local tests).
 */

const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 60000);

const PROVIDERS = [
  {
    id: "gemini",
    envKey: "GEMINI_API_KEY",
    defaultModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    chat: chatGemini,
  },
  {
    id: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    defaultModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    chat: (msgs, o) => chatOpenAICompat(msgs, o, "https://api.deepseek.com/chat/completions"),
  },
  {
    id: "mistral",
    envKey: "MISTRAL_API_KEY",
    defaultModel: process.env.MISTRAL_MODEL || "mistral-large-latest",
    chat: (msgs, o) => chatOpenAICompat(msgs, o, "https://api.mistral.ai/v1/chat/completions"),
  },
  {
    id: "openai",
    envKey: "OPENAI_API_KEY",
    defaultModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    chat: (msgs, o) => chatOpenAICompat(msgs, o, "https://api.openai.com/v1/chat/completions"),
  },
];

/* ---------------- key source: env -> Firestore ---------------- */

let _admin = null;
let _keyCache = null;
let _keyCacheAt = 0;
const KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Give providers access to Firestore (firebase-admin instance or null). */
function initKeySource(admin) {
  _admin = admin || null;
}

async function readKeysFromFirestore() {
  const now = Date.now();
  if (_keyCache && now - _keyCacheAt < KEY_CACHE_TTL_MS) return _keyCache;
  const snap = await _admin.firestore().collection("config").doc("api_keys").get();
  _keyCache = snap.exists ? snap.data() || {} : {};
  _keyCacheAt = now;
  return _keyCache;
}

/** Resolve one provider's API key: env var first, then Firestore. */
async function providerKey(p) {
  if (process.env[p.envKey]) return process.env[p.envKey];
  if (_admin) {
    try {
      const keys = await readKeysFromFirestore();
      // config/api_keys uses the provider id as field name (gemini, deepseek, ...)
      if (keys[p.id]) return keys[p.id];
    } catch (e) {
      console.warn(`[providers] firestore key read failed (${p.id}): ${e.message}`);
    }
  }
  return null;
}

/** Providers that have a key right now, in chain order. */
async function configuredProviders() {
  if (stubMode()) return [{ id: "stub", defaultModel: "stub", apiKey: "stub", chat: chatStub }];
  const out = [];
  for (const p of PROVIDERS) {
    const apiKey = await providerKey(p);
    if (apiKey) out.push({ ...p, apiKey });
  }
  return out;
}

/* ---------------- helpers ---------------- */

/** Rough token estimate used when a provider does not report usage. */
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function withTimeout() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error("provider timeout")), TIMEOUT_MS);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function postJSON(url, body, headers = {}) {
  const { signal, done } = withTimeout();
  try {
    const r = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!r.ok) {
      const msg = (data && (data.error?.message || data.error)) || text.slice(0, 300) || `HTTP ${r.status}`;
      const err = new Error(`HTTP ${r.status}: ${msg}`);
      err.status = r.status;
      throw err;
    }
    return data;
  } finally {
    done();
  }
}

/* ---------------- OpenAI-compatible providers (DeepSeek/Mistral/OpenAI) ---------------- */

async function chatOpenAICompat(messages, opts, url) {
  const data = await postJSON(url, {
    model: opts.model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  }, { Authorization: `Bearer ${opts.apiKey}` });
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error("empty provider response");
  const content = choice.message.content || "";
  const u = data.usage || {};
  return {
    content,
    usage: {
      prompt_tokens: u.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n")),
      completion_tokens: u.completion_tokens ?? estimateTokens(content),
    },
    finishReason: choice.finish_reason || "stop",
  };
}

/* ---------------- Gemini (native REST format) ---------------- */

function toGeminiContents(messages) {
  const system = [];
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") { system.push(m.content); continue; }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content || "" }] });
  }
  return { system, contents };
}

async function chatGemini(messages, opts) {
  const { system, contents } = toGeminiContents(messages);
  const body = {
    contents,
    generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
  };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join("\n") }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const data = await postJSON(url, body);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || "").join("");
  if (!content && !parts.length) throw new Error("empty provider response");
  const u = data.usageMetadata || {};
  const promptText = messages.map((m) => m.content).join("\n");
  return {
    content,
    usage: {
      prompt_tokens: u.promptTokenCount ?? estimateTokens(promptText),
      completion_tokens: u.candidatesTokenCount ?? estimateTokens(content),
    },
    finishReason: (data.candidates?.[0]?.finishReason || "STOP").toLowerCase(),
  };
}

/* ---------------- stub (local tests, no network, no keys) ---------------- */

async function chatStub(messages, opts) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const content = `[ARIA stub] Provider chain OK (wanted: ${opts.providerId}). You asked: "${(lastUser?.content || "").slice(0, 120)}"`;
  return {
    content,
    usage: { prompt_tokens: estimateTokens(messages.map((m) => m.content).join("\n")), completion_tokens: estimateTokens(content) },
    finishReason: "stop",
  };
}

/* ---------------- public API ---------------- */

function stubMode() {
  return (process.env.PROVIDER_MODE || "").toLowerCase() === "stub";
}

/**
 * Run a chat completion.
 * opts: { model: 'aria-1' | 'aria-gemini' | ... , temperature, maxTokens }
 * Returns { content, provider, model, usage:{prompt_tokens, completion_tokens, total_tokens}, finishReason }
 * Throws when every configured provider fails.
 */
async function chat(messages, opts = {}) {
  const want = (opts.model || "aria-1").toLowerCase();

  if (stubMode()) {
    const r = await chatStub(messages, { providerId: want });
    return { ...r, provider: "stub", model: "aria-1-stub", usage: { ...r.usage, total_tokens: r.usage.prompt_tokens + r.usage.completion_tokens } };
  }

  let chain = await configuredProviders();
  if (!chain.length) {
    const err = new Error("no AI providers configured on the server (set keys in the admin panel's API Keys page or as env vars)");
    err.code = "NO_PROVIDERS";
    throw err;
  }

  // Pin to one provider? e.g. "aria-gemini"
  if (want.startsWith("aria-") && want !== "aria-1") {
    const pinned = chain.find((p) => `aria-${p.id}` === want);
    if (!pinned) {
      const err = new Error(`unknown or unconfigured model "${opts.model}"`);
      err.code = "MODEL_NOT_CONFIGURED";
      throw err;
    }
    chain = [pinned];
  }

  const errors = [];
  for (const p of chain) {
    try {
      const r = await p.chat(messages, {
        apiKey: p.apiKey,
        model: p.defaultModel,
        temperature: opts.temperature ?? 0.7,
        maxTokens: opts.maxTokens ?? 1024,
      });
      return {
        content: r.content,
        provider: p.id,
        model: want === "aria-1" ? "aria-1" : `aria-${p.id}`,
        usage: {
          prompt_tokens: r.usage.prompt_tokens,
          completion_tokens: r.usage.completion_tokens,
          total_tokens: r.usage.prompt_tokens + r.usage.completion_tokens,
        },
        finishReason: r.finishReason,
      };
    } catch (e) {
      errors.push(`${p.id}: ${e.message}`);
    }
  }
  const err = new Error(`all providers failed — ${errors.join(" | ")}`);
  err.code = "ALL_PROVIDERS_FAILED";
  err.details = errors;
  throw err;
}

async function publicModels() {
  if (stubMode()) return [{ id: "aria-1", object: "model", owned_by: "aria", description: "ARIA auto chain (stub mode)" }];
  const chain = await configuredProviders();
  const models = [{ id: "aria-1", object: "model", owned_by: "aria", description: "ARIA auto chain (best available provider)" }];
  for (const p of chain) {
    models.push({ id: `aria-${p.id}`, object: "model", owned_by: "aria", description: `Pinned to ${p.id} (${p.defaultModel})` });
  }
  return models;
}

async function providerSummary() {
  if (stubMode()) return "stub";
  return (await configuredProviders()).map((p) => p.id).join(",") || "none";
}

module.exports = { chat, publicModels, providerSummary, stubMode, initKeySource };
