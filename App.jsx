/* App.jsx — End Game Save Fixes + Confirmation
   Includes:
   - Tie-winner override
   - Cross-device draft sync (players, buy-in, prize, override)
   - Proper 409 handling for append/delete
   - Confirmation prompt before saving
*/
import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./components/PlayerRow.jsx";
import { aud, sum, round2, toCSV } from "./lib/calc.js";

// ===== Cloud config =====
const API_BASE = ""; // same origin
const SEASON_ID = (import.meta && import.meta.env && import.meta.env.VITE_SEASON_ID) || "default";

const DEFAULT_BUYIN=50, DEFAULT_PRIZE=20, uid=()=>Math.random().toString(36).slice(2,9);
const blank=()=>({id:uid(),name:"",buyIns:0,cashOut:0});
const LS="pocketpoker_state", THEME="pp_theme", FELT="pp_felt", PROFILES="pp_profiles";
const load=()=>{try{const r=localStorage.getItem(LS);return r?JSON.parse(r):null}catch{return null}};
const save=(s)=>{try{localStorage.setItem(LS,JSON.stringify(s))}catch{}};

// === Equal-split per loser (deterministic; caps at winners' needs; ignores prize) ===
function settleEqualSplitCapped(rows){
  const winnersBase = rows.filter(r=> r.net > 0.0001).map(r=>({ name: (r.name||"Player"), need: round2(r.net) }));
  const losersBase  = rows.filter(r=> r.net < -0.0001).map(r=>({ name: (r.name||"Player"), loss: round2(-r.net) }));
  const txns = [];
  if (!winnersBase.length || !losersBase.length) return txns;
  const winnersOrder = [...winnersBase].sort((a,b)=> a.name.localeCompare(b.name));
  const losersSorted = [...losersBase].sort((a,b)=> (b.loss - a.loss) || a.name.localeCompare(b.name));
  const getEligible = () => winnersOrder.filter(w => w.need > 0.0001);
  losersSorted.forEach(L => {
    let remaining = round2(L.loss);
    while (remaining > 0.0001) {
      const eligible = getEligible(); if (!eligible.length) break;
      const equalRaw = remaining / eligible.length;
      let distributed = 0;
      for (let i = 0; i < eligible.length; i++) {
        const w = eligible[i];
        const isLast = i === eligible.length - 1;
        const shareTarget = Math.min(equalRaw, w.need);
        let give = isLast ? round2(remaining - distributed) : round2(shareTarget);
        give = Math.min(give, round2(w.need), round2(remaining - distributed));
        if (give > 0.0001) {
          txns.push({ from: L.name, to: w.name, amount: round2(give) });
          w.need = round2(w.need - give);
          distributed = round2(distributed + give);
        }
      }
      remaining = round2(remaining - distributed);
      if (distributed <= 0.0001) break;
    }
  });
  return txns;
}
// === End equal-split ===

export default function App(){
  // --- Game state
  const [players,setPlayers]=useState([blank(),blank()]);
  const [buyInAmount,setBuyInAmount]=useState(DEFAULT_BUYIN);
  const [prizeFromPot,setPrizeFromPot]=useState(true);
  const [prizeAmount,setPrizeAmount]=useState(DEFAULT_PRIZE);
  const [prizeTieWinner, setPrizeTieWinner] = useState(""); // "" => split equally
  const [overrideMismatch,setOverrideMismatch]=useState(false);

  // --- Cloud doc
  const [history,setHistory]=useState([]);
  const [profiles,setProfiles]=useState(()=>{ try{ return JSON.parse(localStorage.getItem(PROFILES)) || {}; } catch { return {}; } });
  const [cloudVersion,setCloudVersion]=useState(0);
  const [syncStatus,setSyncStatus]=useState("idle"); // idle|syncing|upToDate|error

  // drafts for Profiles UI
  const [profileDrafts, setProfileDrafts] = useState({}); // { [name]: {payid?, avatar?} }

  // --- UI state
  const [theme,setTheme]=useState(()=>localStorage.getItem(THEME) || "dark");
  const [felt,setFelt]=useState(()=>localStorage.getItem(FELT) || "emerald");
  const [expanded,setExpanded]=useState({});
  const [ledgerExpanded,setLedgerExpanded]=useState({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tab, setTab] = useState(()=> localStorage.getItem("pp_tab") || "game");
  useEffect(()=>{ localStorage.setItem("pp_tab", tab); }, [tab]);

  // ----- Cloud API helpers -----
  async function apiGetSeason(){
    const res = await fetch(`${API_BASE}/api/season/get?id=${encodeURIComponent(SEASON_ID)}`);
    if(!res.ok) throw new Error(await res.text());
    return await res.json();
  }
  async function apiAppendGame(game){
    const tryPost = async (ver) => {
      const res = await fetch(`${API_BASE}/api/season/append-game`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "If-Match": String(ver) },
        body: JSON.stringify({ seasonId: SEASON_ID, game })
      });
      if (res.status === 429) { alert("Too many saves, try again in a moment."); throw new Error("429"); }
      if (res.status === 409) { throw new Error("409"); }
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    };
    try{
      return await tryPost(cloudVersion);
    }catch(e){
      if (String(e.message||"") === "409") {
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        return await tryPost(doc.version || 0);
      }
      throw e;
    }
  }
  async function apiDeleteGame(gameId){
    const tryPost = async (ver) => {
      const res = await fetch(`${API_BASE}/api/season/delete-game`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "If-Match": String(ver) },
        body: JSON.stringify({ seasonId: SEASON_ID, gameId })
      });
      if (res.status === 429) { alert("Too many saves, try again in a moment."); throw new Error("429"); }
      if (res.status === 409) { throw new Error("409"); }
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    };
    try{
      return await tryPost(cloudVersion);
    }catch(e){
      if (String(e.message||"") === "409") {
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        return await tryPost(doc.version || 0);
      }
      throw e;
    }
  }
  async function apiProfileUpsert({name, payid, avatar}){
    const res = await fetch(`${API_BASE}/api/season/profile-upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seasonId: SEASON_ID, name, payid, avatar })
    });
    if (!res.ok) { alert(await res.text()); return; }
    const doc = await res.json().catch(()=>null);
    if (doc) hydrateFromDoc(doc);
  }
  async function apiMarkPayment({gameId, payer, paid, method}){
    const res = await fetch(`${API_BASE}/api/season/mark-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seasonId: SEASON_ID, gameId, payer, paid, method: method||null })
    });
    if (!res.ok) { alert(await res.text()); return; }
    const doc = await res.json().catch(()=>null);
    if (doc) hydrateFromDoc(doc);
  }

  // --- DRAFT SAVE (sync live game state across devices) ---
  async function apiDraftSave(draft){
    try{
      const res = await fetch(`${API_BASE}/api/season/draft-save`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ seasonId: SEASON_ID, draft })
      });
      if (!res.ok) return; // best-effort
      const doc = await res.json().catch(()=>null);
      if (doc) hydrateFromDoc(doc); // bump version so next save won't 409
    }catch(e){
      console.warn("draft-save failed", e); // best-effort
    }
  }

  function hydrateFromDoc(doc){
    if (doc && typeof doc.version === "number") setCloudVersion(doc.version);
    if (doc && Array.isArray(doc.games)) setHistory(doc.games);
    if (doc && doc.profiles && typeof doc.profiles === 'object') setProfiles(doc.profiles);

    // --- hydrate live draft (so other devices see edits after Refresh) ---
    if (doc?.draft && typeof doc.draft === "object") {
      if (Array.isArray(doc.draft.players)) setPlayers(doc.draft.players);
      if (typeof doc.draft.buyInAmount === "number") setBuyInAmount(doc.draft.buyInAmount);
      if (typeof doc.draft.prizeFromPot === "boolean") setPrizeFromPot(doc.draft.prizeFromPot);
      if (typeof doc.draft.prizeAmount === "number") setPrizeAmount(doc.draft.prizeAmount);
      if (typeof doc.draft.prizeTieWinner === "string") setPrizeTieWinner(doc.draft.prizeTieWinner || "");
    }
  }

  async function refreshSeason(){
    try{
      setSyncStatus("syncing");
      const doc = await apiGetSeason();
      hydrateFromDoc(doc);
      setSyncStatus("upToDate");
    }catch(e){
      setSyncStatus("error");
    }
  }

  // ----- Local load, then server hydrate -----
  useEffect(()=>{ 
    const s=load();
    if(s){
      setPlayers(s.players?.length?s.players:[blank(),blank()]);
      setBuyInAmount(s.buyInAmount ?? DEFAULT_BUYIN);
      setPrizeFromPot( typeof s.prizeFromPot === "boolean" ? s.prizeFromPot : true );
      setPrizeAmount( typeof s.prizeAmount === "number" ? s.prizeAmount : DEFAULT_PRIZE );
      setHistory(s.history ?? []);
    }
    (async()=>{
      try{
        setSyncStatus("syncing");
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        setSyncStatus("upToDate");
      }catch{
        setSyncStatus("error");
      }
    })();
  },[]);

  // Persist local (players, settings). Profiles cached locally too.
  useEffect(()=>{ 
    save({players,buyInAmount,prizeFromPot,prizeAmount,history});
  }, [players,buyInAmount,prizeFromPot,prizeAmount,history]);
  useEffect(()=>{
    try{ localStorage.setItem(PROFILES, JSON.stringify(profiles)); }catch{}
  }, [profiles]);

  // --- Debounced draft sync: push live game state to server ---
  useEffect(()=>{
    const t = setTimeout(()=>{
      apiDraftSave({
        players,
        buyInAmount,
        prizeFromPot,
        prizeAmount,
        prizeTieWinner, // include the tie-winner override so it syncs too
      });
    }, 500);
    return ()=>clearTimeout(t);
  }, [players, buyInAmount, prizeFromPot, prizeAmount, prizeTieWinner]);

  useEffect(()=>{
    document.documentElement.setAttribute('data-theme', theme==='light'?'light':'dark');
    localStorage.setItem(THEME, theme);
  }, [theme]);
  useEffect(()=>{
    document.documentElement.setAttribute('data-felt', felt==='midnight'?'midnight':'emerald');
    localStorage.setItem(FELT, felt);
  }, [felt]);

  // Totals (uses equal-split per-loser for txns; ignores prize when splitting)
  const totals = useMemo(() => {
    const base = players.map(p => ({
      ...p,
      buyInTotal: round2(p.buyIns * buyInAmount),
      baseCash: p.cashOut
    }));
    const withNet = base.map(p => ({
      ...p,
      net: round2(p.baseCash - p.buyIns * buyInAmount)
    }));

    // Prize-from-pot adjusts display (netAdj/cashOutAdj); settlement ignores prize
    let adjusted = withNet.map(p => ({
      ...p,
      prize: 0,
      cashOutAdj: round2(p.baseCash),
      netAdj: round2(p.baseCash - p.buyIns * buyInAmount)
    }));

    if (prizeFromPot && players.length >= 2) {
      const N = adjusted.length;
      const topNet = Math.max(...withNet.map(p => p.net));
      const winnersArr = withNet.filter(p => Math.abs(p.net - topNet) < 0.0001);
      const winnerNames = winnersArr.map(p => p.name || "Player");
      const T = winnersArr.length;
      const pool = round2(prizeAmount * N);
      const perWinner = T > 0 ? round2(pool / T) : 0;

      // Deduct prize from everyone first
      adjusted = adjusted.map(p => {
        const cash = round2(p.baseCash - prizeAmount);
        return {
          ...p,
          prize: round2(-prizeAmount),
          cashOutAdj: cash,
          netAdj: round2(cash - p.buyIns * buyInAmount)
        };
      });

      // If there's a tie and an override winner is chosen, give full pool to that one
      const tieName =
        typeof prizeTieWinner === "string" && prizeTieWinner ? prizeTieWinner : null;
      const useSingle = T > 1 && tieName && winnerNames.includes(tieName);

      if (useSingle) {
        adjusted = adjusted.map(p => {
          if ((p.name || "Player") === tieName) {
            const cash = round2(p.cashOutAdj + pool);
            return {
              ...p,
              prize: round2(p.prize + pool),
              cashOutAdj: cash,
              netAdj: round2(cash - p.buyIns * buyInAmount)
            };
          }
          return p;
        });
      } else {
        // Default behavior: split pool equally among all top winners
        let distributed = 0, idx = 0;
        adjusted = adjusted.map(p => {
          if (Math.abs((p.baseCash - p.buyIns * buyInAmount) - topNet) < 0.0001) {
            const isLast = idx === T - 1;
            const give = isLast ? round2(pool - distributed) : perWinner;
            distributed = round2(distributed + give);
            const cash = round2(p.cashOutAdj + give);
            idx++;
            return {
              ...p,
              prize: round2(p.prize + give),
              cashOutAdj: cash,
              netAdj: round2(cash - p.buyIns * buyInAmount)
            };
          }
          return p;
        });
      }
    }

    const buyInSum = round2(sum(adjusted.map(p => p.buyInTotal)));
    const cashAdjSum = round2(sum(adjusted.map(p => p.cashOutAdj)));
    const diff = round2(cashAdjSum - buyInSum);

    // Equal-split ignores prize; use original game-only net as basis
    const basis = withNet.map(p => ({ name: p.name || "Player", net: p.net }));
    const txns = settleEqualSplitCapped(basis);

    const sorted = [...adjusted].sort((a, b) => b.netAdj - a.netAdj);
    const top = sorted.length ? sorted[0] : null;

    return { adjusted, buyInSum, cashAdjSum, diff, txns, top };
  }, [players, buyInAmount, prizeFromPot, prizeAmount, prizeTieWinner]);

  function updatePlayer(u){
    setPlayers(ps => u?._remove ? ps.filter(p => p.id !== u.id) : ps.map(p => p.id === u.id ? u : p));
  }
  const addPlayer=()=>setPlayers(ps=>[...ps,blank()]);
  const startGame=()=>{ setPlayers(ps=>ps.map(p=>({ ...p, buyIns:0, cashOut:0 }))); setOverrideMismatch(false); };
  const resetGame=()=>{ setPlayers([blank(),blank()]); setOverrideMismatch(false); };

  async function saveGameToHistory(){
    // Confirmation prompt
    const ok = window.confirm(
      `End game and save?\n\n`+
      `Players: ${players.length}\n`+
      `Buy-in: A$${buyInAmount}\n`+
      `Prize from pot: ${prizeFromPot ? "ON" : "OFF"}${prizeFromPot ? ` (A$${prizeAmount})` : ""}\n\n`+
      `You can undo by deleting from History later.`
    );
    if (!ok) return;

    const stamp = new Date().toISOString();
    const g={ id:uid(), stamp,
      settings:{
        buyInAmount,
        prize: prizeFromPot ? { mode:'pot_all', amount: prizeAmount, tieWinner: prizeTieWinner || null } : { mode:'none', amount: 0, tieWinner: null },
        settlement: { mode: 'equalSplit' }
      },
      players: totals.adjusted.map(p=>({
        name:p.name||"Player",buyIns:p.buyIns,buyInTotal:p.buyInTotal,
        cashOut:p.cashOutAdj,prize:p.prize,net:p.netAdj
      })),
      totals:{buyIns:totals.buyInSum,cashOuts:totals.cashAdjSum,diff:totals.diff},
      txns: totals.txns
    };
    try{
      setSyncStatus("syncing");
      const doc = await apiAppendGame(g);
      hydrateFromDoc(doc);
      setSyncStatus("upToDate");
      alert("Saved! Check the History tab.");
    }catch(e){
      console.error(e);
      alert("Save failed. Try Refresh, then save again.");
      setSyncStatus("error");
    }
  }

  function autoBalance(){
    const {top,diff}=totals; if(!top||Math.abs(diff)<0.01) return;
    setPlayers(ps=>ps.map(p=>p.id===top.id?{...p,cashOut:round2(p.cashOut - diff)}:p));
  }
  function deleteGame(id){
    if (!window.confirm("Delete this game from history?")) return;
    (async()=>{
      try{
        setSyncStatus("syncing");
        const doc = await apiDeleteGame(id);
        hydrateFromDoc(doc);
        setSyncStatus("upToDate");
      }catch(e){
        console.error(e);
        alert("Delete failed. Try Refresh then delete again.");
        setSyncStatus("error");
      }
    })();
  }

  function downloadCSV(filename, rows){
    const csv = toCSV(rows);
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }
  function exportSeason(){
    const r1 = [["game_id","stamp","player","buy_in","cash_out","prize_adj","net"]];
    history.forEach(g=>{ g.players.forEach(p=> r1.push([g.id, g.stamp, p.name, p.buyInTotal, p.cashOut, p.prize, p.net])); });
    downloadCSV("players.csv", r1);

    const r2 = [["game_id","stamp","from","to","amount"]];
    history.forEach(g => (g.txns || []).forEach(t => r2.push([g.id, g.stamp, t.from, t.to, t.amount])));
    downloadCSV("transfers.csv", r2);
  }

  const knownNames = useMemo(()=>{
    const set = new Set();
    players.forEach(p=> p.name && set.add(p.name));
    history.forEach(g=> g.players.forEach(p=> p.name && set.add(p.name)));
    return Array.from(set).sort();
  }, [players, history]);

  // ---- Ledgers (cumulative) ----
  const ledgers = useMemo(()=>{
    const L = new Map();
    const ensure = (n)=>{
      if(!L.has(n)) L.set(n,{ netTransfers:0, prize:0, owes:new Map(), owedBy:new Map(), owesPrize:new Map(), owedByPrize:new Map() });
      return L.get(n);
    };
    history.forEach(g=>{
      (g.txns||[]).forEach(t=>{
        const amt = round2(t.amount);
        const from=ensure(t.from), to=ensure(t.to);
        from.netTransfers = round2((from.netTransfers||0) - amt);
        to.netTransfers   = round2((to.netTransfers||0)   + amt);
        from.owes.set(t.to, round2((from.owes.get(t.to)||0) + amt));
        to.owedBy.set(t.from, round2((to.owedBy.get(t.from)||0) + amt));
      });

      const pm = g.settings?.prize?.mode;
      const plist = g.players || [];
      plist.forEach(p=>{
        const v = ensure(p.name||"Player");
        v.prize = round2((v.prize||0) + round2(p.prize||0));
      });
      if (pm === 'pot_all' && plist.length > 0) {
        const prmAmt = typeof g.settings?.prize?.amount === 'number' ? g.settings.prize.amount : DEFAULT_PRIZE;
        const netsGameOnly = plist.map(p=> ({ name: p.name||"Player", netGame: round2((p.net||0) - (p.prize||0)) }));
        const top = Math.max(...netsGameOnly.map(x=>x.netGame));
        const winners = netsGameOnly.filter(x => Math.abs(x.netGame - top) < 0.0001).map(x=>x.name);
        const T = winners.length || 1;
        const share = round2(prmAmt / T);
        plist.forEach(p=>{
          const pname = p.name||"Player";
          const contributed = round2(p.prize||0) < 0 ? round2(-p.prize) : 0;
          if (contributed <= 0.0001) return;
          winners.forEach(wname=>{
            if (wname === pname) return;
            const vFrom = ensure(pname), vTo = ensure(wname);
            const amt = round2(share);
            vFrom.owesPrize.set(wname, round2((vFrom.owesPrize.get(wname)||0) + amt));
            vTo.owedByPrize.set(pname, round2((vTo.owedByPrize.get(pname)||0) + amt));
          });
        });
      }
    });
    const out = {};
    for (const [name, v] of L) {
      out[name] = {
        net: round2((v.netTransfers||0) + (v.prize||0)),
        prize: round2(v.prize||0),
        netTransfers: round2(v.netTransfers||0),
        owes: Array.from(v.owes, ([to,amount])=>({to,amount:round2(amount)})),
        owedBy: Array.from(v.owedBy, ([from,amount])=>({from,amount:round2(amount)})),
        owesPrize: Array.from(v.owesPrize, ([to,amount])=>({to,amount:round2(amount)})),
        owedByPrize: Array.from(v.owedByPrize, ([from,amount])=>({from,amount:round2(amount)}))
      };
    }
    return out;
  }, [history]);

  // ---- Stats (scoped, fractional ties) ----
  const [winsMode, setWinsMode] = useState("fractional");
  const [winsScope, setWinsScope] = useState("all");
  const stats = useMemo(()=>{
    const byTimeAsc = [...history].sort((a,b)=> new Date(a.stamp) - new Date(b.stamp));
    let games = byTimeAsc;
    if (winsScope === 'last10') games = byTimeAsc.slice(-10);
    if (winsScope === 'last20') games = byTimeAsc.slice(-20);

    const wins = new Map();
    const played = new Map();
    const cumulative = {};
    const streakNow = new Map();
    const streakBest = new Map();

    const allNames = new Set();
    games.forEach(g=> g.players.forEach(p=> allNames.add(p.name||"Player")));
    [...allNames].forEach(n=> cumulative[n] = []);

    const dates = games.map(g=> new Date(g.stamp));

    games.forEach((g, gi)=>{
      const roster = new Set(g.players.map(p=> p.name||"Player"));
      roster.forEach(n=> played.set(n, (played.get(n)||0)+1));

      const netsGame = g.players.map(p=> ({ name: p.name||"Player", netGame: round2((p.net||0) - (p.prize||0)) }));
      const top = Math.max(...netsGame.map(x=>x.netGame));
      const winners = netsGame.filter(x => Math.abs(x.netGame - top) < 0.0001).map(x=>x.name);
      const T = winners.length || 1;
      const add = winsMode === 'fractional' ? (1 / T) : 1;
      const winnersSet = new Set(winners);

      netsGame.forEach(x=>{
        wins.set(x.name, round2((wins.get(x.name)||0) + (winnersSet.has(x.name) ? add : 0)));
        const cur = (streakNow.get(x.name) || 0);
        const next = winnersSet.has(x.name) ? cur + 1 : 0;
        streakNow.set(x.name, next);
        streakBest.set(x.name, Math.max(streakBest.get(x.name)||0, next));
      });

      [...allNames].forEach(n=>{
        const prev = gi>0 ? cumulative[n][gi-1] : 0;
        const inc = winnersSet.has(n) ? add : 0;
        cumulative[n][gi] = round2(prev + inc);
      });
    });

    let bestNight = { name:null, amount: -Infinity, date:null, gameId:null };
    games.forEach(g=>{
      const arr = g.players.map(p=> ({ name: p.name||"Player", netGame: round2((p.net||0) - (p.prize||0)) }));
      arr.forEach(x=>{
        if (x.netGame > bestNight.amount) bestNight = { name:x.name, amount:x.netGame, date: new Date(g.stamp), gameId:g.id };
      });
    });

    const leaderboard = Array.from(wins, ([name, w]) => {
      const gp = played.get(name)||0;
      const rate = gp>0 ? round2((w/gp)*100) : 0;
      return {name, wins:w, played:gp, rate};
    }).sort((a,b)=> b.wins - a.wins);

    const streakObj = Object.fromEntries(Array.from(streakBest.entries()));

    return { games, dates, wins:leaderboard, cumulative, bestNight, streakBest:streakObj };
  }, [history, winsMode, winsScope]);

  // --- UI sections ---
  const GameSection = (
    <div className="surface" style={{marginTop:16}}>
      <div className="controls">
        <div className="stack">
          <button className="btn primary" onClick={startGame}>Start New</button>
          <button className="btn secondary" onClick={addPlayer}>Add Player</button>
          <button className="btn danger" onClick={resetGame}>Reset Players</button>
          <span className="pill">🎯 Enter cash-outs at the end.</span>
        </div>
        <div className="toggles toolbar">
          <label className="inline">Buy-in (A$)
            <input className="small mono" type="number" min="1" step="1" value={buyInAmount} onChange={e=>setBuyInAmount(Math.max(1,parseFloat(e.target.value||50)))} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={prizeFromPot} onChange={e=>setPrizeFromPot(e.target.checked)} /> Prize from pot: A$
          </label>
          <input className="small mono" type="number" min="0" step="1" value={prizeAmount} onChange={e=>setPrizeAmount(Math.max(0,parseFloat(e.target.value||0)))} />
          {prizeFromPot && (()=>{
            // detect ties among winners on game-only net
            const baseTmp = players.map(p=>({...p, buyInTotal:round2(p.buyIns*buyInAmount), baseCash:p.cashOut }));
            const withNetTmp = baseTmp.map(p=>({...p, net: round2(p.baseCash - p.buyIns*buyInAmount)}));
            if (withNetTmp.length < 2) return null;
            const topNetTmp = Math.max(...withNetTmp.map(p=>p.net));
            const winnersTmp = withNetTmp.filter(p=> Math.abs(p.net - topNetTmp) < 0.0001).map(p=> p.name || "Player");
            if (winnersTmp.length <= 1) return null;
            return (
              <label className="inline">
                Tie winner override
                <select value={prizeTieWinner} onChange={e=>setPrizeTieWinner(e.target.value)}>
                  <option value="">Split equally</option>
                  {winnersTmp.map(n=> <option key={n} value={n}>{n} (single)</option>)}
                </select>
              </label>
            );
          })()}

          <span className="meta">deduct from all players; split pool among top winners</span>
        </div>
      </div>

      <hr className="hair" />

      <table className="table">
        <thead>
          <tr>
            <th>Player</th>
            <th className="center">Buy-ins</th>
            <th className="center">Cash-out</th>
            <th className="center">Net</th>
            <th className="center">Actions</th>
          </tr>
        </thead>
        <tbody>
          {players.map(p => (<PlayerRow key={p.id} p={p} onChange={updatePlayer} buyInAmount={buyInAmount} />))}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th className="center mono">A${totals.buyInSum.toFixed(2)}</th>
            <th className="center mono">A${totals.cashAdjSum.toFixed(2)}</th>
            <th className="center mono">{totals.diff.toFixed(2)}</th>
            <th className="center"></th>
          </tr>
        </tfoot>
      </table>

      {Math.abs(totals.diff) > 0.01 ? (
        <div className="header" style={{marginTop:12}}>
          <div className="ribbon">⚠️ Off by {aud(totals.diff)}. Use Auto-Balance or tick Override.</div>
          <div className="toolbar">
            <button className="btn secondary" onClick={autoBalance}>Auto-Balance</button>
            <label className="inline"><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} /> Override & Save</label>
          </div>
        </div>
      ) : (
        <div className="header" style={{marginTop:12}}>
          <div className="ribbon">✅ Balanced: totals match.</div>
          <div className="toolbar"></div>
        </div>
      )}

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:12}}>
        <button className="btn success" onClick={saveGameToHistory} disabled={Math.abs(totals.diff) > 0.01 && !overrideMismatch}>End Game & Save</button>
      </div>
    </div>
  );

  const HistorySection = (
    <div className="surface">
      <div className="header" style={{marginBottom:0}}>
        <h3 style={{margin:0}}>Game Overview (History)</h3>
        <div className="toolbar">
          <button className="btn secondary" onClick={exportSeason}>Export CSVs</button>
          <button className="btn ghost" onClick={refreshSeason}>Refresh</button>
        </div>
      </div>
      <div className="meta">This list reflects the season stored on the server.</div>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Players (with net)</th>
            <th className="center">Totals</th>
            <th className="center">Actions</th>
          </tr>
        </thead>
        <tbody>
          {history.length===0 ? (
            <tr><td colSpan="4" className="center meta">No games saved yet.</td></tr>
          ) : history.map(g=>{
            const key=g.id;
            const playersSorted=[...g.players].sort((a,b)=>b.net-a.net);
            const winner = playersSorted[0];
            const summary=playersSorted.map(p=>(
              <span key={p.name} style={{marginRight:8}}>
                {p.name} ({p.net>=0?'+':''}{p.net.toFixed(2)})
                {profiles[p.name]?.payid && <span className="meta" style={{marginLeft:6}}>• {profiles[p.name].payid}</span>}
              </span>
            ));

            const totalsCell = `${aud(g.totals.buyIns)} / ${aud(g.totals.cashOuts)} (${aud(g.totals.diff)})`;

            // Per-head payments section: only show if server stored g.perHead
            const perHead = g.perHead;
            const perHeadBlock = perHead ? (
              <div className="card" style={{marginTop:8}}>
                <div className="card-head">
                  <strong>Per-head payments</strong>
                  <span className="meta"> Winner: {perHead.winner} • A${perHead.amount} from {perHead.payers?.length || 0} players</span>
                </div>
                <table className="table">
                  <thead><tr><th>Payer</th><th className="center">Paid?</th><th className="center">Method</th></tr></thead>
                  <tbody>
                    {(perHead.payers||[]).map(payer=>{
                      const rec = perHead.payments?.[payer] || {paid:false, method:null, paidAt:null};
                      return (
                        <tr key={payer}>
                          <td>{payer}</td>
                          <td className="center">
                            <input
                              type="checkbox"
                              checked={!!rec.paid}
                              onChange={(e)=> apiMarkPayment({gameId:g.id, payer, paid:e.target.checked, method: rec.method || "PayID"})}
                            />
                          </td>
                          <td className="center">
                            <select
                              value={rec.method || ""}
                              onChange={(e)=> apiMarkPayment({gameId:g.id, payer, paid:true, method:e.target.value})}
                            >
                              <option value="">—</option>
                              <option value="PayID">PayID</option>
                              <option value="Cash">Cash</option>
                              <option value="Bank">Bank</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null;

            return (
              <React.Fragment key={g.id}>
                <tr>
                  <td className="meta mono">{new Date(g.stamp).toLocaleString()}</td>
                  <td>{summary}</td>
                  <td className="center mono">{totalsCell}</td>
                  <td className="center">
                    <div className="toolbar" style={{justifyContent:'center'}}>
                      <button className="btn secondary" onClick={()=>setExpanded(e=>({...e,[key]:!e[key]}))}>{expanded[key]?'Hide':'Details'}</button>
                      <button className="btn danger" onClick={()=>deleteGame(g.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
                {expanded[key] && (
                  <tr>
                    <td colSpan="4">
                      <div className="detail">
                        <strong>Per-player results</strong>
                        <table className="table">
                          <thead><tr><th>Player</th><th className="center">Buy-in</th><th className="center">Cash-out (adj)</th><th className="center">Prize adj</th><th className="center">Net</th></tr></thead>
                          <tbody>
                            {playersSorted.map(p=>(
                              <tr key={p.name}>
                                <td>{p.name}{p.name===winner?.name && <span className="chip" />}</td>
                                <td className="center mono">{aud(p.buyInTotal)}</td>
                                <td className="center mono">{aud(p.cashOut)}</td>
                                <td className="center mono">{aud(p.prize)}</td>
                                <td className="center mono">{p.net>=0?'+':''}{aud(p.net)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        <div style={{height:8}} />
                        <strong>Transfers for settlement</strong> <span className="meta">(equal-split per loser)</span>
                        <table className="table">
                          <thead><tr><th>From</th><th>To</th><th className="center">Amount</th></tr></thead>
                          <tbody>
                            {(g.txns||[]).length===0 ? (
                              <tr><td colSpan="3" className="center meta">No transfers needed.</td></tr>
                            ) : (g.txns||[]).map((t,i)=>(
                              <tr key={i}><td>{t.from}</td><td>{t.to}</td><td className="center mono">{aud(t.amount)}</td></tr>
                            ))}
                          </tbody>
                        </table>

                        {perHeadBlock}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const LedgersSection = (
    <div className="surface">
      <h3 style={{marginTop:0}}>Player Ledgers (Cumulative)</h3>
      <div className="meta">Net = Transfers + Prize impact.</div>
      <table className="table">
        <thead><tr><th>Player</th><th className="center">Net Balance</th><th className="center">Prize Impact</th><th className="center">Actions</th></tr></thead>
        <tbody>
          {Object.keys(ledgers).length===0 ? (
            <tr><td colSpan="4" className="center meta">No history yet.</td></tr>
          ) : Object.entries(ledgers).sort((a,b)=> (b[1].net - a[1].net)).map(([name,info])=>{
            const key = name;
            return (
              <React.Fragment key={name}>
                <tr>
                  <td>{name}</td>
                  <td className="center mono">{info.net>=0?'+':''}{aud(info.net)}</td>
                  <td className="center mono">{info.prize>=0?'+':''}{aud(info.prize)}</td>
                  <td className="center">
                    <button className="btn secondary" onClick={()=>setLedgerExpanded(e=>({...e,[key]:!e[key]}))}>
                      {ledgerExpanded[key] ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
                {ledgerExpanded[key] && (
                  <tr>
                    <td colSpan="4">
                      <div className="detail">
                        <div className="meta" style={{marginBottom:8}}>
                          Transfers net: {info.netTransfers>=0?'+':''}{aud(info.netTransfers)} • Prize impact: {info.prize>=0?'+':''}{aud(info.prize)} • Total: {info.net>=0?'+':''}{aud(info.net)}
                        </div>

                        <strong>Settlement transfers</strong>
                        <table className="table">
                          <thead><tr><th>They owe</th><th className="center">Amount</th><th>Owed by</th><th className="center">Amount</th></tr></thead>
                          <tbody>
                            <tr>
                              <td>
                                {(info.owes||[]).length===0 ? <span className="meta">—</span> :
                                  info.owes.map((x,i)=>(<div key={i}>{x.to}</div>))}
                              </td>
                              <td className="center mono">
                                {(info.owes||[]).length===0 ? <span className="meta">—</span> :
                                  info.owes.map((x,i)=>(<div key={i}>{aud(x.amount)}</div>))}
                              </td>
                              <td>
                                {(info.owedBy||[]).length===0 ? <span className="meta">—</span> :
                                  info.owedBy.map((x,i)=>(<div key={i}>{x.from}</div>))}
                              </td>
                              <td className="center mono">
                                {(info.owedBy||[]).length===0 ? <span className="meta">—</span> :
                                  info.owedBy.map((x,i)=>(<div key={i}>{aud(x.amount)}</div>))}
                              </td>
                            </tr>
                          </tbody>
                        </table>

                        <div style={{height:10}} />

                        <strong>Prize money (A$20 per player by game)</strong>
                        <table className="table">
                          <thead><tr><th>They owe (prize)</th><th className="center">Amount</th><th>Owed by (prize)</th><th className="center">Amount</th></tr></thead>
                          <tbody>
                            <tr>
                              <td>
                                {(info.owesPrize||[]).length===0 ? <span className="meta">—</span> :
                                  info.owesPrize.map((x,i)=>(<div key={i}>{x.to}</div>))}
                              </td>
                              <td className="center mono">
                                {(info.owesPrize||[]).length===0 ? <span className="meta">—</span> :
                                  info.owesPrize.map((x,i)=>(<div key={i}>{aud(x.amount)}</div>))}
                              </td>
                              <td>
                                {(info.owedByPrize||[]).length===0 ? <span className="meta">—</span> :
                                  info.owedByPrize.map((x,i)=>(<div key={i}>{x.from}</div>))}
                              </td>
                              <td className="center mono">
                                {(info.owedByPrize||[]).length===0 ? <span className="meta">—</span> :
                                  info.owedByPrize.map((x,i)=>(<div key={i}>{aud(x.amount)}</div>))}
                              </td>
                            </tr>
                          </tbody>
                        </table>

                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const ProfilesSection = (
    <div className="surface">
      <div className="header"><h3 style={{margin:0}}>Players & Profiles</h3></div>
      <div className="meta">Set PayIDs (and optional avatars). This updates the whole season for everyone.</div>
      <table className="table">
        <thead><tr><th>Name</th><th>PayID</th><th className="center">Avatar</th><th className="center">Save</th></tr></thead>
        <tbody>
          {knownNames.length===0 ? (
            <tr><td colSpan="4" className="center meta">No known names yet. Add players above first.</td></tr>
          ) : knownNames.map(n=>{
            const payid = profileDrafts[n]?.payid ?? profiles[n]?.payid ?? "";
            const handlePayid = (v)=> setProfileDrafts(d=>({...d,[n]:{...(d[n]||{}), payid:v}}));
            const handleAvatar = (file)=>{
              if(!file){ setProfileDrafts(d=>({...d,[n]:{...(d[n]||{}), avatar:null}})); return; }
              const reader = new FileReader();
              reader.onload = ()=> setProfileDrafts(d=>({...d,[n]:{...(d[n]||{}), avatar:String(reader.result)}}));
              reader.readAsDataURL(file);
            };
            const saveRow = ()=> apiProfileUpsert({name:n, payid, avatar: (profileDrafts[n]?.avatar ?? null)});
            return (
              <tr key={n}>
                <td>{n}</td>
                <td>
                  <input type="text" value={payid} onChange={e=>handlePayid(e.target.value)} placeholder="email/phone PayID" />
                </td>
                <td className="center">
                  <input type="file" accept="image/*" onChange={(e)=>handleAvatar(e.target.files?.[0]||null)} />
                </td>
                <td className="center">
                  <button className="btn secondary" onClick={saveRow}>Save</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {/* Topbar with Sync status + Refresh */}
      <div className="pp-topbar">
        <button className="pp-burger" onClick={()=>setSidebarOpen(true)}>☰</button>
        <div className="brand">
          <h1>PocketPoker</h1>
          <span className="badge">Cloud</span>
          <span className="meta" style={{marginLeft:8}}>
            <strong>Sync:</strong> {syncStatus} • v{cloudVersion}
            <button className="btn ghost small" style={{marginLeft:8}} onClick={refreshSeason}>Refresh</button>
          </span>
        </div>
      </div>

      {/* Drawer */}
      <div className={"pp-drawer " + (sidebarOpen?'open':'')}>
        <div className="title-badge" style={{justifyContent:'space-between', width:'100%'}}>
          <strong>Menu</strong>
          <button className="pp-burger" onClick={()=>setSidebarOpen(false)}>✕</button>
        </div>
        <div className="nav-list">
          {["game","history","ledgers","stats","profiles"].map(k=>(
            <div key={k} className={"nav-item " + (tab===k?'active':'')} onClick={()=>{setTab(k); setSidebarOpen(false);}}>
              <span style={{textTransform:'capitalize'}}>{k}</span>
              <span>›</span>
            </div>
          ))}
        </div>
      </div>
      <div className={"pp-overlay " + (sidebarOpen?'show':'')} onClick={()=>setSidebarOpen(false)} />

      <div className="container">
        {tab==="game" && GameSection}
        {tab==="history" && HistorySection}
        {tab==="ledgers" && LedgersSection}
        {tab==="stats" && (
          <div className="surface">
            <div className="header" style={{marginBottom:8}}>
              <h3 style={{margin:0}}>Stats & Charts</h3>
              <div className="toolbar">
                <label className="inline">
                  Wins mode
                  <select value={winsMode} onChange={e=>setWinsMode(e.target.value)}>
                    <option value="fractional">Fractional ties (1 ÷ T)</option>
                    <option value="whole">Whole ties (1 each)</option>
                  </select>
                </label>
                <label className="inline">
                  Scope
                  <select value={winsScope} onChange={e=>setWinsScope(e.target.value)}>
                    <option value="all">All games</option>
                    <option value="last10">Last 10</option>
                    <option value="last20">Last 20</option>
                  </select>
                </label>
              </div>
            </div>

            {/* Top chips */}
            <div className="chips">
              <div className="chip-lg">
                🥇 Most wins:&nbsp;
                <strong>{stats.wins[0]?.name ?? '—'}</strong>&nbsp;
                <span className="mono">{(stats.wins[0]?.wins ?? 0).toFixed(2)}</span>
              </div>
              <div className="chip-lg">
                🔥 Longest streak:&nbsp;
                {(() => {
                  const entries = Object.entries(stats.streakBest || {}).sort((a,b)=> (b[1]-a[1]));
                  return <><strong>{entries[0]?.[0] || '—'}</strong>&nbsp;<span className="mono">{entries[0]?.[1] ?? 0}</span></>;
                })()}
              </div>
              <div className="chip-lg">
                💥 Best net night:&nbsp;
                <strong>{stats.bestNight.name ?? '—'}</strong>&nbsp;
                <span className="mono">{Number.isFinite(stats.bestNight.amount) ? aud(stats.bestNight.amount) : '—'}</span>
              </div>
            </div>

            {/* Wins Leaderboard */}
            <div className="card" style={{marginTop:12}}>
              <div className="card-head"><strong>Wins Leaderboard</strong><span className="meta"> (game-only winners, scoped)</span></div>
              {stats.wins.length===0 ? (
                <div className="meta">No games yet.</div>
              ) : (
                <div className="bars">
                  {(() => {
                    const max = Math.max(...stats.wins.map(x=>x.wins));
                    const bestName = stats.wins[0]?.name;
                    return stats.wins.map((x,i)=>{
                      const w = max>0 ? (x.wins/max)*100 : 0;
                      return (
                        <div key={x.name} className="bar-row">
                          <div className="bar-label">{x.name}</div>
                          <div className="bar-track">
                            <div className="bar-fill" style={{width:`${w}%`, background: x.name===bestName ? "linear-gradient(90deg,#f5d142,#f0b90b)" : "#4e79a7"}} />
                          </div>
                          <div className="bar-value mono" title={`${x.played} games`}>
                            {x.wins.toFixed(2)}<span className="meta"> • {x.rate.toFixed(0)}%</span>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
        )}
        {tab==="profiles" && ProfilesSection}

        <div className="tabbar">
          <button className={"btn " + (tab==='game'?'primary':'secondary')} onClick={()=>setTab('game')}>Game</button>
          <button className={"btn " + (tab==='history'?'primary':'secondary')} onClick={()=>setTab('history')}>History</button>
          <button className={"btn " + (tab==='ledgers'?'primary':'secondary')} onClick={()=>setTab('ledgers')}>Ledgers</button>
          <button className={"btn " + (tab==='stats'?'primary':'secondary')} onClick={()=>setTab('stats')}>Stats</button>
          <button className={"btn " + (tab==='profiles'?'primary':'secondary')} onClick={()=>setTab('profiles')}>Profiles</button>
        </div>

        <div className="footer meta">Tip: settlement ignores prize; it splits only game results.</div>
      </div>
    </>
  );
}