// App.jsx — v12 Cloud Sync + Host Lock + Audit + Validation + Soft Rate-limit handling
import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./components/PlayerRow.jsx";
import { aud, sum, round2, settle, toCSV } from "./calc.js";

const DEFAULT_BUYIN=50, DEFAULT_PRIZE=20, uid=()=>Math.random().toString(36).slice(2,9);
const API_BASE = ""; // same origin
const SEASON_ID = (import.meta?.env?.VITE_SEASON_ID) || "default";
const DEVICE_ID_KEY = "pp_device_id";
const DEVICE_NAME_KEY = "pp_device_name";

function ensureDeviceId(){ let id=localStorage.getItem(DEVICE_ID_KEY); if(!id){ id=crypto.randomUUID?.()||uid(); localStorage.setItem(DEVICE_ID_KEY,id);} return id; }
function getDeviceName(){ return localStorage.getItem(DEVICE_NAME_KEY)||""; }
function setDeviceName(n){ localStorage.setItem(DEVICE_NAME_KEY, n||""); }

// Equal-split capped per-winner
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

const aud2 = v => `A$${Number(v).toFixed(2)}`;

export default function App(){
  const [players,setPlayers]=useState([{id:uid(),name:"",buyIns:0,cashOut:0},{id:uid(),name:"",buyIns:0,cashOut:0}]);
  const [buyInAmount,setBuyInAmount]=useState(DEFAULT_BUYIN);
  const [prizeFromPot,setPrizeFromPot]=useState(true);
  const [prizeAmount,setPrizeAmount]=useState(DEFAULT_PRIZE);
  const [settlementMode, setSettlementMode] = useState("equalSplit");
  const [winsMode, setWinsMode] = useState("fractional");
  const [history,setHistory]=useState([]);
  const [started,setStarted]=useState(false);
  const [overrideMismatch,setOverrideMismatch]=useState(false);
  const [tab,setTab]=useState("game");

  // Cloud sync state
  const [cloudVersion, setCloudVersion] = useState(0);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | upToDate | error
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lock, setLock] = useState(null);
  const deviceId = ensureDeviceId();
  const [deviceName, setDevName] = useState(getDeviceName());

  useEffect(()=>{ setDeviceName(deviceName); }, [deviceName]);

  // Compute totals and game object
  const totals=useMemo(()=>{
    const base=players.map(p=>({...p, buyInTotal:round2(p.buyIns*buyInAmount), baseCash:p.cashOut }));
    const withNet=base.map(p=>({...p, net: round2(p.baseCash - p.buyIns*buyInAmount)}));
    let adjusted = withNet.map(p=>({...p, prize:0, cashOutAdj:round2(p.baseCash), netAdj: round2(p.baseCash - p.buyIns*buyInAmount)}));

    if (prizeFromPot && players.length>=2) {
      const N = adjusted.length;
      const topNet = Math.max(...withNet.map(p=>p.net));
      const winners = withNet.filter(p=> Math.abs(p.net - topNet) < 0.0001);
      const T = winners.length;
      const pool = round2(prizeAmount * N);
      const perWinner = T>0 ? round2(pool / T) : 0;

      adjusted = adjusted.map(p=>{
        const cash = round2(p.baseCash - prizeAmount);
        return {...p, prize: round2(-prizeAmount), cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount)};
      });

      let distributed = 0, idx = 0;
      adjusted = adjusted.map(p=>{
        if (Math.abs((p.baseCash - p.buyIns*buyInAmount) - topNet) < 0.0001) {
          const isLast = idx === T-1;
          const give = isLast ? round2(pool - distributed) : perWinner;
          distributed = round2(distributed + give);
          const cash = round2(p.cashOutAdj + give);
          idx++;
          return {...p, prize: round2(p.prize + give), cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount)};
        }
        return p;
      });
    }

    const buyInSum = round2(sum(adjusted.map(p=> p.buyInTotal)));
    const cashAdjSum = round2(sum(adjusted.map(p=> p.cashOutAdj)));
    const diff = round2(cashAdjSum - buyInSum);

    const basis = adjusted.map(p=>({ name: p.name || "Player", net: round2(p.netAdj - p.prize) }));
    const txns = settlementMode === "equalSplit"
      ? settleEqualSplitCapped(basis)
      : settle(basis);

    return { adjusted, buyInSum, cashAdjSum, diff, txns };
  }, [players,buyInAmount,prizeFromPot,prizeAmount,settlementMode]);

  function buildGame(){
    return {
      id: uid(),
      stamp: new Date().toISOString(),
      settings: { buyInAmount, prize: prizeFromPot ? { mode:'pot_all', amount:prizeAmount } : { mode:'none', amount:0 }, settlement: { mode:settlementMode } },
      players: totals.adjusted.map(p=>({ name:p.name||"Player", buyIns:p.buyIns, buyInTotal:p.buyInTotal, cashOut:p.cashOutAdj, prize:p.prize, net:p.netAdj })),
      totals: {{ buyIns: totals.buyInSum, cashOuts: totals.cashAdjSum, diff: totals.diff }},
      txns: totals.txns,
      savedBy: {{ deviceId, deviceName: deviceName||"Unknown" }},
      overrideMismatch
    };
  }

  // ---- API helpers
  async function apiGetSeason(){
    const res = await fetch(`${API_BASE}/api/season/get?id=${encodeURIComponent(SEASON_ID)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiAppendGame(game){
    const headers = { "Content-Type":"application/json", "If-Match": String(cloudVersion), "X-Client-Id": deviceId, "X-Client-Name": deviceName||"Unknown" };
    const res = await fetch(`${API_BASE}/api/season/append-game`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, game }) });
    if (res.status === 409) { const latest = await apiGetSeason(); setHistory(latest.games||[]); setCloudVersion(latest.version||0); setLock(latest.lock||null); return apiAppendGame(game); }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiDeleteGame(id){
    const headers = { "Content-Type":"application/json", "If-Match": String(cloudVersion), "X-Client-Id": deviceId, "X-Client-Name": deviceName||"Unknown" };
    const res = await fetch(`${API_BASE}/api/season/delete-game`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, gameId: id }) });
    if (res.status === 409) { const latest = await apiGetSeason(); setHistory(latest.games||[]); setCloudVersion(latest.version||0); setLock(latest.lock||null); return apiDeleteGame(id); }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiLock(action, byName){
    const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": byName||deviceName||"Unknown" };
    const res = await fetch(`${API_BASE}/api/season/lock`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, action, byName, deviceId }) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ---- load cloud on mount + polling
  useEffect(()=>{
    (async ()=>{
      try{ setSyncStatus("syncing"); const doc = await apiGetSeason(); setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); setSyncStatus("upToDate"); setLastSyncAt(new Date()); }
      catch(e){ console.error(e); setSyncStatus("error"); }
    })();
  }, []);
  useEffect(()=>{
    let dead=false;
    const tick=async()=>{
      try{
        const doc=await apiGetSeason();
        if (doc.version !== cloudVersion) {{ setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); }}
        setLastSyncAt(new Date());
        if(!dead) setTimeout(tick, document.hidden ? 30000 : 10000);
      }catch(e){ if(!dead) setTimeout(tick, 30000); }
    };
    const t=setTimeout(tick, 10000);
    return ()=>{ dead=true; clearTimeout(t); };
  }, [cloudVersion]);

  // ---- Client-side validation before save
  function validateBeforeSave(){
    const errs = [];
    if (players.length < 2) errs.push("At least two players needed.");
    if (players.every(p=> (p.buyIns||0)===0 && (p.cashOut||0)===0)) errs.push("No inputs entered.");
    if (Math.abs(totals.diff) > 0.01 && !overrideMismatch) errs.push("Totals not balanced. Tick override to force.");
    return errs;
  }

  // ---- Actions
  function updatePlayer(u){ setPlayers(ps=> u?._remove ? ps.filter(p=>p.id!==u.id) : ps.map(p=>p.id===u.id?u:p)); }
  const addPlayer=()=>setPlayers(ps=>[...ps,{id:uid(),name:"",buyIns:0,cashOut:0}]);
  const startGame=()=>{ setPlayers(ps=>ps.map(p=>({ ...p, buyIns:0, cashOut:0 }))); setStarted(true); setOverrideMismatch(false); };
  const resetGame=()=>{ setPlayers([{id:uid(),name:"",buyIns:0,cashOut:0},{id:uid(),name:"",buyIns:0,cashOut:0}]); setStarted(false); setOverrideMismatch(false); };

  async function saveGameToHistory(){
    const errs = validateBeforeSave();
    if (errs.length){ alert("Cannot save:\n- " + errs.join("\n- ")); return; }
    const g = buildGame();
    try{
      const doc = await apiAppendGame(g); setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null);
    }catch(e){
      console.error(e);
      const msg = String(e.message||"").toLowerCase();
      if (msg.includes("429") || msg.includes("rate limit")){
        alert("Too many saves. Please wait a moment and try again.");
        return;
      }
      if (msg.includes("locked")){
        alert("This season is locked by another device. Ask the host to unlock.");
        return;
      }
      // fallback local
      setHistory(h=>[g,...h]);
    }
  }

  async function deleteGame(id){
    if (!window.confirm("Delete this game from history?")) return;
    try{
      const doc = await apiDeleteGame(id); setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null);
    }catch(e){
      console.error(e);
      alert("Delete failed. Is the season locked or rate-limited?");
    }
  }

  // ---- UI Lock helpers
  const lockedByOther = !!(lock && lock.deviceId && lock.deviceId !== deviceId && (new Date(lock.expiresAt) > new Date()));
  const lockExpiresText = lock?.expiresAt ? new Date(lock.expiresAt).toLocaleString() : null;

  // ---- Known names from history/players for host pick
  const knownNames = useMemo(()=>{
    const set = new Set();
    players.forEach(p=> p.name && set.add(p.name));
    history.forEach(g=> g.players.forEach(p=> p.name && set.add(p.name)));
    return Array.from(set).sort();
  }, [players, history]);

  // ---- Minimal render (only sections needed for features requested)
  return (
    <div className="container" style={{padding:12}}>
      <div className="header" style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <h2 style={{margin:0}}>PocketPoker</h2>
        <div className="meta">
          Sync: <strong>{syncStatus}</strong>{' '}
          <span className="mono">v{cloudVersion}</span>{' '}
          {lastSyncAt && <span className="meta">• {lastSyncAt.toLocaleTimeString()}</span>}
          <button className="btn small" style={{marginLeft:8}} onClick={async()=>{ setSyncStatus("syncing"); try{ const doc=await apiGetSeason(); setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); setSyncStatus("upToDate"); setLastSyncAt(new Date()); }catch(e){ setSyncStatus("error"); } }}>Refresh</button>
        </div>
      </div>

      {/* Host lock controls */}
      <div className="surface" style={{marginTop:8, padding:10}}>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          <label>Device name:&nbsp;
            <input value={deviceName} onChange={e=>setDevName(e.target.value)} placeholder="Your name (for audit)" />
          </label>
          <label>Host (choose):&nbsp;
            <select value={deviceName} onChange={e=>setDevName(e.target.value)}>
              <option value="">— pick —</option>
              {knownNames.map(n=><option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {lock ? (
            <>
              <span className="pill">🔒 Locked by <strong>{lock.byName||"Host"}</strong>{lockExpiresText?` • until ${lockExpiresText}`:''}</span>
              <button className="btn" disabled={lock.deviceId!==deviceId} onClick={async()=>{ try{ const doc=await apiLock("unlock", deviceName); setLock(doc.lock||null); setCloudVersion(doc.version||cloudVersion); }catch(e){ alert("Unlock failed: " + (e.message||"")); } }}>Unlock</button>
            </>
          ) : (
            <button className="btn primary" onClick={async()=>{ try{ const doc=await apiLock("lock", deviceName||"Host"); setLock(doc.lock||null); setCloudVersion(doc.version||cloudVersion); }catch(e){ alert("Lock failed: " + (e.message||"")); } }}>Activate Host Lock</button>
          )}
        </div>
        <div className="meta">If the host forgets to unlock, it will auto-unlock next day (Brisbane time).</div>
      </div>

      {/* Game inputs (disabled overlay if locked by others) */}
      <div className="surface" style={{marginTop:8, position:'relative'}}>
        {lockedByOther && <div style={{position:'absolute', inset:0, background:'rgba(0,0,0,0.25)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:5, pointerEvents:'auto'}}>
          <div className="pill">🔒 Read-only: locked by {lock?.byName||"Host"}</div>
        </div>}
        <div className="toolbar" style={{gap:8, flexWrap:'wrap'}}>
          <label>Buy-in A$ <input type="number" min="1" step="1" value={buyInAmount} onChange={e=>setBuyInAmount(Math.max(1,parseFloat(e.target.value||50)))} disabled={lockedByOther} /></label>
          <label><input type="checkbox" checked={prizeFromPot} onChange={e=>setPrizeFromPot(e.target.checked)} disabled={lockedByOther} /> Prize from pot</label>
          <label>A$ <input type="number" min="0" step="1" value={prizeAmount} onChange={e=>setPrizeAmount(Math.max(0,parseFloat(e.target.value||0)))} disabled={lockedByOther} /></label>
          <label>Settlement
            <select value={settlementMode} onChange={e=>setSettlementMode(e.target.value)} disabled={lockedByOther}>
              <option value="equalSplit">Equal-split per loser</option>
              <option value="proportional">Proportional</option>
            </select>
          </label>
        </div>

        <table className="table">
          <thead><tr><th>Player</th><th className="center">Buy-ins</th><th className="center">Cash-out</th><th className="center">Net</th><th></th></tr></thead>
          <tbody>
            {players.map(p=>(
              <tr key={p.id}>
                <td><input value={p.name} onChange={e=>!lockedByOther && setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,name:e.target.value}:x))} placeholder="Name" disabled={lockedByOther} /></td>
                <td className="center"><input type="number" min="0" step="1" value={p.buyIns} onChange={e=>!lockedByOther && setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,buyIns:Math.max(0,parseInt(e.target.value||0))}:x))} disabled={lockedByOther} /></td>
                <td className="center"><input type="number" step="1" value={p.cashOut} onChange={e=>!lockedByOther && setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,cashOut:parseFloat(e.target.value||0)}:x))} disabled={lockedByOther} /></td>
                <td className="center mono">{(round2((p.cashOut - p.buyIns*buyInAmount))).toFixed(2)}</td>
                <td className="center"><button className="btn small" onClick={()=>!lockedByOther && setPlayers(ps=>ps.filter(x=>x.id!==p.id))} disabled={lockedByOther}>Remove</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th>Total</th><th className="center mono">{aud2(totals.buyInSum)}</th><th className="center mono">{aud2(totals.cashAdjSum)}</th><th className="center mono">{totals.diff.toFixed(2)}</th><th/></tr>
          </tfoot>
        </table>

        <div className="toolbar" style={{justifyContent:'space-between'}}>
          <div className="meta">{Math.abs(totals.diff) > 0.01 ? "⚠️ Off by " + aud2(totals.diff) : "✅ Balanced"}</div>
          <div>
            <label><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} disabled={lockedByOther}/> Override mismatch</label>
            <button className="btn" onClick={addPlayer} disabled={lockedByOther}>Add Player</button>
            <button className="btn success" onClick={saveGameToHistory} disabled={lockedByOther}>End Game & Save</button>
          </div>
        </div>
      </div>

      {/* History with audit peek */}
      <div className="surface" style={{marginTop:8}}>
        <div className="header"><h3 style={{margin:0}}>History</h3></div>
        <table className="table">
          <thead><tr><th>When</th><th>Players</th><th className="center">Totals</th><th className="center">By</th><th className="center">Actions</th></tr></thead>
          <tbody>
            {history.length===0 ? <tr><td colSpan="5" className="center meta">No games yet.</td></tr> :
              history.map(g=>{
                const list = (g.players||[]).map(p=>p.name).join(", ");
                return (<tr key={g.id}>
                  <td className="mono">{new Date(g.stamp).toLocaleString()}</td>
                  <td>{list}</td>
                  <td className="center mono">{aud2(g.totals?.buyIns||0)} → {aud2(g.totals?.cashOuts||0)} (Δ {(g.totals?.diff||0).toFixed(2)})</td>
                  <td className="center">{g.savedBy?.deviceName||"—"}</td>
                  <td className="center"><button className="btn danger" onClick={()=>deleteGame(g.id)} disabled={lockedByOther}>Delete</button></td>
                </tr>);
              })
            }
          </tbody>
        </table>
      </div>

      {/* Audit trail (last 10) */}
      {lock && <div className="surface" style={{marginTop:8}}>
        <div className="header"><h3 style={{margin:0}}>Audit (recent)</h3></div>
        <div className="meta">Shows who locked/unlocked and who saved games.</div>
        <ul>
          {(history._audit || []).slice(0,10).map((a,i)=>(<li key={i} className="mono">{a.ts} — {a.action} — {a.byName||a.deviceId}</li>))}
        </ul>
      </div>}
    </div>
  );
}
