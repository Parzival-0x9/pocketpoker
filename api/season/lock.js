// api/season/lock.js — sets or clears a host lock with auto-expiry at next Brisbane midnight; audits changes.
export const config = { runtime: "edge" };

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) {
    throw new Error('Missing Upstash REST env vars (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN)');
  }
  // Try POST (preferred; safe for large JSON)
  const post = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ command, args })
  });
  if (post.ok) {
    const data = await post.json();
    return data.result;
  }
  // Fallback to path-style GET (useful for simple commands / providers that expect it)
  const path = [command, ...args.map(a => encodeURIComponent(String(a)))].join('/');
  const url = REST_URL.replace(/\/$/, '') + '/' + path;
  const get = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${REST_TOKEN}` } });
  if (!get.ok) {
    const t = await get.text();
    throw new Error(`Upstash error: ${get.status} ${t}`);
  }
  const data = await get.json();
  return data.result;
}

function brisbaneNextMidnightISO() {
  // Brisbane is UTC+10 year-round (no DST)
  const now = new Date();
  const brisbaneMs = now.getTime() + 10 * 60 * 60 * 1000;
  const b = new Date(brisbaneMs);
  const next = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + 1, 14, 0, 0));
  // Explanation: Brisbane midnight = UTC 14:00 of the previous day (UTC+10). We add a day above.
  return next.toISOString();
}
function isExpiredLock(lock) {
  if (!lock || !lock.expiresAt) return false;
  return Date.now() >= Date.parse(lock.expiresAt);
}
function auditPush(doc, entry) {
  doc.audit = Array.isArray(doc.audit) ? doc.audit : [];
  doc.audit.unshift({ ts: new Date().toISOString(), ...entry });
  if (doc.audit.length > 50) doc.audit.length = 50;
}


export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const action = String(body?.action || "").toLowerCase(); // "lock" | "unlock"
    const byName = body?.byName || req.headers.get("x-client-name") || "Unknown";
    const deviceId = body?.deviceId || req.headers.get("x-client-id") || "unknown";
    const key = `season:${id}`;

    let doc = await redis("GET", key);
    doc = doc ? JSON.parse(doc) : { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [], lock: null, audit: [] };

    // auto-clear expired
    if (doc.lock && isExpiredLock(doc.lock)) doc.lock = null;

    if (action === "lock") {
      if (doc.lock) {
        return new Response(JSON.stringify({ error: "Already locked by " + (doc.lock.byName||"Host"), lock: doc.lock }), { status: 423, headers: { "content-type": "application/json" } });
      }
      const now = new Date().toISOString();
      doc.lock = { byName, deviceId, at: now, expiresAt: brisbaneNextMidnightISO() };
      auditPush(doc, { action: "lock", byName, deviceId });
      await redis("SET", key, JSON.stringify(doc));
      return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
    } else if (action === "unlock") {
      if (!doc.lock) {
        return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (doc.lock.deviceId !== deviceId) {
        return new Response(JSON.stringify({ error: "Only locker can unlock.", lock: doc.lock }), { status: 423, headers: { "content-type": "application/json" } });
      }
      auditPush(doc, { action: "unlock", byName, deviceId });
      doc.lock = null;
      await redis("SET", key, JSON.stringify(doc));
      return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
    } else {
      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: { "content-type": "application/json" } });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
