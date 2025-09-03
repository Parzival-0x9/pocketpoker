// /api/season/profile-upsert.js
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
    const { seasonId="default", name, payid=null, avatar=null } = await readJson(req);
    if (!name || typeof name !== "string") return res.status(400).send("Missing name");

    const key = KEY(seasonId);
    const doc = await redis.get(key) || { version:0, games:[], profiles:{} };
    const profiles = { ...(doc.profiles||{}) };
    profiles[name] = { ...(profiles[name]||{}), payid, avatar, updatedAt: new Date().toISOString() };

    const next = { ...doc, profiles, version: Number(doc.version||0)+1, updatedAt: new Date().toISOString() };
    await redis.set(key, next);
    sendJson(res, 200, next);
  }catch(e){
    res.status(500).send(String(e?.message||e));
  }
}
