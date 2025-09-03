// /api/season/profile-upsert.js
export const config = { runtime: "edge" };
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const KEY = (id)=> `pp:season:${id||"default"}`;

export default async function handler(req){
  try{
    const { seasonId="default", name, payid=null, avatar=null } = await req.json();
    if (!name || typeof name !== "string") return new Response("Missing name", {status:400});

    const key = KEY(seasonId);
    const doc = await redis.get(key) || { version:0, games:[], profiles:{} };
    const profiles = { ...(doc.profiles||{}) };
    profiles[name] = { ...(profiles[name]||{}), payid, avatar, updatedAt: new Date().toISOString() };

    const next = { ...doc, profiles, version: Number(doc.version||0)+1, updatedAt: new Date().toISOString() };
    await redis.set(key, next);
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type":"application/json" } });
  }catch(e){
    return new Response(String(e?.message||e), { status: 500 });
  }
}
