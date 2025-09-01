// api/season/delete-game.js - Edge function (fixed Upstash REST call)
export const config = { runtime: "edge" };

// Shared Upstash REST helper (path-style). Works with:
// - KV_REST_API_URL / KV_REST_API_TOKEN (Vercel KV/Upstash)
// - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash Redis)
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) {
    throw new Error('Missing Upstash REST env vars (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN)');
  }
  const path = [command, ...args.map(a => encodeURIComponent(String(a)))].join('/');
  const url = REST_URL.replace(/\/$/, '') + '/' + path;
  const res = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${REST_TOKEN}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Upstash error: ${res.status} ${t}`);
  }
  const json = await res.json();
  return json.result;
}

const SEASON_KEY_HASH = process.env.SEASON_KEY_HASH || "";

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const gameId = body?.gameId;
    const key = `season:${id}`;

    if (SEASON_KEY_HASH) {
      const pin = req.headers.get("x-season-key") || "";
      const h = await sha256Hex(pin);
      if (h !== SEASON_KEY_HASH) return new Response(JSON.stringify({ error: "Unauthorized: bad or missing season key" }), { status: 401, headers: { "content-type": "application/json" } });
    }

    const ifMatch = req.headers.get("if-match");
    const currentVal = await redis("GET", key);
    let doc = currentVal ? JSON.parse(currentVal) : { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [] };

    if (ifMatch != null && String(doc.version) !== String(ifMatch)) {
      return new Response(JSON.stringify({ error: "Version conflict", doc }), { status: 409, headers: { "content-type": "application/json" } });
    }

    if (!gameId) return new Response(JSON.stringify({ error: "Missing gameId" }), { status: 400, headers: { "content-type": "application/json" } });

    doc.games = (doc.games || []).filter(g => g.id !== gameId);
    doc.version = (doc.version|0) + 1;
    doc.updatedAt = new Date().toISOString();

    await redis("SET", key, JSON.stringify(doc));

    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
