// App.jsx — v13: Cloud sync + Host lock + Audit + Validation + Payments + Profiles
import React, { useEffect, useMemo, useState } from "react";

// ===== Helpers (local) =====
const uid = () => Math.random().toString(36).slice(2, 9);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const aud = (v) => `A$${Number(v || 0).toFixed(2)}`;

// Equal-split settlement with per-winner cap
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
          txns.push({ from: L.name, to: w.name, amount: round2(give), paid:false, paidAt:null });
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

// ===== Cloud constants / device identity =====
const API_BASE = ""; // same-origin
const SEASON_ID = (import.meta?.env?.VITE_SEASON_ID) || "default";
const DEVICE_ID_KEY = "pp_device_id";
const DEVICE_NAME_KEY = "pp_device_name";
function ensureDeviceId(){ let id = localStorage.getItem(DEVICE_ID_KEY); if (!id) { id = (crypto.randomUUID?.() || uid()); localStorage.setItem(DEVICE_ID_KEY, id);} return id; }
function getDeviceName(){ return localStorage.getItem(DEVICE_NAME_KEY) || ""; }
function setDeviceNameLS(n){ localStorage.setItem(DEVICE_NAME_KEY, n || ""); }

export default function App(){
  // ===== Game state =====
  const [players,setPlayers]=useState([
    {id:uid(),name:"",buyIns:0,cashOut:0},
    {id:uid(),name:"",buyIns:0,cashOut:0}
  ]);
  const [buyInAmount,setBuyInAmount]=useState(50);
  const [prizeFromPot,setPrizeFromPot]=useState(true);
  const [prizeAmount,setPrizeAmount]=useState(20);
  const [settlementMode,setSettlementMode]=useState("equalSplit");
  const [overrideMismatch,setOverrideMismatch]=useState(false);

  // ===== Cloud sync state =====
  const [history,setHistory]=useState([]);
  const [cloudVersion,setCloudVersion]=useState(0);
  const [syncStatus,setSyncStatus]=useState("idle");
  const [lastSyncAt,setLastSyncAt]=useState(null);
  const [lock,setLock]=useState(null);
  const [profiles,setProfiles]=useState({}); // { name: { payId, avatarDataUrl } }

  const deviceId = ensureDeviceId();
  const [deviceName,setDeviceName] = useState(getDeviceName());
  useEffect(()=>{ setDeviceNameLS(deviceName); }, [deviceName]);

  // ===== Computations =====
  const totals = useMemo(()=>{
    const base=players.map(p=>({...p, buyInTotal:round2(p.buyIns*buyInAmount), baseCash:round2(p.cashOut)}));
    const withNet=base.map(p=>({...p, net: round2(p.baseCash - p.buyIns*buyInAmount)}));
    let adjusted = withNet.map(p=>({...p, prize:0, cashOutAdj:round2(p.baseCash), netAdj: round2(p.baseCash - p.buyIns*buyInAmount)}));

    // Prize from pot: subtract 20 from everyone, winners split pool
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
    const txns = settlementMode === "equalSplit" ? settleEqualSplitCapped(basis) : [];

    return { adjusted, buyInSum, cashAdjSum, diff, txns };
  }, [players,buyInAmount,prizeFromPot,prizeAmount,settlementMode]);

  function buildGame(){
    return {
      id: uid(),
      stamp: new Date().toISOString(),
      settings: { buyInAmount, prize: prizeFromPot ? { mode:'pot_all', amount:prizeAmount } : { mode:'none', amount:0 }, settlement: { mode:settlementMode } },
      players: totals.adjusted.map(p=>({ name:p.name||"Player", buyIns:p.buyIns, buyInTotal:p.buyInTotal, cashOut:p.cashOutAdj, prize:p.prize, net:p.netAdj })),
      totals: { buyIns: totals.buyInSum, cashOuts: totals.cashAdjSum, diff: totals.diff },
      txns: totals.txns, // each has {from,to,amount,paid:false}
      savedBy: { deviceId, deviceName: deviceName||"Unknown" },
      overrideMismatch
    };
  }

  // ===== API helpers =====
  async function apiGetSeason(){
    const res = await fetch(`${API_BASE}/api/season/get?id=${encodeURIComponent(SEASON_ID)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiAppendGame(game){
    const headers = { "Content-Type":"application/json", "If-Match": String(cloudVersion), "X-Client-Id": deviceId, "X-Client-Name": deviceName||"Unknown" };
    let res = await fetch(`${API_BASE}/api/season/append-game`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, game }) });
    if (res.status === 409) {
      const latest = await apiGetSeason();
      setHistory(latest.games||[]); setCloudVersion(latest.version||0); setLock(latest.lock||null); setProfiles(latest.profiles||{});
      res = await fetch(`${API_BASE}/api/season/append-game`, { method:"POST", headers:{...headers,"If-Match":String(latest.version||0)}, body: JSON.stringify({ seasonId: SEASON_ID, game }) });
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiDeleteGame(id){
    const headers = { "Content-Type":"application/json", "If-Match": String(cloudVersion), "X-Client-Id": deviceId, "X-Client-Name": deviceName||"Unknown" };
    let res = await fetch(`${API_BASE}/api/season/delete-game`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, gameId: id }) });
    if (res.status === 409) {
      const latest = await apiGetSeason();
      setHistory(latest.games||[]); setCloudVersion(latest.version||0); setLock(latest.lock||null); setProfiles(latest.profiles||{});
      res = await fetch(`${API_BASE}/api/season/delete-game`, { method:"POST", headers:{...headers,"If-Match":String(latest.version||0)}, body: JSON.stringify({ seasonId: SEASON_ID, gameId: id }) });
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiLock(action, byName){
    const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": byName||deviceName||"Unknown" };
    const res = await fetch(`${API_BASE}/api/season/lock`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, action, byName, deviceId }) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiMarkPayment(gameId, idx, paid){
    const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": deviceName||"Unknown" };
    const res = await fetch(`${API_BASE}/api/season/mark-payment`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, gameId, idx, paid }) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  async function apiProfileUpsert(name, fields){
    const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": deviceName||"Unknown" };
    const res = await fetch(`${API_BASE}/api/season/profile-upsert`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, name, ...fields }) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ===== Load + Poll =====
  useEffect(()=>{ (async ()=>{
    try{ setSyncStatus("syncing");
      const doc = await apiGetSeason();
      setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); setProfiles(doc.profiles||{});
      setSyncStatus("upToDate"); setLastSyncAt(new Date());
    }catch(e){ console.error(e); setSyncStatus("error"); }
  })(); }, []);
  useEffect(()=>{ let dead=false;
    const tick=async()=>{ try{
      const doc=await apiGetSeason();
      if ((doc.version||0)!==cloudVersion){ setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); setProfiles(doc.profiles||{}); }
      setLastSyncAt(new Date());
      if(!dead) setTimeout(tick, document.hidden?30000:10000);
    }catch(e){ if(!dead) setTimeout(tick,30000); } };
    const t=setTimeout(tick,10000);
    return ()=>{ dead=true; clearTimeout(t); };
  }, [cloudVersion]);

  // ===== Validation =====
  function validateBeforeSave(t){ 
    const errs=[]; if (players.length<2) errs.push("At least two players.");
    const any = players.some(p=> (p.buyIns||0)>0 || (p.cashOut||0)>0);
    if (!any) errs.push("No inputs entered.");
    if (Math.abs(t?.diff||0) > 0.01 && !overrideMismatch) errs.push("Totals not balanced. Tick override to force.");
    return errs;
  }

  // ===== Actions =====
  const lockedByOther = !!(lock && lock.deviceId && lock.deviceId !== deviceId && (new Date(lock.expiresAt) > new Date()));

  async function saveGame(){
    const g = buildGame();
    const errs = validateBeforeSave(g.totals);
    if (errs.length){ alert("Cannot save:\n- " + errs.join("\n- ")); return; }
    try{
      const doc = await apiAppendGame(g);
      setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null);
    }catch(e){
      const msg = String(e.message||"").toLowerCase();
      if (msg.includes("429")) return alert("Too many saves. Please wait.");
      if (msg.includes("locked")) return alert("Locked by host. Ask to unlock.");
      alert("Save failed.");
    }
  }
  async function removeGame(id){
    if (!confirm("Delete this game?")) return;
    try{
      const doc = await apiDeleteGame(id);
      setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null);
    }catch(e){ alert("Delete failed."); }
  }
  async function togglePaid(g, idx){
    try{
      const doc = await apiMarkPayment(g.id, idx, !g.txns[idx].paid);
      setHistory(doc.games||[]); setCloudVersion(doc.version||0);
    }catch(e){ alert("Payment toggle failed."); }
  }

  // ===== Profiles helpers =====
  const allNames = useMemo(()=>{
    const s = new Set();
    players.forEach(p=> p.name && s.add(p.name));
    history.forEach(g=> (g.players||[]).forEach(p=> p.name && s.add(p.name)));
    return Array.from(s).sort();
  }, [players, history]);
  function avatarFor(name){ return profiles?.[name]?.avatarDataUrl || ""; }
  function payIdFor(name){ return profiles?.[name]?.payId || ""; }
  async function handleAvatarChange(name, file){
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try{
        const dataUrl = String(reader.result||"");
        const out = await apiProfileUpsert(name, { avatarDataUrl: dataUrl });
        setProfiles(out.profiles||{}); setCloudVersion(out.version||cloudVersion);
      }catch(e){ alert("Avatar upload failed (file too big?)"); }
    };
    reader.readAsDataURL(file);
  }
  async function handlePayIdSave(name, payId){
    try{
      const out = await apiProfileUpsert(name, { payId });
      setProfiles(out.profiles||{}); setCloudVersion(out.version||cloudVersion);
    }catch(e){ alert("Saving PayID failed."); }
  }

  // ===== UI =====
  return (
    <div style={{padding:12, maxWidth:900, margin:"0 auto"}}>
      <header style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <h2 style={{margin:0}}>PocketPoker</h2>
        <div>
          Sync: <strong>{syncStatus}</strong> <span style={{fontFamily:"monospace"}}>v{cloudVersion}</span> {lastSyncAt && <>• {lastSyncAt.toLocaleTimeString()}</>}
          <button style={{marginLeft:8}} onClick={async()=>{ try{ setSyncStatus("syncing"); const doc=await apiGetSeason(); setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); setProfiles(doc.profiles||{}); setSyncStatus("upToDate"); setLastSyncAt(new Date()); }catch(e){ setSyncStatus("error"); }}}>Refresh</button>
        </div>
      </header>

      {/* Host lock controls */}
      <section style={{marginTop:8, padding:10, border:"1px solid #eee", borderRadius:8}}>
        <div style={{display:"flex", gap:8, alignItems:"center", flexWrap:"wrap"}}>
          <label>Device name:&nbsp;
            <input value={deviceName} onChange={e=>setDeviceName(e.target.value)} placeholder="Your name (for audit)" />
          </label>
          {lock ? (
            <>
              <span style={{padding:"4px 8px", background:"#fee", borderRadius:999}}>🔒 Locked by <strong>{lock.byName||"Host"}</strong>{lock.expiresAt ? ` • until ${new Date(lock.expiresAt).toLocaleString()}` : ""}</span>
              <button disabled={lock.deviceId!==deviceId} onClick={async()=>{ try{ const doc = await apiLock("unlock", deviceName); setLock(doc.lock||null); setCloudVersion(doc.version||cloudVersion); }catch(e){ alert("Unlock failed: " + (e.message||"")); } }}>Unlock</button>
            </>
          ) : (
            <button onClick={async()=>{ try{ const doc=await apiLock("lock", deviceName||"Host"); setLock(doc.lock||null); setCloudVersion(doc.version||cloudVersion); }catch(e){ alert("Lock failed: " + (e.message||"")); } }}>Activate Host Lock</button>
          )}
        </div>
        <div style={{fontSize:12,color:"#666"}}>If the host forgets to unlock, it auto-unlocks next day (Brisbane time).</div>
      </section>

      {/* Game inputs */}
      <section style={{marginTop:8, padding:10, border:"1px solid #eee", borderRadius:8, position:"relative"}}>
        {lock && lock.deviceId !== deviceId && new Date(lock.expiresAt) > new Date() && (
          <div style={{position:"absolute", inset:0, background:"rgba(0,0,0,0.25)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:5}}>
            <div style={{background:"#fff", padding:"6px 10px", borderRadius:999}}>🔒 Read-only: locked by {lock?.byName||"Host"}</div>
          </div>
        )}
        <div style={{display:"flex", gap:8, flexWrap:"wrap", alignItems:"center"}}>
          <label>Buy-in A$ <input type="number" min="1" step="1" value={buyInAmount} onChange={e=>setBuyInAmount(Math.max(1,parseFloat(e.target.value||50)))}/></label>
          <label><input type="checkbox" checked={prizeFromPot} onChange={e=>setPrizeFromPot(e.target.checked)}/> Prize from pot</label>
          <label>A$ <input type="number" min="0" step="1" value={prizeAmount} onChange={e=>setPrizeAmount(Math.max(0,parseFloat(e.target.value||0)))}/></label>
          <label>Settlement
            <select value={settlementMode} onChange={e=>setSettlementMode(e.target.value)}>
              <option value="equalSplit">Equal-split per loser</option>
            </select>
          </label>
        </div>

        <table style={{width:"100%", borderCollapse:"collapse", marginTop:8}}>
          <thead><tr><th align="left">Player</th><th>Buy-ins</th><th>Cash-out</th><th>Net</th><th></th></tr></thead>
          <tbody>
            {players.map(p=>(
              <tr key={p.id}>
                <td><input value={p.name} onChange={e=>setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,name:e.target.value}:x))} placeholder="Name" /></td>
                <td align="center"><input type="number" min="0" step="1" value={p.buyIns} onChange={e=>setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,buyIns:Math.max(0,parseInt(e.target.value||0))}:x))}/></td>
                <td align="center"><input type="number" step="1" value={p.cashOut} onChange={e=>setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,cashOut:parseFloat(e.target.value||0)}:x))}/></td>
                <td align="center" style={{fontFamily:"monospace"}}>{round2(p.cashOut - p.buyIns*buyInAmount).toFixed(2)}</td>
                <td align="center"><button onClick={()=>setPlayers(ps=>ps.filter(x=>x.id!==p.id))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th>Total</th><th align="center" style={{fontFamily:"monospace"}}>{aud(totals.buyInSum)}</th><th align="center" style={{fontFamily:"monospace"}}>{aud(totals.cashAdjSum)}</th><th align="center" style={{fontFamily:"monospace"}}>{totals.diff.toFixed(2)}</th><th/></tr>
          </tfoot>
        </table>

        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8}}>
          <div style={{fontSize:12, color: Math.abs(totals.diff)>0.01 ? "#b00" : "#0a0"}}>
            {Math.abs(totals.diff)>0.01 ? ("⚠️ Off by " + aud(totals.diff)) : "✅ Balanced"}
          </div>
          <div>
            <label style={{marginRight:8}}><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)}/> Override mismatch</label>
            <button onClick={()=>setPlayers(ps=>[...ps,{id:uid(),name:"",buyIns:0,cashOut:0}])}>Add Player</button>
            <button onClick={saveGame} style={{marginLeft:6}}>End Game & Save</button>
          </div>
        </div>
      </section>

      {/* History with payments + winner avatars */}
      <section style={{marginTop:12}}>
        <h3 style={{margin:"8px 0"}}>History</h3>
        {history.length===0 ? <div style={{color:"#666"}}>No games yet.</div> : (
          <div style={{display:"grid", gap:8}}>
            {history.map(g=>{
              const winNeed = {}; const winPaid = {};
              (g.players||[]).forEach(p=>{ if ((p.net||0) > 0) { winNeed[p.name] = round2((winNeed[p.name]||0) + p.net); } });
              (g.txns||[]).forEach((t)=>{ winPaid[t.to] = round2((winPaid[t.to]||0) + (t.paid? t.amount:0)); });
              return (
                <div key={g.id} style={{border:"1px solid #eee", borderRadius:8, padding:10}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <div>
                      <div style={{fontFamily:"monospace"}}>{new Date(g.stamp).toLocaleString()}</div>
                      <div style={{fontSize:12, color:"#666"}}>{(g.players||[]).map(p=>p.name).join(", ")}</div>
                    </div>
                    <div><button onClick={()=>removeGame(g.id)}>Delete</button></div>
                  </div>

                  <div style={{display:"flex", gap:12, flexWrap:"wrap", marginTop:8}}>
                    {(g.players||[]).filter(p=> (p.net||0)>0).map(p=>{
                      const need = winNeed[p.name]||0, got = winPaid[p.name]||0;
                      const done = Math.abs(need-got) < 0.01;
                      const avatar = profiles?.[p.name]?.avatarDataUrl || "";
                      return (
                        <div key={p.name} style={{display:"flex", alignItems:"center", gap:8, padding:"6px 8px", border:"1px solid #eee", borderRadius:999, background: done ? "#eaffea" : "#fff"}}>
                          <div style={{width:28, height:28, borderRadius:"50%", overflow:"hidden", background:"#ddd"}}>
                            {avatar ? <img src={avatar} alt="" width={28} height={28}/> : null}
                          </div>
                          <div><strong>{p.name}</strong><div style={{fontSize:11, color:"#666"}}>{aud(got)} / {aud(need)}</div></div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{marginTop:8}}>
                    <table style={{width:"100%", borderCollapse:"collapse"}}>
                      <thead><tr><th align="left">From</th><th align="left">To</th><th align="right">Amount</th><th align="center">Paid?</th></tr></thead>
                      <tbody>
                        {(g.txns||[]).map((t,idx)=>(
                          <tr key={idx}>
                            <td>{t.from}{profiles?.[t.from]?.payId ? <> (PayID: {profiles[t.from].payId})</> : null}</td>
                            <td>{t.to}{profiles?.[t.to]?.payId ? <> (PayID: {profiles[t.to].payId})</> : null}</td>
                            <td align="right" style={{fontFamily:"monospace"}}>{aud(t.amount)}</td>
                            <td align="center"><input type="checkbox" checked={!!t.paid} onChange={()=>togglePaid(g, idx)}/></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Profiles */}
      <section style={{marginTop:12}}>
        <h3 style={{margin:"8px 0"}}>Profiles</h3>
        {Array.from(new Set([...players.map(p=>p.name).filter(Boolean), ...history.flatMap(g => (g.players||[]).map(p=>p.name)).filter(Boolean)])).length===0
          ? <div style={{color:"#666"}}>No names yet. Add players above and save a game.</div>
          : <div style={{display:"grid", gap:8}}>
              {Array.from(new Set([...players.map(p=>p.name).filter(Boolean), ...history.flatMap(g => (g.players||[]).map(p=>p.name)).filter(Boolean)])).sort().map(name=>{
                const prof = profiles?.[name] || {};
                return (
                  <div key={name} style={{display:"flex", alignItems:"center", gap:12, padding:10, border:"1px solid #eee", borderRadius:8}}>
                    <div style={{width:48, height:48, borderRadius:"50%", overflow:"hidden", background:"#ddd"}}>
                      {prof.avatarDataUrl ? <img src={prof.avatarDataUrl} alt="" width={48} height={48}/> : null}
                    </div>
                    <div style={{flex:1}}>
                      <div><strong>{name}</strong></div>
                      <div style={{display:"flex", gap:8, alignItems:"center", marginTop:4}}>
                        <input placeholder="PayID (email/phone)" defaultValue={prof.payId||""} onBlur={e=>apiProfileUpsert(name, { payId: e.target.value }).then(out=>{ setProfiles(out.profiles||{}); setCloudVersion(out.version||cloudVersion); }).catch(()=>alert("Saving PayID failed."))} style={{minWidth:240}}/>
                        <label style={{fontSize:12}}>Avatar: <input type="file" accept="image/*" onChange={e=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=async()=>{ try{ const out=await apiProfileUpsert(name, { avatarDataUrl:String(r.result||"") }); setProfiles(out.profiles||{}); setCloudVersion(out.version||cloudVersion); }catch{ alert("Avatar upload failed (file too big?)"); } }; r.readAsDataURL(f); }}/></label>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
        }
      </section>
    </div>
  );
}
