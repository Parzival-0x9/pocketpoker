// /api/season/mark-payment.js
export const config = { runtime: "nodejs" };
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const KEY = (id)=> `pp:season:${id||"default"}`;

function sendJson(res, code, obj){
  res.status(code).setHeader("Content-Type","application/json");
  res.end(JSON.stringify(obj));
}
async function readJson(req){
  const chunks=[]; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  return body?JSON.parse(body):{};
}

export default async function handler(req, res){
  try{
    const { seasonId="default", gameId, payer, paid=false, method=null } = await readJson(req);
    if (!gameId || !payer) return res.status(400).send("Missing gameId or payer");

    const key = KEY(seasonId);
    const doc = await redis.get(key) || { version:0, games:[], profiles:{} };
    const games = [...(doc.games||[])];
    const idx = games.findIndex(g => String(g.id) === String(gameId));
    if (idx === -1) return res.status(404).send("Game not found");

    const g = { ...(games[idx]||{}) };
    const perHead = { winner: g.perHead?.winner || null, amount: g.perHead?.amount || 20, payers: g.perHead?.payers || [], payments: g.perHead?.payments || {} };
    perHead.payments[payer] = { paid: !!paid, method: method||null, paidAt: !!paid ? new Date().toISOString() : null };
    if (!perHead.payers.includes(payer)) perHead.payers.push(payer);
    g.perHead = perHead;
    games[idx] = g;

    const next = { ...doc, games, version: Number(doc.version||0)+1, updatedAt: new Date().toISOString() };
    await redis.set(key, next);
    sendJson(res, 200, next);
  }catch(e){
    res.status(500).send(String(e?.message||e));
  }
}
