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
const SOFT_LIMIT_PER_MIN = parseInt(process.env.SOFT_LIMIT_PER_MIN || "20", 10);

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const key = `season:${id}`;
    const gameId = body?.gameId;
    const idx = body?.idx;
    const paid = !!body?.paid;
    const deviceId = req.headers.get("x-client-id") || "unknown";
    const byName = req.headers.get("x-client-name") || "Unknown";
    if (typeof idx !== "number" || !gameId) return new Response(JSON.stringify({ error:"Missing gameId or idx" }), { status: 400, headers: { "content-type":"application/json" } });

    try {
      const rkey = `season:${id}:rate:${deviceId}`;
      const count = await redis("INCR", rkey);
      if (Number(count) === 1) await redis("EXPIRE", rkey, 60);
      if (Number(count) > SOFT_LIMIT_PER_MIN) return new Response(JSON.stringify({ error:"Rate limit" }), { status: 429, headers: { "content-type":"application/json" } });
    } catch {}

    const val = await redis("GET", key);
    let doc = val ? JSON.parse(val) : null;
    if (!doc) return new Response(JSON.stringify({ error:"Season not found" }), { status: 404, headers: { "content-type":"application/json" } });

    const g = (doc.games||[]).find(x=> x.id === gameId);
    if (!g) return new Response(JSON.stringify({ error:"Game not found" }), { status: 404, headers: { "content-type":"application/json" } });
    if (!Array.isArray(g.txns) || !g.txns[idx]) return new Response(JSON.stringify({ error:"Txn not found" }), { status: 404, headers: { "content-type":"application/json" } });

    if (doc.lock && !isExpiredLock(doc.lock) && doc.lock.deviceId !== deviceId) {
      return new Response(JSON.stringify({ error:"Locked by " + (doc.lock.byName||"Host") }), { status: 423, headers: { "content-type":"application/json" } });
    }

    g.txns[idx].paid = paid;
    g.txns[idx].paidAt = paid ? (g.txns[idx].paidAt || new Date().toISOString()) : null;

    doc.version = (doc.version|0) + 1;
    doc.updatedAt = new Date().toISOString();
    auditPush(doc, { action: paid ? "payment-marked" : "payment-unmarked", byName, deviceId, gameId, idx });

    await redis("SET", key, JSON.stringify(doc));
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type":"application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type":"application/json" } });
  }
}
