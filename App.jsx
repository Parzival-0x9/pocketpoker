import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./components/PlayerRow.jsx";
import { aud, sum, round2, settle, nextFridayISO, toCSV } from "./lib/calc.js";
import { chooseLocker, getWhoAmI, setWhoAmI } from "./lib/lock.js";

// --- Cloud sync (Upstash via Vercel API) ---
const API_BASE = ""; // same origin
const SEASON_ID = (import.meta && import.meta.env && import.meta.env.VITE_SEASON_ID) || "default";

const DEFAULT_BUYIN=50, DEFAULT_PERHEAD=20, uid=()=>Math.random().toString(36).slice(2,9);
const blank=()=>({id:uid(),name:"",buyIns:0,cashOut:0}), LS="pocketpoker_state", THEME="pp_theme", FELT="pp_felt", PROFILES="pp_profiles";
const load=()=>{try{const r=localStorage.getItem(LS);return r?JSON.parse(r):null}catch{return null}};
const save=(s)=>{try{localStorage.setItem(LS,JSON.stringify(s))}catch{}};

function useCountdownToFriday(){
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{ const i=setInterval(()=>setNow(Date.now()),1000); return ()=>clearInterval(i); },[]);
  const due = new Date(nextFridayISO()); const diff = Math.max(0, due.getTime()-now);
  const days=Math.floor(diff/86400000); const hrs=Math.floor((diff%86400000)/3600000);
  const mins=Math.floor((diff%3600000)/60000); const secs=Math.floor((diff%60000)/1000);
  return { due, days, hrs, mins, secs };
}

export default function App(){
  const [players,setPlayers]=useState([blank(),blank()]);
  const [buyInAmount,setBuyInAmount]=useState(DEFAULT_BUYIN);
  const [applyPerHead,setApplyPerHead]=useState(false);
  const [perHeadAmount,setPerHeadAmount]=useState(DEFAULT_PERHEAD);
  const [history,setHistory]=useState([]);
  const [cloudVersion,setCloudVersion]=useState(0);
  const [syncStatus,setSyncStatus]=useState("idle"); // "idle" | "syncing" | "upToDate" | "error"
  const [started,setStarted]=useState(false);
  const [overrideMismatch,setOverrideMismatch]=useState(false);
  const [theme,setTheme]=useState(()=>localStorage.getItem(THEME) || "dark");
  const [felt,setFelt]=useState(()=>localStorage.getItem(FELT) || "emerald");
  const [expanded,setExpanded]=useState({});
  const [ledgerExpanded,setLedgerExpanded]=useState({});
  const [profiles,setProfiles]=useState(()=>{ try{ return JSON.parse(localStorage.getItem(PROFILES)) || {}; } catch { return {}; } });
  const [celebrated, setCelebrated] = useState(new Set());

  // --- Host Lock state (server is source of truth) ---
  const [hostLock,setHostLock] = useState({ active:false, by:null, until:null, at:null });

  // --- Identity for this device (who can edit while locked) ---
  const [whoAmI, setWhoAmIState] = useState(()=> getWhoAmI() || "");
  useEffect(()=>{ setWhoAmI(whoAmI || ""); }, [whoAmI]);

  const playerNames = useMemo(()=> Array.from(new Set((players||[]).map(p=> (p.name||"").trim()).filter(Boolean))), [players]);
  const canEdit = !hostLock.active || (whoAmI && hostLock.by && whoAmI === hostLock.by);

  // ---- Cloud API helpers ----
  async function apiGetSeason(){
    try{
      const res = await fetch(`${API_BASE}/api/season/get?id=${encodeURIComponent(SEASON_ID)}`);
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    }catch(e){ console.error("apiGetSeason", e); throw e; }
  }
  async function apiAppendGame(game){
    try{
      const res = await fetch(`${API_BASE}/api/season/append-game`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "If-Match": String(cloudVersion) },
        body: JSON.stringify({ seasonId: SEASON_ID, game })
      });
      if(res.status===409){
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        const res2 = await fetch(`${API_BASE}/api/season/append-game`, {
          method: "POST",
          headers: { "Content-Type":"application/json", "If-Match": String(doc.version||0) },
          body: JSON.stringify({ seasonId: SEASON_ID, game })
        });
        if(!res2.ok) throw new Error(await res2.text());
        return await res2.json();
      }
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    }catch(e){ console.error("apiAppendGame", e); throw e; }
  }
  async function apiDeleteGame(gameId){
    try{
      const res = await fetch(`${API_BASE}/api/season/delete-game`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "If-Match": String(cloudVersion) },
        body: JSON.stringify({ seasonId: SEASON_ID, gameId })
      });
      if(res.status===409){
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        const res2 = await fetch(`${API_BASE}/api/season/delete-game`, {
          method: "POST",
          headers: { "Content-Type":"application/json", "If-Match": String(doc.version||0) },
          body: JSON.stringify({ seasonId: SEASON_ID, gameId })
        });
        if(!res2.ok) throw new Error(await res2.text());
        return await res2.json();
      }
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    }catch(e){ console.error("apiDeleteGame", e); throw e; }
  }
  async function apiLockSeason(locked, by){
    const payload = { seasonId: SEASON_ID, locked, action: locked ? "lock" : "unlock" };
    if (locked && by) payload.by = by;
    const res = await fetch(`${API_BASE}/api/season/lock`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const msg = await res.text();
      alert(msg || "Failed to toggle host lock");
      return;
    }
    const doc = await res.json().catch(()=>null);
    if (doc) hydrateFromDoc(doc);
    else setHostLock(s=>({ ...s, active: locked, by: locked ? by : null }));
  }

  // Merge server doc into local UI state
  function hydrateFromDoc(doc){
    if(doc && Array.isArray(doc.games)){ setHistory(doc.games); }
    if(doc && typeof doc.version==='number'){ setCloudVersion(doc.version); }
    const lock = doc && (doc.lock || {});
    const active = !!(lock.active ?? lock.locked ?? doc.locked ?? false);
    const by = lock.by || lock.user || lock.device || null;
    const until = lock.until || lock.unlockAt || null;
    const at = lock.at || lock.lockedAt || null;
    setHostLock({ active, by, until, at });
  }

  // Manual refresh
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

  // Compact mobile: tabs + drawer
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tab, setTab] = useState(()=> localStorage.getItem("pp_tab") || "game");
  useEffect(()=>{ localStorage.setItem("pp_tab", tab); }, [tab]);

  useEffect(()=>{ const s=load();
    if(s){ setPlayers(s.players?.length?s.players:[blank(),blank()]);
      setBuyInAmount(s.buyInAmount ?? DEFAULT_BUYIN);
      setApplyPerHead(!!s.applyPerHead);
      setPerHeadAmount(s.perHeadAmount ?? DEFAULT_PERHEAD);
      setHistory(s.history ?? []); setStarted(!!s.started); }
  },[]);
  useEffect(()=>{ save({players,buyInAmount,applyPerHead,perHeadAmount,history,started}) },
    [players,buyInAmount,applyPerHead,perHeadAmount,history,started]);
  useEffect(()=>{
    document.documentElement.setAttribute('data-theme', theme==='light'?'light':'dark');
    localStorage.setItem(THEME, theme);
  }, [theme]);
  useEffect(()=>{
    document.documentElement.setAttribute('data-felt', felt==='midnight'?'midnight':'emerald');
    localStorage.setItem(FELT, felt);
  }, [felt]);
  useEffect(()=>{
    localStorage.setItem(PROFILES, JSON.stringify(profiles));
  }, [profiles]);

  const {due,days,hrs,mins,secs} = useCountdownToFriday();

  // Load season on mount + polling
  useEffect(()=>{
    (async()=>{
      try{
        setSyncStatus("syncing");
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        setSyncStatus("upToDate");
      }catch(e){ setSyncStatus("error"); }
    })();
  },[]);
  useEffect(()=>{
    const t = setInterval(async()=>{
      try{
        const doc = await apiGetSeason();
        if((doc.version||0)!==cloudVersion){
          hydrateFromDoc(doc);
        }else{
          const lock = doc && (doc.lock || {});
          const active = !!(lock.active ?? lock.locked ?? doc.locked ?? false);
          if(active !== hostLock.active || (lock.by||null) !== hostLock.by){
            hydrateFromDoc(doc);
          }
        }
      }catch(e){ /* ignore transient */ }
    }, 10000);
    return ()=>clearInterval(t);
  },[cloudVersion, hostLock.active, hostLock.by]);

  const totals=useMemo(()=>{
    const base=players.map(p=>({...p, buyInTotal:round2(p.buyIns*buyInAmount), baseCash:p.cashOut }));
    const withNet=base.map(p=>({...p, net: round2(p.baseCash - p.buyIns*buyInAmount)}));
    const top=[...withNet].sort((a,b)=>b.net-a.net)[0];
    let adjusted=withNet.map(p=>({...p, prize:0, cashOutAdj:round2(p.baseCash), netAdj: round2(p.baseCash - p.buyIns*buyInAmount)}));

    if (applyPerHead && top) {
      const heads = Math.max(0, players.length - 1);
      adjusted = withNet.map(p=>{
        if (p.id === top.id) {
          const cash = round2(p.baseCash + perHeadAmount * heads);
          return { ...p, prize: perHeadAmount*heads, cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount) };
        } else {
          const cash = round2(p.baseCash - perHeadAmount);
          return { ...p, prize: -perHeadAmount, cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount) };
        }
      });
    }

    const buyInSum = round2(sum(adjusted.map(p=> p.buyInTotal)));
    const cashAdjSum = round2(sum(adjusted.map(p=> p.cashOutAdj)));
    const diff = round2(cashAdjSum - buyInSum);
    const txns = settle(adjusted.map(p=>({ name: p.name || "Player", net: p.netAdj })));
    const sorted = [...adjusted].sort((a,b)=>b.net-a.net);
    const winner = sorted.length ? sorted[0] : null;
    const perHeadPayers = winner ? adjusted.filter(p=>p.id!==winner.id).map(p=>p.name||"Player") : [];
    return { adjusted, top, buyInSum, cashAdjSum, diff, txns, winner, perHeadPayers };
  }, [players, buyInAmount, applyPerHead, perHeadAmount]);

  function updatePlayer(u){ setPlayers(ps=> u?._remove ? ps.filter(p=>p.id!==u.id) : ps.map(p=>p.id===u.id?u:p)); }
  const addPlayer=()=>setPlayers(ps=>[...ps,blank()]);
  const startGame=()=>{ setPlayers(ps=>ps.map(p=>({ ...p, buyIns:0, cashOut:0 }))); setStarted(true); setOverrideMismatch(false); };
  const resetGame=()=>{ setPlayers([blank(),blank()]); setStarted(false); setOverrideMismatch(false); };

  async function saveGameToHistory(){
    const stamp = new Date().toISOString();
    const perHeadDue = nextFridayISO(stamp);
    const perHeadPayments = {};
    totals.perHeadPayers.forEach(n=> perHeadPayments[n] = { paid:false, method:null, paidAt:null });
    const g={ id:uid(), stamp,
      settings:{buyInAmount, perHead: applyPerHead ? perHeadAmount : 0},
      players: totals.adjusted.map(p=>({name:p.name||"Player",buyIns:p.buyIns,buyInTotal:p.buyInTotal,cashOut:p.cashOutAdj,prize:p.prize,net:p.netAdj})),
      totals:{buyIns:totals.buyInSum,cashOuts:totals.cashAdjSum,diff:totals.diff},
      txns: totals.txns,
      perHead: applyPerHead ? {
        winner: totals.winner?.name || "Winner",
        amount: perHeadAmount,
        payers: totals.perHeadPayers,
        due: perHeadDue,
        payments: perHeadPayments,
        celebrated:false
      } : null
    };
    try{
      setSyncStatus("syncing");
      const doc = await apiAppendGame(g); 
      hydrateFromDoc(doc);
      setSyncStatus("upToDate");
    }catch(e){
      console.error(e);
      setHistory(h=>[g,...h]); // local fallback
      setSyncStatus("error");
    }
  }

  function autoBalance(){
    const {top,diff}=totals; if(!top||Math.abs(diff)<0.01) return;
    setPlayers(ps=>ps.map(p=>p.id===top.id?{...p,cashOut:round2(p.cashOut - diff)}:p));
  }

  function deleteGame(id){
    if (window.confirm("Delete this game from history?")) {
      (async()=>{
        try{
          setSyncStatus("syncing");
          const doc = await apiDeleteGame(id);
          hydrateFromDoc(doc);
          setSyncStatus("upToDate");
        }catch(e){
          console.error(e);
          setHistory(h=> h.filter(g=> g.id !== id)); // local fallback
          setSyncStatus("error");
        }
      })();
    }
  }
  function clearHistory(){
    if (window.confirm("Delete ALL saved games? This cannot be undone.")) {
      setHistory([]);
      setExpanded({});
    }
  }

  // CSV export
  function downloadCSV(filename, rows){
    const csv = toCSV(rows);
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }
  function exportSeason(){
    const r1 = [["game_id","stamp","player","buy_in","cash_out_adj","prize_adj","net"]];
    history.forEach(g=>{ g.players.forEach(p=> r1.push([g.id, g.stamp, p.name, p.buyInTotal, p.cashOut, p.prize, p.net])); });
    downloadCSV("players.csv", r1);

    const r2 = [["game_id","stamp","from","to","amount"]];
    history.forEach(g=> (g.txns||[]).forEach(t=> r2.push([g.id, g.stamp, t.from, t.to, t.amount])));
    downloadCSV("transfers.csv", r2);

    const r3 = [["game_id","stamp","winner","payer","amount","paid","method","paid_at","due"]];
    history.forEach(g=>{
      if(!g.perHead) return;
      g.perHead.payers.forEach(name=>{
        const rec = g.perHead.payments?.[name] || {paid:false,method:null,paidAt:null};
        r3.push([g.id, g.stamp, g.perHead.winner, name, g.perHead.amount, rec.paid, rec.method, rec.paidAt, g.perHead.due]);
      });
    });
    downloadCSV("perhead.csv", r3);
  }

  // confetti
  function burstConfetti(){
    let root = document.getElementById('confetti-root');
    if(!root){ root = document.createElement('div'); root.id='confetti-root'; document.body.appendChild(root); }
    const colors = ["#fca5a5","#93c5fd","#fde68a","#86efac","#a5b4fc"];
    for(let i=0;i<60;i++){
      const el = document.createElement('div');
      el.className='confetti';
      el.style.left = (Math.random()*100)+'vw';
      el.style.background = colors[Math.floor(Math.random()*colors.length)];
      el.style.transform = `rotate(${Math.random()*360}deg)`;
      el.style.animationDelay = (Math.random()*200)+'ms';
      el.style.width = (4+Math.random()*5)+'px';
      el.style.height = (8+Math.random()*10)+'px';
      root.appendChild(el);
      setTimeout(()=>el.remove(), 1400);
    }
  }
  function checkCelebrate(g){
    if(!g.perHead || g.perHead.celebrated) return false;
    const allPaid = g.perHead.payers.every(n=> g.perHead.payments[n]?.paid);
    return allPaid;
  }
  useEffect(()=>{
    history.forEach(g=>{
      if(checkCelebrate(g) && !celebrated.has(g.id)){
        burstConfetti();
        setCelebrated(s=> new Set([...Array.from(s), g.id]));
        setHistory(h=> h.map(x=> x.id===g.id ? {...x, perHead:{...x.perHead, celebrated:true}} : x));
      }
    });
  }, [history]);

  // per-head status/method + PayID
  function markPerHeadPaid(gameId, name, method){
    setHistory(h=> h.map(g=>{
      if(g.id!==gameId) return g;
      const ph = g.perHead || null; if(!ph) return g;
      const now = new Date().toISOString();
      const rec = ph.payments[name] || {paid:false, method:null, paidAt:null};
      const payments = { ...ph.payments, [name]: { paid:true, method:method||rec.method||"cash", paidAt: now } };
      return { ...g, perHead: { ...ph, payments } };
    }));
  }
  function setPerHeadMethod(gameId, name, method){
    setHistory(h=> h.map(g=>{
      if(g.id!==gameId) return g;
      const ph = g.perHead || null; if(!ph) return g;
      const rec = ph.payments[name] || {paid:false, method:null, paidAt:null};
      return { ...g, perHead: { ...ph, payments: { ...ph.payments, [name]: { ...rec, method } } } };
    }));
  }
  function copyPayID(name){
    const pid = profiles[name]?.payid;
    if(!pid){ alert('No PayID stored for '+name); return; }
    if(navigator.clipboard && window.isSecureContext){
      navigator.clipboard.writeText(pid); alert('PayID copied for '+name);
    } else {
      const area=document.createElement('textarea'); area.value=pid; document.body.appendChild(area); area.select();
      document.execCommand('copy'); area.remove(); alert('PayID copied for '+name);
    }
  }

  // Alerts: unpaid per-head past due
  const alerts = useMemo(()=>{
    const items=[]; const now = Date.now();
    history.forEach(g=>{
      if(!g.perHead) return;
      const due = new Date(g.perHead.due).getTime();
      const unpaid = g.perHead.payers.filter(n=> !g.perHead.payments[n]?.paid);
      if(unpaid.length && now > due){
        items.push({ id:g.id, winner:g.perHead.winner, due:g.perHead.due, unpaid, amount:g.perHead.amount });
      }
    });
    return items;
  }, [history]);

  // Ledgers
  const ledgers = useMemo(()=>{
    const L = new Map();
    const ensure = (n)=>{
      if(!L.has(n)) L.set(n,{ net:0, owes:new Map(), owedBy:new Map() });
      return L.get(n);
    };
    history.forEach(g=>{
      (g.txns||[]).forEach(t=>{
        const from=ensure(t.from), to=ensure(t.to);
        from.net -= t.amount; to.net += t.amount;
        from.owes.set(t.to, (from.owes.get(t.to)||0) + t.amount);
        to.owedBy.set(t.from, (to.owedBy.get(t.from)||0) + t.amount);
      });
    });
    const out = {};
    for (const [name, v] of L) {
      out[name] = {
        net: round2(v.net),
        owes: Array.from(v.owes, ([to,amount])=>({to,amount:round2(amount)})),
        owedBy: Array.from(v.owedBy, ([from,amount])=>({from,amount:round2(amount)}))
      };
    }
    return out;
  }, [history]);

  // Suggested names (for convenience)
  const knownNames = useMemo(()=>{
    const set = new Set();
    players.forEach(p=> p.name && set.add(p.name));
    history.forEach(g=> g.players.forEach(p=> p.name && set.add(p.name)));
    return Array.from(set).sort();
  }, [players, history]);

  // Read-only wrapper when host locked (only blocks if you're NOT the locker)
  function Section({children, title}){
    return (
      <div className="surface pp-guard" style={{position:'relative'}}>
        {title ? <div className="header" style={{marginBottom:0}}><h3 style={{margin:0}}>{title}</h3></div> : null}
        {children}
        {(hostLock.active && (!whoAmI || whoAmI !== hostLock.by)) && (
          <div className="pp-ro" title="Host Lock: read-only">
            <div className="pp-ro-badge">🔒 Read-only (Host Lock{hostLock.by?` by ${hostLock.by}`:''})</div>
          </div>
        )}
      </div>
    );
  }

  // --- Section UIs ---
  const GameSection = (
    <Section>
      <div className="controls">
        <div className="stack">
          <button className="btn primary" onClick={startGame} disabled={!canEdit}>Start New</button>
          <button className="btn secondary" onClick={addPlayer} disabled={!canEdit}>Add Player</button>
          <button className="btn danger" onClick={resetGame} disabled={!canEdit}>Reset Players</button>
          <span className="pill">🎯 Enter cash-outs at the end.</span>
        </div>
        <div className="toggles toolbar">
          <label className="inline">Buy-in (A$)
            <input className="small mono" type="number" min="1" step="1" value={buyInAmount} onChange={e=>setBuyInAmount(Math.max(1,parseFloat(e.target.value||50)))} disabled={!canEdit} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={applyPerHead} onChange={e=>setApplyPerHead(e.target.checked)} disabled={!canEdit} /> Winner gets A$
          </label>
          <input className="small mono" type="number" min="0" step="1" value={perHeadAmount} onChange={e=>setPerHeadAmount(Math.max(0,parseFloat(e.target.value||0)))} disabled={!canEdit} />
          <span className="meta">from each other player</span>
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
            <button className="btn secondary" onClick={autoBalance} disabled={!canEdit}>Auto-Balance</button>
            <label className="inline"><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} disabled={!canEdit} /> Override & Save</label>
          </div>
        </div>
      ) : (
        <div className="header" style={{marginTop:12}}>
          <div className="ribbon">✅ Balanced: totals match.</div>
          <div className="toolbar"></div>
        </div>
      )}

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:12}}>
        <button className="btn success" onClick={saveGameToHistory} disabled={(Math.abs(totals.diff) > 0.01 && !overrideMismatch) || !canEdit}>End Game & Save</button>
      </div>
    </Section>
  );

  const HistorySection = (
    <Section title="Game Overview (History)">
      <div className="toolbar">
        <button className="btn secondary" onClick={exportSeason}>Export CSVs</button>
        <button className="btn danger" onClick={clearHistory} disabled={!canEdit}>Delete All</button>
      </div>
      <div className="meta">Tap details to see per-head payments and settlement transfers.</div>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Players (with net)</th>
            <th className="center">Tot Buy-ins</th>
            <th className="center">Tot Cash-outs</th>
            <th className="center">Diff</th>
            <th className="center">Actions</th>
          </tr>
        </thead>
        <tbody>
          {history.length===0 ? (
            <tr><td colSpan="6" className="center meta">No games saved yet.</td></tr>
          ) : history.map(g=>{
            const key=g.id;
            const playersSorted=[...g.players].sort((a,b)=>b.net-a.net);
            const winner = playersSorted[0];
            const summary=playersSorted.map(p=>(
              <span key={p.name} style={{marginRight:8}}>
                {p.name} ({p.net>=0?'+':''}{p.net.toFixed(2)})
                {p.name===winner?.name && <span className="chip" title="Top winner"/>}
              </span>
            ));
            return (
              <React.Fragment key={g.id}>
                <tr>
                  <td className="meta mono">{new Date(g.stamp).toLocaleString()}</td>
                  <td>{summary}</td>
                  <td className="center mono">{aud(g.totals.buyIns)}</td>
                  <td className="center mono">{aud(g.totals.cashOuts)}</td>
                  <td className="center mono">{aud(g.totals.diff)}</td>
                  <td className="center">
                    <div className="toolbar" style={{justifyContent:'center'}}>
                      <button className="btn secondary" onClick={()=>setExpanded(e=>({...e,[key]:!e[key]}))}>{expanded[key]?'Hide':'Details'}</button>
                      <button className="btn danger" onClick={()=>deleteGame(g.id)} disabled={!canEdit}>Delete</button>
                    </div>
                  </td>
                </tr>
                {expanded[key] && (
                  <tr>
                    <td colSpan="6">
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

                        {g.perHead && (
                          <div>
                            <div style={{height:8}} />
                            <strong>Winner's A${g.perHead.amount} per-head payments</strong> <span className="meta">Winner: {g.perHead.winner} • Due: {new Date(g.perHead.due).toLocaleString()}</span>
                            <table className="table">
                              <thead><tr><th>Payer</th><th className="center">Method</th><th className="center">Status</th><th className="center">Paid at</th><th className="center">PayID</th></tr></thead>
                              <tbody>
                                {g.perHead.payers.map(name=>{
                                  const rec = g.perHead.payments?.[name] || {paid:false,method:null,paidAt:null};
                                  const overdue = !rec.paid && (Date.now() > new Date(g.perHead.due).getTime());
                                  return (
                                    <tr key={name}>
                                      <td>{name}</td>
                                      <td className="center">
                                        <select value={rec.method||""} onChange={e=>setPerHeadMethod(g.id,name,e.target.value||null)} disabled={!canEdit}>
                                          <option value="">—</option>
                                          <option value="cash">Cash</option>
                                          <option value="payid">PayID</option>
                                        </select>
                                      </td>
                                      <td className="center">
                                        {rec.paid ? <span className="pill">Paid</span> :
                                          <button className="btn success" onClick={()=>markPerHeadPaid(g.id,name,rec.method||'cash')} disabled={!canEdit}>Mark paid</button>}
                                        {overdue && <div className="meta">⚠️ overdue</div>}
                                      </td>
                                      <td className="center mono">{rec.paidAt ? new Date(rec.paidAt).toLocaleString() : '—'}</td>
                                      <td className="center">
                                        {profiles[name]?.payid ? (
                                          <button className="btn secondary" onClick={()=>copyPayID(name)}>Copy</button>
                                        ) : <span className="meta">—</span>}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div style={{height:8}} />
                        <strong>Transfers for settlement</strong>
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
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </Section>
  );

  const LedgersSection = (
    <Section title="Player Ledgers (Cumulative)">
      <div className="meta">Clean + collapsible. Tap Show to reveal who they owe / who owes them.</div>
      <table className="table">
        <thead><tr><th>Player</th><th className="center">Net Balance</th><th className="center">Actions</th></tr></thead>
        <tbody>
          {Object.keys(ledgers).length===0 ? (
            <tr><td colSpan="3" className="center meta">No history yet.</td></tr>
          ) : Object.entries(ledgers).sort((a,b)=> (b[1].net - a[1].net)).map(([name,info])=>{
            const key = name;
            return (
              <React.Fragment key={name}>
                <tr>
                  <td>{name}</td>
                  <td className="center mono">{info.net>=0?'+':''}{aud(info.net)}</td>
                  <td className="center">
                    <button className="btn secondary" onClick={()=>setLedgerExpanded(e=>({...e,[key]:!e[key]}))}>
                      {ledgerExpanded[key] ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
                {ledgerExpanded[key] && (
                  <tr>
                    <td colSpan="3">
                      <div className="detail">
                        {(() => {
                          const sum = (arr)=> (arr||[]).reduce((t,x)=> t + Number(x.amount||0), 0);
                          const oweYou = sum(info.owedBy);
                          const youOwe = sum(info.owes);
                          return (
                            <div className="pp-ledger-row" style={{marginBottom:8, display:"flex", gap:8, flexWrap:"wrap"}}>
                              {oweYou > 0 && (
                                <span className="pp-owe-badge">They owe you <span className="pp-badge-amount">{aud(oweYou)}</span></span>
                              )}
                              {youOwe > 0 && (
                                <span className="pp-owed-by-badge">You owe them <span className="pp-badge-amount">{aud(youOwe)}</span></span>
                              )}
                            </div>
                          );
                        })()}
                        <table className="table">
                          <thead><tr><th>They owe</th><th className="center">Amount</th><th>Owed by</th><th className="center">Amount</th></tr></thead>
                          <tbody>
                            <tr>
                              <td>
                                {(info.owes||[]).length===0 ? <span className="meta">—</span> :
                                  (info.owes||[]).map((x,i)=>(<div key={i}>{x.to}</div>))}
                              </td>
                              <td className="center mono">
                                {(info.owes||[]).length===0 ? <span className="meta">—</span> :
                                  (info.owes||[]).map((x,i)=>(<div key={i}>{aud(x.amount)}</div>))}
                              </td>
                              <td>
                                {(info.owedBy||[]).length===0 ? <span className="meta">—</span> :
                                  (info.owedBy||[]).map((x,i)=>(<div key={i}>{x.from}</div>))}
                              </td>
                              <td className="center mono">
                                {(info.owedBy||[]).length===0 ? <span className="meta">—</span> :
                                  (info.owedBy||[]).map((x,i)=>(<div key={i}>{aud(x.amount)}</div>))}
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
    </Section>
  );

  const ProfilesSection = (
    <Section title="Players & Profiles">
      <div className="meta">Add optional PayIDs so it’s one tap to copy during payouts.</div>
      <table className="table">
        <thead><tr><th>Name</th><th>PayID</th><th className="center">Copy</th></tr></thead>
        <tbody>
          {knownNames.length===0 ? (
            <tr><td colSpan="3" className="center meta">No known names yet. Add players above first.</td></tr>
          ) : knownNames.map(n=>{
            const v = profiles[n]?.payid || '';
            return (
              <tr key={n}>
                <td>{n}</td>
                <td><input type="text" value={v} onChange={e=>setProfiles(p=>({...p,[n]:{payid:e.target.value}}))} placeholder="email/phone PayID" disabled={!canEdit} /></td>
                <td className="center">{v ? <button className="btn secondary" onClick={()=>copyPayID(n)}>Copy</button> : <span className="meta">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );

  return (
    <>
      {/* Topbar */}
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
        <div className="pp-hide-mobile">
          <div className="toolbar">
            <button className="btn secondary" onClick={async()=>{
              if(!hostLock.active){
                const pick = await chooseLocker(playerNames);
                if(!pick) return;
                setWhoAmIState(pick); setWhoAmI(pick);
                await apiLockSeason(true, pick);
              } else {
                await apiLockSeason(false);
              }
            }}>
              {hostLock.active ? (hostLock.by ? `Unlock (${hostLock.by})` : "Unlock (Host)") : "Activate Host Lock"}
            </button>
            <div className="switch">
              <button className={theme==='dark' ? 'active' : 'ghost'} onClick={()=>setTheme('dark')}>🌙 Dark</button>
              <button className={theme==='light' ? 'active' : 'ghost'} onClick={()=>setTheme('light')}>☀️ Light</button>
            </div>
            <div className="switch">
              <button className={felt==='emerald' ? 'active' : 'ghost'} onClick={()=>setFelt('emerald')}>💚 Emerald</button>
              <button className={felt==='midnight' ? 'active' : 'ghost'} onClick={()=>setFelt('midnight')}>🌌 Midnight</button>
            </div>
          </div>
        </div>
      </div>

      {/* Drawer */}
      <div className={"pp-drawer " + (sidebarOpen?'open':'')}>
        <div className="title-badge" style={{justifyContent:'space-between', width:'100%'}}>
          <strong>Menu</strong>
          <button className="pp-burger" onClick={()=>setSidebarOpen(false)}>✕</button>
        </div>
        <div style={{height:8}} />
        <button className="btn secondary" onClick={async()=>{
          if(!hostLock.active){
            const pick = await chooseLocker(playerNames);
            if(!pick) return;
            setWhoAmIState(pick); setWhoAmI(pick);
            await apiLockSeason(true, pick);
          } else {
            await apiLockSeason(false);
          }
        }} style={{width:'100%'}}>
          {hostLock.active ? (hostLock.by ? `Unlock (${hostLock.by})` : "Unlock (Host)") : "Activate Host Lock"}
        </button>
        <div style={{height:8}} />
        <div className="switch">
          <button className={theme==='dark' ? 'active' : 'ghost'} onClick={()=>setTheme('dark')}>🌙 Dark</button>
          <button className={theme==='light' ? 'active' : 'ghost'} onClick={()=>setTheme('light')}>☀️ Light</button>
        </div>
        <div style={{height:8}} />
        <div className="switch">
          <button className={felt==='emerald' ? 'active' : 'ghost'} onClick={()=>setFelt('emerald')}>💚 Emerald</button>
          <button className={felt==='midnight' ? 'active' : 'ghost'} onClick={()=>setFelt('midnight')}>🌌 Midnight</button>
        </div>
        <div className="nav-list">
          {["game","history","ledgers","profiles"].map(k=>(
            <div key={k} className={"nav-item " + (tab===k?'active':'')} onClick={()=>{setTab(k); setSidebarOpen(false);}}>
              <span style={{textTransform:'capitalize'}}>{k}</span>
              <span>›</span>
            </div>
          ))}
        </div>
      </div>
      <div className={"pp-overlay " + (sidebarOpen?'show':'')} onClick={()=>setSidebarOpen(false)} />

      <div className="container">
        <div className="kicker">
          Next Friday at 5pm in <strong>{days}d {hrs}h {mins}m {secs}s</strong> — get your $20 ready. 🪙 {whoAmI ? `(You are ${whoAmI}${hostLock.active && whoAmI===hostLock.by ? " • editor" : ""})` : ""}
          {hostLock.active && <span className="badge" style={{marginLeft:8}}>🔒 Locked{hostLock.by?` by ${hostLock.by}`:''}</span>}
        </div>

        {(tab==="game" || tab==="history") && alerts.length>0 && (
          <div className="surface" style={{marginTop:14}}>
            {alerts.map(a=> (
              <div key={a.id} className="alert" style={{marginBottom:8}}>
                Unpaid A${a.amount} per-head — winner <strong>{a.winner}</strong>, due <strong>{new Date(a.due).toLocaleString()}</strong>. Unpaid: {a.unpaid.join(', ')}.
              </div>
            ))}
          </div>
        )}

        {tab==="game" && GameSection}
        {tab==="history" && HistorySection}
        {tab==="ledgers" && LedgersSection}
        {tab==="profiles" && ProfilesSection}

        <div className="tabbar">
          <button className={"btn " + (tab==='game'?'primary':'secondary')} onClick={()=>setTab('game')}>Game</button>
          <button className={"btn " + (tab==='history'?'primary':'secondary')} onClick={()=>setTab('history')}>History</button>
          <button className={"btn " + (tab==='ledgers'?'primary':'secondary')} onClick={()=>setTab('ledgers')}>Ledgers</button>
          <button className={"btn " + (tab==='profiles'?'primary':'secondary')} onClick={()=>setTab('profiles')}>Profiles</button>
        </div>

        <div className="footer meta">Tip: Host Lock makes all devices read-only until unlocked (or next day, Brisbane, on refresh).</div>
      </div>

      {/* lightweight CSS for the read-only overlay */}
      <style>{`
        .pp-guard{position:relative}
        .pp-ro{position:absolute;inset:0;background:transparent;pointer-events:auto}
        .pp-ro::after{content:'';position:absolute;inset:0;border-radius:18px;background:rgba(0,0,0,.12)}
        .pp-ro-badge{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.65);color:#fff;padding:6px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.15);font-size:12px}
      `}</style>
    </>
  );
}
