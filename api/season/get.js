// /api/season/get.js
export const config = { runtime: "nodejs" };
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const KEY = (id)=> `pp:season:${id||"default"}`;

function sendJson(res, code, obj){
  res.status(code).setHeader("Content-Type","application/json");
  res.end(JSON.stringify(obj));
}

async function loadDoc(id){
  let doc = await redis.get(KEY(id));
  if (typeof doc === "string") { try{ doc = JSON.parse(doc); }catch{} }
  if (!doc) {
    doc = { version:0, games:[], profiles:{}, updatedAt:new Date().toISOString() };
    await redis.set(KEY(id), doc);
  }
  return doc;
}

export default async function handler(req, res){
  try{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get("id") || "default";
    const doc = await loadDoc(id);
    sendJson(res, 200, doc);
  }catch(e){
    res.status(500).send(String(e?.message||e));
  }
}
