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
function auditPush(doc, entry) { doc.audit = Array.isArray(doc.audit) ? doc.audit : []; doc.audit.unshift({ ts: new Date().toISOString(), ...entry }); if (doc.audit.length > 200) doc.audit.length = 200; }

const MAX_AVATAR_LEN = parseInt(process.env.MAX_AVATAR_LEN || "200000", 10); // ~200 KB

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const key = `season:${id}`;
    const name = (body?.name||"").trim();
    const payId = body?.payId;
    const avatarDataUrl = body?.avatarDataUrl;
    const deviceId = req.headers.get("x-client-id") || "unknown";
    const byName = req.headers.get("x-client-name") || "Unknown";
    if (!name) return new Response(JSON.stringify({ error:"Missing name" }), { status: 400, headers: { "content-type":"application/json" } });
    if (avatarDataUrl && avatarDataUrl.length > MAX_AVATAR_LEN) return new Response(JSON.stringify({ error:"Avatar too large (limit ~200KB)" }), { status: 413, headers: { "content-type":"application/json" } });

    const val = await redis("GET", key);
    let doc = val ? JSON.parse(val) : { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [], lock: null, audit: [], profiles: {} };

    doc.profiles = doc.profiles || {};
    const prev = doc.profiles[name] || {};
    doc.profiles[name] = { ...prev };
    if (payId != null) doc.profiles[name].payId = String(payId);
    if (avatarDataUrl != null) doc.profiles[name].avatarDataUrl = String(avatarDataUrl);

    doc.version = (doc.version|0) + 1;
    doc.updatedAt = new Date().toISOString();
    auditPush(doc, { action:"profile-upsert", byName, deviceId, name });

    await redis("SET", key, JSON.stringify(doc));
    return new Response(JSON.stringify({ ok:true, profiles: doc.profiles, version: doc.version }), { status: 200, headers: { "content-type":"application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type":"application/json" } });
  }
}
