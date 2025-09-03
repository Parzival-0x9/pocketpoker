// /api/season/mark-payment.js
export const config = { runtime: "edge" };
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const KEY = (id)=> `pp:season:${id||"default"}`;

export default async function handler(req){
  try{
    const { seasonId="default", gameId, payer, paid=false, method=null } = await req.json();
    if (!gameId || !payer) return new Response("Missing gameId or payer", {status:400});

    const key = KEY(seasonId);
    const doc = await redis.get(key) || { version:0, games:[], profiles:{} };
    const games = [...(doc.games||[])];
    const idx = games.findIndex(g => String(g.id) === String(gameId));
    if (idx === -1) return new Response("Game not found", {status:404});

    const g = { ...(games[idx]||{}) };
    const perHead = { winner: g.perHead?.winner || null, amount: g.perHead?.amount || 20, payers: g.perHead?.payers || [], payments: g.perHead?.payments || {} };
    perHead.payments[payer] = { paid: !!paid, method: method||null, paidAt: !!paid ? new Date().toISOString() : null };
    if (!perHead.payers.includes(payer)) perHead.payers.push(payer);
    g.perHead = perHead;
    games[idx] = g;

    const next = { ...doc, games, version: Number(doc.version||0)+1, updatedAt: new Date().toISOString() };
    await redis.set(key, next);
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type":"application/json" } });
  }catch(e){
    return new Response(String(e?.message||e), { status: 500 });
  }
}
