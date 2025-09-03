// api/season/draft-save.js — store live 'Game' draft without bumping main version
export const config = { runtime: "edge" };

// Upstash REST helpers (same pattern as your other endpoints)
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) throw new Error("Missing Upstash REST env vars");
  const url = REST_URL.replace(/\/$/, "") + "/" + [command, ...args.map(a => encodeURIComponent(String(a)))].join("/");
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${REST_TOKEN}` } });
  if (!res.ok) throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
  const data = await res.json(); return data.result;
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const { seasonId, draft } = await req.json();
    if (!seasonId) return new Response("seasonId required", { status: 400 });
    if (!draft || typeof draft.stamp !== "number") {
      return new Response("draft.stamp (number) required", { status: 400 });
    }

    const key = `season:${seasonId}`;
    const val = await redis("GET", key);
    let doc = val ? JSON.parse(val) : null;
    if (!doc || typeof doc !== "object") {
      doc = { seasonId, version: 0, updatedAt: new Date().toISOString(), games: [], lock: null, audit: [], profiles: {} };
    }

    const prevStamp = doc?.draft?.stamp || 0;
    // Only store if newer than what we have
    if (draft.stamp > prevStamp) {
      doc.draft = {
        stamp: draft.stamp,
        players: Array.isArray(draft.players) ? draft.players : [],
        buyInAmount: typeof draft.buyInAmount === "number" ? draft.buyInAmount : (doc?.draft?.buyInAmount ?? 50),
        prizeFromPot: typeof draft.prizeFromPot === "boolean" ? draft.prizeFromPot : (doc?.draft?.prizeFromPot ?? true),
        prizeAmount: typeof draft.prizeAmount === "number" ? draft.prizeAmount : (doc?.draft?.prizeAmount ?? 20)
      };
      // Do NOT bump doc.version (it's just a live draft)
      await redis("SET", key, JSON.stringify(doc));
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
