import fs from "fs/promises";
import path from "path";

// ---------- Storage helpers (KV in prod, JSON file in dev) ----------
const KV_URL = process.env.KV_REST_API_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

async function kvGet(key) {
  const url = `${KV_URL.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KV_TOKEN}` }});
  if (!r.ok) throw new Error(`KV get failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.result ?? null;
}
async function kvSet(key, value) {
  const url = `${KV_URL.replace(/\/+$/,"")}/set/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`KV set failed ${r.status}: ${await r.text()}`);
  return true;
}

const isProdKV = !!(KV_URL && KV_TOKEN);

async function readSeason(seasonId) {
  if (isProdKV) {
    const raw = await kvGet(`season:${seasonId}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  const dir = path.join(process.cwd(), ".data");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `season_${seasonId}.json`);
  try {
    const buf = await fs.readFile(file, "utf8");
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

async function writeSeason(seasonId, doc) {
  if (isProdKV) {
    await kvSet(`season:${seasonId}`, JSON.stringify(doc));
    return;
  }
  const dir = path.join(process.cwd(), ".data");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `season_${seasonId}.json`);
  await fs.writeFile(file, JSON.stringify(doc, null, 2), "utf8");
}

// ---------- Util ----------
const round2 = (n) => Math.round((Number(n)||0) * 100) / 100;

function cleanPlayers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(p => ({
    id: String(p?.id || ""),
    name: String(p?.name || ""),
    buyIns: Math.max(0, Number.isFinite(p?.buyIns) ? p.buyIns : 0),
    cashOut: round2(Number.isFinite(p?.cashOut) ? p.cashOut : 0),
  }));
}

function emptySeason(seasonId) {
  return {
    id: seasonId,
    version: 0,
    games: [],
    profiles: {},
    draft: {
      players: [],
      buyInAmount: 50,
      prizeFromPot: true,
      prizeAmount: 20,
      prizeTieWinner: "",
    },
  };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { seasonId, draft } = req.body || {};
    if (!seasonId) return res.status(400).json({ error: "seasonId required" });

    let season = await readSeason(seasonId);
    if (!season) season = emptySeason(seasonId);

    const cleanDraft = {
      players: cleanPlayers(draft?.players),
      buyInAmount: Number.isFinite(draft?.buyInAmount) ? draft.buyInAmount : 50,
      prizeFromPot: !!draft?.prizeFromPot,
      prizeAmount: Number.isFinite(draft?.prizeAmount) ? draft.prizeAmount : 20,
      prizeTieWinner: typeof draft?.prizeTieWinner === "string" ? draft.prizeTieWinner : "",
    };

    season.draft = cleanDraft;
    season.version = Number.isFinite(season.version) ? season.version + 1 : 1;

    await writeSeason(seasonId, season);

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json(season);
  } catch (e) {
    console.error("draft-save error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
}