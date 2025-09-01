// api/season/append-game.js — validates, lock-enforces, rate-limits, audits, and appends a game.
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

const SOFT_LIMIT_PER_MIN = parseInt(process.env.SOFT_LIMIT_PER_MIN || "12", 10); // ~one every 5s burst, 12/min default

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const key = `season:${id}`;
    const deviceId = req.headers.get("x-client-id") || "unknown";
    const byName = req.headers.get("x-client-name") || "Unknown";

    // rate limit per device
    try {
      const rkey = `season:${id}:rate:${deviceId}`;
      const count = await redis("INCR", rkey);
      if (Number(count) === 1) await redis("EXPIRE", rkey, 60);
      if (Number(count) > SOFT_LIMIT_PER_MIN) {
        return new Response(JSON.stringify({ error: "Rate limit: please wait a moment." }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
      }
    } catch { /* ignore rate limiter errors */ }

    // load doc
    const cur = await redis("GET", key);
    let doc = cur ? JSON.parse(cur) : { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [], lock: null, audit: [] };

    // lock enforcement (except if expired)
    if (doc.lock && !isExpiredLock(doc.lock)) {
      if (doc.lock.deviceId !== deviceId) {
        return new Response(JSON.stringify({ error: "Locked by " + (doc.lock.byName || "Host") }), { status: 423, headers: { "content-type": "application/json" } });
      }
    }

    // optimistic concurrency
    const ifMatch = req.headers.get("if-match");
    if (ifMatch != null && String(doc.version) !== String(ifMatch)) {
      return new Response(JSON.stringify({ error: "Version conflict", doc }), { status: 409, headers: { "content-type": "application/json" } });
    }

    const game = body?.game;
    if (!game || typeof game !== "object") return new Response(JSON.stringify({ error: "Missing game payload" }), { status: 400, headers: { "content-type": "application/json" } });

    // server-side validation mirroring client (light)
    const diff = Number(game?.totals?.diff || 0);
    const override = !!game?.overrideMismatch;
    if (Math.abs(diff) > 0.01 && !override) {
      return new Response(JSON.stringify({ error: "Totals not balanced; enable override to force." }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (!Array.isArray(game?.players) || (game.players.length || 0) < 2) {
      return new Response(JSON.stringify({ error: "Need at least two players." }), { status: 400, headers: { "content-type": "application/json" } });
    }

    // append
    doc.games = [game, ...(Array.isArray(doc.games) ? doc.games : [])];
    doc.version = (doc.version|0) + 1;
    doc.updatedAt = new Date().toISOString();
    auditPush(doc, { action: "append-game", byName, deviceId, gameId: game.id });

    await redis("SET", key, JSON.stringify(doc));
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
