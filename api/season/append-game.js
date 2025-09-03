// /api/season/append-game.js
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
    const ifMatch = req.headers["if-match"] ?? null;
    const { seasonId="default", game } = await readJson(req);
    const key = KEY(seasonId);
    let doc = await redis.get(key) || { version:0, games:[], profiles:{} };

    if (ifMatch !== null && String(doc.version) !== String(ifMatch)) {
      return sendJson(res, 409, { error: "Version mismatch" });
    }

    const next = {
      ...doc,
      version: Number(doc.version||0) + 1,
      games: [...(doc.games||[]), game],
      updatedAt: new Date().toISOString()
    };
    await redis.set(key, next);
    sendJson(res, 200, next);
  }catch(e){
    if (String(e).includes("rate")) return res.status(429).send("Too many saves");
    res.status(500).send(String(e?.message||e));
  }
}
