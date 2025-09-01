// api/season/get.js - Edge function (Vercel)
// Reads the shared season document from Upstash (KV/Redis) via REST.
export const config = { runtime: "edge" };

const REST_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) {
    throw new Error(
      "Missing Upstash REST env vars (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN)"
    );
  }
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command: [command, ...args] }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Upstash error: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.result;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") || process.env.SEASON_ID || "default";
    const key = `season:${id}`;

    const val = await redis("GET", key);
    let doc;
    if (val) {
      try {
        doc = JSON.parse(val);
      } catch {
        doc = null;
      }
    }
    if (!doc || typeof doc !== "object") {
      doc = {
        seasonId: id,
        version: 0,
        updatedAt: new Date().toISOString(),
        games: [],
      };
    }
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message || "server error" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
