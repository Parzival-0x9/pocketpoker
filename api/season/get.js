// api/season/get.js - Edge function (fixed Upstash REST call)
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


export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") || process.env.SEASON_ID || "default";
    const key = `season:${id}`;

    const val = await redis("GET", key);
    let doc;
    if (val) { try { doc = JSON.parse(val); } catch { doc = null; } }
    if (!doc || typeof doc !== "object") {
      doc = { seasonId: id, version: 0, updatedAt: new Date().toISOString(), games: [] };
    }
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
