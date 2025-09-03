// /api/season/delete-game.js
export const config = { runtime: "edge" };
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const KEY = (id)=> `pp:season:${id||"default"}`;

export default async function handler(req){
  try{
    const ifMatch = req.headers.get("if-match");
    const { seasonId="default", gameId } = await req.json();
    const key = KEY(seasonId);
    const doc = await redis.get(key) || { version:0, games:[], profiles:{} };

    if (ifMatch !== null && String(doc.version) !== String(ifMatch)) {
      return new Response(JSON.stringify({ error: "Version mismatch" }), { status: 409, headers: { "Content-Type":"application/json" } });
    }

    const games = (doc.games||[]).filter(g => String(g.id) !== String(gameId));
    const next = { ...doc, version: Number(doc.version||0)+1, games, updatedAt: new Date().toISOString() };
    await redis.set(key, next);
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type":"application/json" } });
  }catch(e){
    if (String(e).includes("rate")) return new Response("Too many saves", { status: 429 });
    return new Response(String(e?.message||e), { status: 500 });
  }
}
