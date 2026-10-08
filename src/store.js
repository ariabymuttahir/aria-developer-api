"use strict";

/**
 * Storage layer for the ARIA Developer API.
 *
 * Two backends, same interface:
 *   - "firestore" : real Firestore via firebase-admin (production).
 *                   Needs FIREBASE_SERVICE_ACCOUNT_JSON env (the JSON text of a
 *                   Firebase service-account key) or GOOGLE_APPLICATION_CREDENTIALS.
 *   - "memory"    : in-process Maps (local development / tests). Chosen
 *                   automatically when no service account is configured, or
 *                   forced with STORE=memory.
 *
 * Collections:
 *   developer_keys/{sha256}        -> key record
 *   developer_usage/{sha256_YYYY-MM-DD} -> per-day counters for one key
 *   config/developer_api           -> { enabled, defaultQuotaDaily, publicBaseUrl }
 */

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/* ------------------------- in-memory backend ------------------------- */

function memoryBackend() {
  const keys = new Map(); // hash -> record
  const usage = new Map(); // `${hash}_${day}` -> counters
  let config = { enabled: true, defaultQuotaDaily: 100, publicBaseUrl: "" };

  return {
    kind: "memory",
    async getKey(hash) { return keys.get(hash) || null; },
    async putKey(hash, rec) { keys.set(hash, rec); },
    async listKeys() { return [...keys.entries()].map(([hash, r]) => ({ hash, ...r })); },
    async patchKey(hash, patch) {
      const r = keys.get(hash);
      if (!r) return false;
      keys.set(hash, { ...r, ...patch });
      return true;
    },
    async deleteKey(hash) { return keys.delete(hash); },

    async getUsage(hash, day) {
      return usage.get(`${hash}_${day}`) || null;
    },
    async addUsage(hash, day, delta) {
      const k = `${hash}_${day}`;
      const cur = usage.get(k) || { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, providers: {} };
      cur.requests += delta.requests || 0;
      cur.promptTokens += delta.promptTokens || 0;
      cur.completionTokens += delta.completionTokens || 0;
      cur.errors += delta.errors || 0;
      if (delta.provider) cur.providers[delta.provider] = (cur.providers[delta.provider] || 0) + 1;
      usage.set(k, cur);
      return cur;
    },
    async usageRange(hash, days) {
      // days: array of YYYY-MM-DD
      return days.map((d) => ({ day: d, ...(usage.get(`${hash}_${d}`) || { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, providers: {} }) }));
    },

    async getConfig() { return { ...config }; },
    async putConfig(patch) { config = { ...config, ...patch }; return { ...config }; },
  };
}

/* ------------------------- firestore backend ------------------------- */

function firestoreBackend(db) {
  const keysCol = db.collection("developer_keys");
  const usageCol = db.collection("developer_usage");
  const configDoc = db.collection("config").doc("developer_api");

  return {
    kind: "firestore",
    async getKey(hash) {
      const s = await keysCol.doc(hash).get();
      return s.exists ? s.data() : null;
    },
    async putKey(hash, rec) { await keysCol.doc(hash).set(rec); },
    async listKeys() {
      const s = await keysCol.get();
      return s.docs.map((d) => ({ hash: d.id, ...d.data() }));
    },
    async patchKey(hash, patch) {
      const ref = keysCol.doc(hash);
      const s = await ref.get();
      if (!s.exists) return false;
      await ref.update(patch);
      return true;
    },
    async deleteKey(hash) {
      const ref = keysCol.doc(hash);
      const s = await ref.get();
      if (!s.exists) return false;
      await ref.delete();
      return true;
    },

    async getUsage(hash, day) {
      const s = await usageCol.doc(`${hash}_${day}`).get();
      return s.exists ? s.data() : null;
    },
    async addUsage(hash, day, delta) {
      const ref = usageCol.doc(`${hash}_${day}`);
      const inc = {
        requests: delta.requests || 0,
        promptTokens: delta.promptTokens || 0,
        completionTokens: delta.completionTokens || 0,
        errors: delta.errors || 0,
      };
      const providers = {};
      if (delta.provider) providers[`providers.${delta.provider}`] = 1;
      // Firestore numeric increments are atomic — safe under concurrency.
      const { FieldValue } = require("firebase-admin/firestore");
      const update = {};
      for (const [k, v] of Object.entries(inc)) update[k] = FieldValue.increment(v);
      for (const [k, v] of Object.entries(providers)) update[k] = FieldValue.increment(v);
      await ref.set(update, { merge: true });
      const s = await ref.get();
      return s.data();
    },
    async usageRange(hash, days) {
      const out = [];
      for (const d of days) {
        const s = await usageCol.doc(`${hash}_${d}`).get();
        out.push({ day: d, ...(s.exists ? s.data() : { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, providers: {} }) });
      }
      return out;
    },

    async getConfig() {
      const s = await configDoc.get();
      const base = { enabled: true, defaultQuotaDaily: 100, publicBaseUrl: "" };
      return s.exists ? { ...base, ...s.data() } : base;
    },
    async putConfig(patch) {
      await configDoc.set(patch, { merge: true });
      return this.getConfig();
    },
  };
}

/* ------------------------- init ------------------------- */

let admin = null; // firebase-admin instance when usable

function initAdmin() {
  try {
    admin = require("firebase-admin");
  } catch {
    return null; // not installed
  }
  if (admin.apps.length) return admin;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  try {
    if (saJson) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp();
    } else {
      return null; // no credentials -> fall back to memory store
    }
    return admin;
  } catch (e) {
    console.warn("[store] firebase-admin init failed, using memory store:", e.message);
    return null;
  }
}

/** Build the store. Also exposes admin auth helpers for owner-only routes. */
function createStore() {
  const forceMemory = (process.env.STORE || "").toLowerCase() === "memory";
  const sdk = forceMemory ? null : initAdmin();
  if (sdk) {
    console.log("[store] using Firestore backend");
    return { store: firestoreBackend(sdk.firestore()), admin: sdk };
  }
  console.log("[store] using in-memory backend (set FIREBASE_SERVICE_ACCOUNT_JSON for Firestore)");
  return { store: memoryBackend(), admin: null };
}

module.exports = { createStore, todayKey };
