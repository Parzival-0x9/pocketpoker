// api/season/get.js — returns full season doc (including `draft`); clears expired lock.
export const config = { runtime: "edge" };

// Upstash REST helper (path-style)
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) throw new Error("Missing Upstash REST env vars");
  const url = REST_URL.replace(/\/$/, "") + "/" + [command, ...args.map(a => encodeURIComponent(String(a)))].join("/");
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${REST_TOKEN}` } });
  if (!res.ok) throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
  const data = await res.json(); return data.result;
}

function isExpiredLock(lock) {
  if (!lock || !lock.expiresAt) return false;
  return Date.now() >= Date.parse(lock.expiresAt);
}

function auditPush(doc, entry) {
  if (!doc || typeof doc !== "object") return;
  if (!Array.isArray(doc.audit)) doc.audit = [];
  doc.audit.unshift({ ts: new Date().toISOString(), ...entry });
  if (doc.audit.length > 200) doc.audit.length = 200;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") || process.env.SEASON_ID || "default";
    const key = `season:${id}`;

    const val = await redis("GET", key);
    let doc = val ? JSON.parse(val) : null;
    if (!doc || typeof doc !== "object") {
      doc = {
        seasonId: id,
        version: 0,
        updatedAt: new Date().toISOString(),
        games: [],
        profiles: {},
        draft: null,
        lock: null,
        audit: []
      };
    } else {
      // ensure required fields exist
      if (!Array.isArray(doc.games)) doc.games = [];
      if (!doc.profiles || typeof doc.profiles !== "object") doc.profiles = {};
      if (doc.draft !== null && typeof doc.draft !== "object") doc.draft = null;
      if (!Array.isArray(doc.audit)) doc.audit = [];
    }

    if (doc.lock && isExpiredLock(doc.lock)) {
      auditPush(doc, { action: "auto-unlock", reason: "expired", lock: doc.lock });
      doc.lock = null;
      await redis("SET", key, JSON.stringify(doc));
    }

    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
