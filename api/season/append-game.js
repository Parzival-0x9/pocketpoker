// api/season/append-game.js - Edge function (Vercel)
// Appends a game to the shared season document with optimistic concurrency.
export const config = { runtime: "edge" };

const REST_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;
const SEASON_KEY_HASH = process.env.SEASON_KEY_HASH || "";

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

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const body = await req.json();
    const id = body?.seasonId || process.env.SEASON_ID || "default";
    const game = body?.game;
    const key = `season:${id}`;

    // Optional write PIN
    if (SEASON_KEY_HASH) {
      const pin = req.headers.get("x-season-key") || "";
      const h = await sha256Hex(pin);
      if (h !== SEASON_KEY_HASH) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: bad or missing season key" }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }
    }

    // Optimistic concurrency
    const ifMatch = req.headers.get("if-match");
    const currentVal = await redis("GET", key);
    let doc = currentVal
      ? JSON.parse(currentVal)
      : {
          seasonId: id,
          version: 0,
          updatedAt: new Date().toISOString(),
          games: [],
        };

    if (ifMatch != null && String(doc.version) !== String(ifMatch)) {
      return new Response(JSON.stringify({ error: "Version conflict", doc }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }

    if (!game || typeof game !== "object") {
      return new Response(JSON.stringify({ error: "Missing game payload" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Prepend
    doc.games = [game, ...(Array.isArray(doc.games) ? doc.games : [])];
    doc.version = (doc.version | 0) + 1;
    doc.updatedAt = new Date().toISOString();

    await redis("SET", key, JSON.stringify(doc));

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
