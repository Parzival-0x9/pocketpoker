export const config = { runtime: "edge" };
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) throw new Error("Missing Upstash REST env vars");
  const url = REST_URL.replace(/\/$/, "") + "/" + [command, ...args.map(a => encodeURIComponent(String(a)))].join("/");
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${REST_TOKEN}` } });
  if (!res.ok) throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
  const data = await res.json(); return data.result;
}
function isExpiredLock(lock) { return !!(lock?.expiresAt && Date.now() >= Date.parse(lock.expiresAt)); }
function auditPush(doc, entry) { doc.audit = Array.isArray(doc.audit) ? doc.audit : []; doc.audit.unshift({ ts: new Date().toISOString(), ...entry }); if (doc.audit.length > 200) doc.audit.length = 200; }
const SOFT_LIMIT_PER_MIN = parseInt(process.env.SOFT_LIMIT_PER_MIN || "12", 10);

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const key = `season:${id}`;
    const gameId = body?.gameId;
    const deviceId = req.headers.get("x-client-id") || "unknown";
    const byName = req.headers.get("x-client-name") || "Unknown";
    if (!gameId) return new Response(JSON.stringify({ error: "Missing gameId" }), { status: 400, headers: { "content-type": "application/json" } });

    try {
      const rkey = `season:${id}:rate:${deviceId}`;
      const count = await redis("INCR", rkey);
      if (Number(count) === 1) await redis("EXPIRE", rkey, 60);
      if (Number(count) > SOFT_LIMIT_PER_MIN) return new Response(JSON.stringify({ error: "Rate limit: please wait a moment." }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    } catch {}

    const val = await redis("GET", key);
    let doc = val ? JSON.parse(val) : { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [], lock: null, audit: [], profiles: {} };

    if (doc.lock && !isExpiredLock(doc.lock) && doc.lock.deviceId !== deviceId) {
      return new Response(JSON.stringify({ error: "Locked by " + (doc.lock.byName || "Host") }), { status: 423, headers: { "content-type": "application/json" } });
    }

    const ifMatch = req.headers.get("if-match");
    if (ifMatch != null && String(doc.version) !== String(ifMatch)) {
      return new Response(JSON.stringify({ error: "Version conflict", doc }), { status: 409, headers: { "content-type": "application/json" } });
    }

    const before = (doc.games || []).length;
    doc.games = (doc.games || []).filter(g => g.id !== gameId);
    if (doc.games.length === before) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });

    doc.version = (doc.version | 0) + 1;
    doc.updatedAt = new Date().toISOString();
    auditPush(doc, { action: "delete-game", byName, deviceId, gameId });

    await redis("SET", key, JSON.stringify(doc));
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
