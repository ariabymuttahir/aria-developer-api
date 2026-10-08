"use strict";

/**
 * ARIA Developer API — server.
 *
 * What it does:
 *   - Issues ARIA API keys (owner only):      POST /admin/keys
 *   - Serves AI over an OpenAI-compatible API (key holders):
 *         POST /v1/chat/completions     (Bearer aria_sk_...)
 *         GET  /v1/models
 *         GET  /v1/usage
 *
 * Security notes:
 *   - Only SHA-256 hashes of keys are stored. Raw keys are shown once.
 *   - Provider keys (Gemini/OpenAI/...) live in env vars, never leave the server.
 *   - Request logs never include key material (only the "aria_sk_abc…" label).
 *
 * Env vars (see .env.example):
 *   PORT, STORE=memory, FIREBASE_SERVICE_ACCOUNT_JSON, ADMIN_SECRET,
 *   GEMINI_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY, OPENAI_API_KEY,
 *   PROVIDER_MODE=stub (local tests), CORS_ORIGINS, OWNER_UIDS (comma list, optional
 *   extra owner check for /admin without firebase-admin)
 */

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const { generateKey, hashKey, bearerKey } = require("./keys");
const { createStore, todayKey } = require("./store");
const providers = require("./providers");

const { store, admin } = createStore();
providers.initKeySource(admin); // providers read keys from env, else Firestore config/api_keys
const app = express();
app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()) }));
app.use(express.json({ limit: "1mb" }));

// ---- tiny request log (no secrets) ----
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => {
    const key = bearerKey(req);
    const who = key ? ` key=${key.slice(0, 11)}…` : "";
    console.log(`${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - t}ms${who}`);
  });
  next();
});

/* ================= public ================= */

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/v1/models", async (req, res) => {
  res.json({ object: "list", data: await providers.publicModels() });
});

/* ================= key-holder auth ================= */

async function keyAuth(req, res, next) {
  const raw = bearerKey(req);
  if (!raw) return res.status(401).json({ error: { message: "Missing Bearer API key. Use Authorization: Bearer aria_sk_...", type: "auth" } });

  const cfg = await store.getConfig();
  if (!cfg.enabled) return res.status(503).json({ error: { message: "ARIA Developer API is currently disabled by the owner.", type: "disabled" } });

  const rec = await store.getKey(hashKey(raw));
  if (!rec) return res.status(401).json({ error: { message: "Invalid API key.", type: "auth" } });
  if (rec.revoked) return res.status(403).json({ error: { message: "This API key has been revoked.", type: "revoked" } });

  const quota = Number(rec.quotaDaily ?? cfg.defaultQuotaDaily ?? 100);
  const day = todayKey();
  const usage = (await store.getUsage(hashKey(raw), day)) || { requests: 0 };
  if (usage.requests >= quota) {
    return res.status(429).json({ error: { message: `Daily quota exceeded (${quota} requests/day).`, type: "quota" } });
  }

  req.apiKey = { hash: hashKey(raw), label: rec.label, record: rec, quota, day };
  // best-effort last-used stamp (don't fail the request if it errors)
  store.patchKey(hashKey(raw), { lastUsedAt: new Date().toISOString() }).catch(() => {});
  next();
}

// simple per-key burst guard: 60 req/min in-memory
const bursts = new Map();
function burstGuard(req, res, next) {
  const now = Date.now();
  const arr = (bursts.get(req.apiKey.hash) || []).filter((t) => now - t < 60000);
  arr.push(now);
  bursts.set(req.apiKey.hash, arr);
  if (arr.length > 60) return res.status(429).json({ error: { message: "Rate limit: 60 requests/minute.", type: "rate_limit" } });
  next();
}

/* ================= OpenAI-compatible chat ================= */

app.post("/v1/chat/completions", keyAuth, burstGuard, async (req, res) => {
  const { model = "aria-1", messages, temperature = 0.7, max_tokens: maxTokens = 1024, stream = false } = req.body || {};

  if (stream) {
    return res.status(400).json({ error: { message: "Streaming is not supported in v1. Call without stream:true.", type: "invalid_request" } });
  }
  if (!Array.isArray(messages) || !messages.length) {
    await store.addUsage(req.apiKey.hash, req.apiKey.day, { errors: 1 });
    return res.status(400).json({ error: { message: "'messages' must be a non-empty array.", type: "invalid_request" } });
  }
  for (const m of messages) {
    if (!m || typeof m.content !== "string" || !["system", "user", "assistant"].includes(m.role)) {
      await store.addUsage(req.apiKey.hash, req.apiKey.day, { errors: 1 });
      return res.status(400).json({ error: { message: "Each message needs {role: system|user|assistant, content: string}.", type: "invalid_request" } });
    }
  }

  try {
    const r = await providers.chat(messages, { model, temperature, maxTokens });
    await store.addUsage(req.apiKey.hash, req.apiKey.day, {
      requests: 1,
      promptTokens: r.usage.prompt_tokens,
      completionTokens: r.usage.completion_tokens,
      provider: r.provider,
    });
    res.set("x-aria-provider", r.provider);
    res.json({
      id: `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: r.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: r.content },
        finish_reason: r.finishReason || "stop",
      }],
      usage: {
        prompt_tokens: r.usage.prompt_tokens,
        completion_tokens: r.usage.completion_tokens,
        total_tokens: r.usage.total_tokens,
      },
    });
  } catch (e) {
    await store.addUsage(req.apiKey.hash, req.apiKey.day, { errors: 1 });
    const code = e.code === "MODEL_NOT_CONFIGURED" ? 400 : 502;
    res.status(code).json({ error: { message: e.message, type: "provider_error" } });
  }
});

/* ================= key-holder usage ================= */

app.get("/v1/usage", keyAuth, async (req, res) => {
  const usage = (await store.getUsage(req.apiKey.hash, req.apiKey.day)) || { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, providers: {} };
  res.json({
    key: req.apiKey.label,
    tier: req.apiKey.record.tier || "free",
    day: req.apiKey.day,
    quota_daily: req.apiKey.quota,
    used_today: usage.requests || 0,
    remaining_today: Math.max(0, req.apiKey.quota - (usage.requests || 0)),
    tokens: { prompt: usage.promptTokens || 0, completion: usage.completionTokens || 0 },
    errors: usage.errors || 0,
    providers: usage.providers || {},
  });
});

/* ================= owner-only admin ================= */

async function ownerAuth(req, res, next) {
  // Path 1: Firebase ID token (used by the admin panel).
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && admin) {
    try {
      const decoded = await admin.auth().verifyIdToken(m[1]);
      const uid = decoded.uid;
      // Owner check: admins/{uid} with role owner/admin, or explicit OWNER_UIDS env.
      const envOwners = (process.env.OWNER_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (envOwners.includes(uid)) return next();
      const doc = await admin.firestore().collection("admins").doc(uid).get();
      const role = doc.exists ? doc.data().role : null;
      if (role === "owner" || role === "admin") return next();
      return res.status(403).json({ error: "Not an owner/admin account." });
    } catch (e) {
      return res.status(401).json({ error: "Invalid Firebase ID token: " + e.message });
    }
  }
  // Path 2: shared admin secret (local dev / scripts). Never expose publicly.
  const secret = req.headers["x-admin-secret"];
  if (secret && process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET) return next();
  return res.status(401).json({ error: "Owner authentication required." });
}

const VALID_TIERS = ["free", "pro", "enterprise"];

app.post("/admin/keys", ownerAuth, async (req, res) => {
  const { name = "Untitled key", tier = "free", quotaDaily } = req.body || {};
  if (!VALID_TIERS.includes(tier)) return res.status(400).json({ error: `tier must be one of ${VALID_TIERS.join(", ")}` });
  const cfg = await store.getConfig();
  const q = Number(quotaDaily ?? cfg.defaultQuotaDaily ?? 100);
  if (!Number.isFinite(q) || q < 1 || q > 1000000) return res.status(400).json({ error: "quotaDaily must be 1..1000000" });

  const k = generateKey();
  const now = new Date().toISOString();
  await store.putKey(k.hash, {
    label: k.label,
    name: String(name).slice(0, 80),
    tier,
    quotaDaily: q,
    revoked: false,
    createdAt: now,
    lastUsedAt: null,
  });
  // The raw key is returned ONCE. It is never stored and cannot be recovered.
  res.json({ key: k.raw, label: k.label, name, tier, quotaDaily: q, createdAt: now });
});

app.get("/admin/keys", ownerAuth, async (req, res) => {
  const all = await store.listKeys();
  const day = todayKey();
  const out = [];
  for (const k of all) {
    const u = (await store.getUsage(k.hash, day)) || { requests: 0 };
    out.push({
      id: k.hash,
      label: k.label,
      name: k.name,
      tier: k.tier,
      quotaDaily: k.quotaDaily,
      revoked: !!k.revoked,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null,
      usedToday: u.requests || 0,
    });
  }
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json({ keys: out });
});

app.post("/admin/keys/:id/revoke", ownerAuth, async (req, res) => {
  const ok = await store.patchKey(req.params.id, { revoked: true });
  if (!ok) return res.status(404).json({ error: "Key not found." });
  res.json({ ok: true, revoked: true });
});

app.post("/admin/keys/:id/unrevoke", ownerAuth, async (req, res) => {
  const ok = await store.patchKey(req.params.id, { revoked: false });
  if (!ok) return res.status(404).json({ error: "Key not found." });
  res.json({ ok: true, revoked: false });
});

app.post("/admin/keys/:id/quota", ownerAuth, async (req, res) => {
  const q = Number(req.body && req.body.quotaDaily);
  if (!Number.isFinite(q) || q < 1 || q > 1000000) return res.status(400).json({ error: "quotaDaily must be 1..1000000" });
  const ok = await store.patchKey(req.params.id, { quotaDaily: q });
  if (!ok) return res.status(404).json({ error: "Key not found." });
  res.json({ ok: true, quotaDaily: q });
});

app.delete("/admin/keys/:id", ownerAuth, async (req, res) => {
  const ok = await store.deleteKey(req.params.id);
  if (!ok) return res.status(404).json({ error: "Key not found." });
  res.json({ ok: true, deleted: true });
});

function lastNDays(n) {
  const days = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days;
}

app.get("/admin/usage", ownerAuth, async (req, res) => {
  const days = lastNDays(Math.min(Number(req.query.days) || 7, 31));
  const all = await store.listKeys();
  const perKey = [];
  const totals = {};
  for (const d of days) totals[d] = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
  for (const k of all) {
    const rows = await store.usageRange(k.hash, days);
    for (const r of rows) {
      const t = totals[r.day];
      t.requests += r.requests || 0;
      t.promptTokens += r.promptTokens || 0;
      t.completionTokens += r.completionTokens || 0;
      t.errors += r.errors || 0;
    }
    perKey.push({ id: k.hash, label: k.label, name: k.name, tier: k.tier, revoked: !!k.revoked, days: rows });
  }
  res.json({ days, totals, perKey });
});

app.get("/admin/config", ownerAuth, async (req, res) => {
  res.json(await store.getConfig());
});

app.post("/admin/config", ownerAuth, async (req, res) => {
  const patch = {};
  if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
  if (req.body.defaultQuotaDaily !== undefined) {
    const q = Number(req.body.defaultQuotaDaily);
    if (!Number.isFinite(q) || q < 1 || q > 1000000) return res.status(400).json({ error: "defaultQuotaDaily must be 1..1000000" });
    patch.defaultQuotaDaily = q;
  }
  if (req.body.publicBaseUrl !== undefined) patch.publicBaseUrl = String(req.body.publicBaseUrl).slice(0, 200);
  res.json(await store.putConfig(patch));
});

// friendly root
app.get("/", (req, res) => res.json({
  name: "ARIA Developer API",
  version: "1.0.0",
  docs: "POST /v1/chat/completions with Authorization: Bearer aria_sk_... (OpenAI-compatible)",
}));

// 404 + error handler
app.use((req, res) => res.status(404).json({ error: "Not found." }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(500).json({ error: "Internal server error." });
});

const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, async () => {
  console.log(`ARIA Developer API listening on :${PORT}  (store: ${store.kind}, providers: ${providers.stubMode() ? "stub" : await providers.providerSummary()})`);
});

module.exports = app;
