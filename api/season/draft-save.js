// api/season/draft-save.js — store live 'Game' draft without bumping main version
// Expects: { seasonId, draft: { stamp:number, players:Array, buyInAmount:number, prizeFromPot:boolean, prizeAmount:number } }
import { readDoc, writeDoc } from "./_store.js"; // reuse your doc helpers if present

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const { seasonId, draft } = req.body || {};
    if (!seasonId) return res.status(400).send("seasonId required");
    if (!draft || typeof draft.stamp !== "number") return res.status(400).send("draft.stamp required");

    const doc = await readDoc(seasonId); // {version, games, profiles, ...}
    const prevStamp = doc?.draft?.stamp || 0;
    // Only accept if newer
    if (draft.stamp > prevStamp) {
      doc.draft = {
        stamp: draft.stamp,
        players: Array.isArray(draft.players) ? draft.players : [],
        buyInAmount: typeof draft.buyInAmount === "number" ? draft.buyInAmount : doc?.draft?.buyInAmount ?? 50,
        prizeFromPot: typeof draft.prizeFromPot === "boolean" ? draft.prizeFromPot : (doc?.draft?.prizeFromPot ?? true),
        prizeAmount: typeof draft.prizeAmount === "number" ? draft.prizeAmount : (doc?.draft?.prizeAmount ?? 20)
      };
      // Do NOT bump doc.version here (it's just a draft)
      await writeDoc(seasonId, doc);
    }
    return res.status(200).json({ ok: true });
  }catch(e){
    console.error(e);
    return res.status(500).send(String(e?.message || e));
  }
}
