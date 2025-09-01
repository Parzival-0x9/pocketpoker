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
function brisbaneNextMidnightISO() {
  const now = new Date(); const brisbaneMs = now.getTime() + 10 * 60 * 60 * 1000;
  const b = new Date(brisbaneMs);
  const next = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + 1, 14, 0, 0));
  return next.toISOString();
}
function isExpiredLock(lock) { return !!(lock?.expiresAt && Date.now() >= Date.parse(lock.expiresAt)); }
function auditPush(doc, entry) { doc.audit = Array.isArray(doc.audit) ? doc.audit : []; doc.audit.unshift({ ts: new Date().toISOString(), ...entry }); if (doc.audit.length > 200) doc.audit.length = 200; }

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const action = String(body?.action||"").toLowerCase();
    const byName = body?.byName || req.headers.get("x-client-name") || "Unknown";
    const deviceId = body?.deviceId || req.headers.get("x-client-id") || "unknown";
    const key = `season:${id}`;

    let doc = await redis("GET", key);
    doc = doc ? JSON.parse(doc) : { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [], lock: null, audit: [], profiles: {} };

    if (doc.lock && isExpiredLock(doc.lock)) doc.lock = null;

    if (action === "lock") {
      if (doc.lock) return new Response(JSON.stringify({ error: "Already locked by " + (doc.lock.byName||"Host"), lock: doc.lock }), { status: 423, headers: { "content-type":"application/json" } });
      doc.lock = { byName, deviceId, at: new Date().toISOString(), expiresAt: brisbaneNextMidnightISO() };
      auditPush(doc, { action:"lock", byName, deviceId });
      await redis("SET", key, JSON.stringify(doc));
      return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type":"application/json" } });
    } else if (action === "unlock") {
      if (!doc.lock) return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type":"application/json" } });
      if (doc.lock.deviceId !== deviceId) return new Response(JSON.stringify({ error: "Only locker can unlock.", lock: doc.lock }), { status: 423, headers: { "content-type":"application/json" } });
      auditPush(doc, { action:"unlock", byName, deviceId });
      doc.lock = null;
      await redis("SET", key, JSON.stringify(doc));
      return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type":"application/json" } });
    } else {
      return new Response(JSON.stringify({ error:"Unknown action" }), { status: 400, headers: { "content-type":"application/json" } });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type":"application/json" } });
  }
}
