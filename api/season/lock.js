// /api/season/lock.js
// Node runtime API route for Host Lock (Vercel)
export const config = { runtime: "nodejs" };

/**
 * Env required (already used by your other endpoints):
 *  - UPSTASH_REDIS_REST_URL
 *  - UPSTASH_REDIS_REST_TOKEN
 * Optional:
 *  - ALLOW_ANY_UNLOCK = "1" (default) -> anyone can unlock
 */

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ALLOW_ANY_UNLOCK = process.env.ALLOW_ANY_UNLOCK !== "0";

function json(res, status, obj) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.status(status).send(JSON.stringify(obj));
}

async function redis(cmd, ...args) {
  if (!URL || !TOKEN) throw new Error("Upstash env not configured");
  // Use path-style REST: /CMD/arg1/arg2
  const path = [cmd, ...args.map(encodeURIComponent)].join("/");
  const r = await fetch(`${URL}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || "Redis error");
  return data.result;
}

function pad(n) { return String(n).padStart(2, "0"); }

// Brisbane next-day midnight ISO (auto-unlock target)
function brisbaneNextMidnightISO() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [Y, M, D] = fmt.format(new Date()).split("-").map((v) => parseInt(v, 10));
  // Brisbane is UTC+10 year-round (no DST)
  const todayMidnightBrisbane = Date.parse(`${Y}-${pad(M)}-${pad(D)}T00:00:00+10:00`);
  const nextMidnight = new Date(todayMidnightBrisbane + 24 * 3600 * 1000);
  return nextMidnight.toISOString();
}

function isExpired(lock) {
  if (!lock || !lock.until) return false;
  try { return Date.now() >= Date.parse(lock.until); } catch { return false; }
}

function emptyDoc() {
  return { version: 0, games: [], lock: null };
}

async function getDoc(key) {
  const raw = await redis("GET", key);
  if (!raw) return emptyDoc();
  try { return JSON.parse(raw); } catch { return emptyDoc(); }
}

async function setDoc(key, doc) {
  await redis("SET", key, JSON.stringify(doc));
  return doc;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return json(res, 405, { error: "Method Not Allowed" });
    }

    // Accept body or query
    let body = {};
    try { body = req.body ?? {}; } catch { body = {}; }
    if (!body || Object.keys(body).length === 0) {
      try { body = JSON.parse(await new Promise((resolve) => {
        let d = ""; req.on("data", (c) => (d += c));
        req.on("end", () => resolve(d));
      })) || {}; } catch { body = {}; }
    }

    const seasonId = String(body.seasonId || req.query?.id || req.query?.seasonId || "default");
    const action = String(body.action || "").toLowerCase();
    const byName = body.byName || req.headers["x-client-name"] || null;
    const deviceId = body.deviceId || req.headers["x-client-id"] || null;
    const force = Boolean(body.force);

    if (!action || (action !== "lock" && action !== "unlock")) {
      return json(res, 400, { error: "Unknown action", hint: 'Use {"action":"lock","byName":"..."} or {"action":"unlock"}' });
    }
    if (action === "lock" && !byName) {
      return json(res, 400, { error: "Missing byName" });
    }
    if (!deviceId) {
      return json(res, 400, { error: "Missing deviceId" });
    }

    const key = `season:${seasonId}`;
    let doc = await getDoc(key);
    // Auto-unlock if expired
    if (isExpired(doc.lock)) {
      doc.lock = null;
      doc.version = (doc.version || 0) + 1;
      await setDoc(key, doc);
    }

    if (action === "lock") {
      if (doc.lock && doc.lock.active) {
        // still active, return 423 with lock details
        return json(res, 423, { error: "Already locked", lock: doc.lock });
      }
      const now = new Date().toISOString();
      doc.lock = {
        active: true,
        byName,
        deviceId,
        lockedAt: now,
        until: brisbaneNextMidnightISO(),
      };
      doc.version = (doc.version || 0) + 1;
      await setDoc(key, doc);
      return json(res, 200, doc);
    }

    // unlock
    if (!doc.lock || !doc.lock.active) {
      // nothing to do
      return json(res, 200, doc);
    }

    const sameDevice = deviceId && doc.lock.deviceId && deviceId === doc.lock.deviceId;
    const sameUser = byName && doc.lock.byName && byName === doc.lock.byName;
    const permitted = force || ALLOW_ANY_UNLOCK || sameDevice || sameUser;

    if (!permitted) {
      return json(res, 423, { error: "Locked by another device", lock: doc.lock });
    }

    doc.lock = null;
    doc.version = (doc.version || 0) + 1;
    await setDoc(key, doc);
    return json(res, 200, doc);
  } catch (e) {
    console.error("Lock API error:", e);
    return json(res, 500, { error: "Server error", message: e?.message || String(e) });
  }
}
