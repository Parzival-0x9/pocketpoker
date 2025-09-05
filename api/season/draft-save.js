// api/season/draft-save.js — persists live draft state for sync across devices.
export const config = { runtime: "edge" };

// Upstash REST helper (path-style)
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(command, ...args) {
  if (!REST_URL || !REST_TOKEN) throw new Error("Missing Upstash REST env vars");
  const url = REST_URL.replace(/\/$/, "") + "/" + [command, ...args.map(a => encodeURIComponent(String(a)))].join("/");
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${REST_TOKEN}` } });
  if (!res.ok) throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
  const data = await res.json(); return data.result;
}

function sanitizeDraft(d) {
  if (!d || typeof d !== "object") return null;
  const out = {};
  // players
  const pls = Array.isArray(d.players) ? d.players : [];
  out.players = pls.map(p => ({
    id: (p && p.id) ? String(p.id) : Math.random().toString(36).slice(2,9),
    name: (p && typeof p.name === "string") ? p.name : "",
    buyIns: Number.isFinite(+p?.buyIns) ? +p.buyIns : 0,
    cashOut: Number.isFinite(+p?.cashOut) ? +p.cashOut : 0
  }));
  // settings
  out.buyInAmount = Number.isFinite(+d.buyInAmount) ? +d.buyInAmount : 50;
  out.prizeFromPot = !!d.prizeFromPot;
  out.prizeAmount = Number.isFinite(+d.prizeAmount) ? +d.prizeAmount : 20;
  out.prizeTieWinner = typeof d.prizeTieWinner === "string" ? d.prizeTieWinner : "";
  return out;
}

function auditPush(doc, entry) {
  if (!Array.isArray(doc.audit)) doc.audit = [];
  doc.audit.unshift({ ts: new Date().toISOString(), ...entry });
  if (doc.audit.length > 200) doc.audit.length = 200;
}

const SOFT_LIMIT_PER_MIN = parseInt(process.env.SOFT_LIMIT_PER_MIN || "30", 10);

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { "content-type": "application/json" } });
    }
    const body = await req.json().catch(() => null);
    const seasonId = body?.seasonId || process.env.SEASON_ID || "default";
    const draft = sanitizeDraft(body?.draft);
    if (!draft) {
      return new Response(JSON.stringify({ error: "Invalid draft" }), { status: 400, headers: { "content-type": "application/json" } });
    }

    const key = `season:${seasonId}`;
    const deviceId = req.headers.get("x-client-id") || "unknown";
    const byName = req.headers.get("x-client-name") || "Unknown";

    // Soft rate limit by device
    try {
      const rkey = `season:${seasonId}:rate:${deviceId}`;
      const count = await redis("INCR", rkey);
      if (Number(count) === 1) await redis("EXPIRE", rkey, 60);
      if (Number(count) > SOFT_LIMIT_PER_MIN) {
        return new Response(JSON.stringify({ error: "Too many draft saves" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" }
        });
      }
    } catch {}

    // Load, upsert draft, bump version
    const val = await redis("GET", key);
    let doc = val ? JSON.parse(val) : null;
    if (!doc || typeof doc !== "object") {
      doc = {
        seasonId,
        version: 0,
        updatedAt: new Date().toISOString(),
        games: [],
        profiles: {},
        draft: null,
        lock: null,
        audit: []
      };
    } else {
      if (!Array.isArray(doc.games)) doc.games = [];
      if (!doc.profiles || typeof doc.profiles !== "object") doc.profiles = {};
    }

    doc.draft = draft;
    doc.version = (doc.version | 0) + 1;
    doc.updatedAt = new Date().toISOString();
    auditPush(doc, { action: "draft-save", byName, deviceId, players: draft.players.length });

    await redis("SET", key, JSON.stringify(doc));
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "server error" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
