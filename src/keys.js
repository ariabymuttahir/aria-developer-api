"use strict";

/**
 * API key generation & hashing.
 *
 * A developer key looks like:  aria_sk_9f3a... (48 hex chars after the prefix)
 * Only the SHA-256 hash is ever stored. The raw key is shown to the owner
 * exactly ONCE at issuance time and can never be recovered afterwards —
 * same rule as OpenAI / Stripe.
 */

const crypto = require("crypto");

const KEY_PREFIX = "aria_sk_";
const RANDOM_BYTES = 24; // -> 48 hex chars

/** Generate a new raw key + its storage record fields. */
function generateKey() {
  const secret = crypto.randomBytes(RANDOM_BYTES).toString("hex");
  const raw = KEY_PREFIX + secret;
  return {
    raw,
    hash: hashKey(raw),
    // First 11 chars ("aria_sk_9f3") are safe to show in lists/logs.
    label: raw.slice(0, 11) + "…",
  };
}

/** SHA-256 hex of a raw key. */
function hashKey(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Extract a Bearer key from an Authorization header. Returns null if absent/malformed. */
function bearerKey(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = m[1].trim();
  return key.startsWith(KEY_PREFIX) ? key : null;
}

module.exports = { KEY_PREFIX, generateKey, hashKey, bearerKey };
