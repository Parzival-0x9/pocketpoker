// PHASE2_SIDEBAR_CANARY
import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./components/PlayerRow.jsx";
import { aud, sum, round2, settle, nextFridayISO, toCSV } from "./lib/calc.js";

const DEFAULT_BUYIN=50, DEFAULT_PERHEAD=20, uid=()=>Math.random().toString(36).slice(2,9);
const blank=()=>({id:uid(),name:"",buyIns:0,cashOut:0}), LS="pocketpoker_state", THEME="pp_theme", FELT="pp_felt", PROFILES="pp_profiles";
const NAV="pp_nav", NAVOPEN="pp_nav_open";

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
  const [started,setStarted]=useState(false);
  const [overrideMismatch,setOverrideMismatch]=useState(false);
  const [theme,setTheme]=useState(()=>localStorage.getItem(THEME) || "dark");
  const [felt,setFelt]=useState(()=>localStorage.getItem(FELT) || "emerald");
  const [expanded,setExpanded]=useState({});
  const [ledgerExpanded,setLedgerExpanded]=useState({});
  const [profiles,setProfiles]=useState(()=>{ try{ return JSON.parse(localStorage.getItem(PROFILES)) || {}; } catch { return {}; } });
  const [celebrated, setCelebrated] = useState(new Set());

  // NAV STATE
  const [activeTab,setActiveTab] = useState(()=>localStorage.getItem(NAV) || "game");
  const [navOpen,setNavOpen] = useState(()=> (localStorage.getItem(NAVOPEN) ?? "false") === "true");

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
  useEffect(()=>{ localStorage.setItem(PROFILES, JSON.stringify(profiles)); }, [profiles]);
  useEffect(()=>{ localStorage.setItem(NAV, activeTab); }, [activeTab]);
  useEffect(()=>{ localStorage.setItem(NAVOPEN, String(navOpen)); }, [navOpen]);

  const {days,hrs,mins,secs} = useCountdownToFriday();

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

  function saveGameToHistory(){
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
    setHistory(h=>[g,...h]);
  }

  function autoBalance(){
    const {top,diff}=totals; if(!top||Math.abs(diff)<0.01) return;
    setPlayers(ps=>ps.map(p=>p.id===top.id?{...p,cashOut:round2(p.cashOut - diff)}:p));
  }

  function deleteGame(id){
    if (window.confirm("Delete this game from history?")) {
      setHistory(h=> h.filter(g=> g.id !== id));
    }
  }
  function clearHistory(){
    if (window.confirm("Delete ALL saved games? This cannot be undone.")) {
      setHistory([]);
      setExpanded({});
    }
  }

  // simplified CSV helpers
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
  }

  function burstConfetti(){
    let root = document.getElementById('confetti-root');
    if(!root){ root = document.createElement('div'); root.id='confetti-root'; document.body.appendChild(root); }
    for(let i=0;i<30;i++){
      const el = document.createElement('div');
      el.className='confetti';
      el.style.left = (Math.random()*100)+'vw';
      root.appendChild(el);
      setTimeout(()=>el.remove(), 1200);
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

  const alerts = useMemo(()=>[], [history]); // keep simple for this canary

  // --- VIEWS ---
  function GameView(){ return (<div className="surface"><div className="meta">Game view (Phase 2)</div></div>); }
  function HistoryView(){ return (<div className="surface"><div className="meta">History tab</div></div>); }
  function LedgersView(){ return (<div className="surface"><div className="meta">Ledgers tab</div></div>); }
  function ProfilesView(){ return (<div className="surface"><div className="meta">Profiles tab</div></div>); }

  return (
    <div className="layout">
      <aside className={navOpen ? "sidebar open" : "sidebar"}>
        <div className="sidebar-header">
          <div className="brand">♠ PocketPoker <span className="phase-badge">Phase 2</span></div>
          <button className="btn ghost close" onClick={()=>setNavOpen(false)}>✕</button>
        </div>
        <nav className="nav">
          <button className={activeTab==='game'?'nav-item active':'nav-item'} onClick={()=>{setActiveTab('game'); setNavOpen(false)}}>Game</button>
          <button className={activeTab==='history'?'nav-item active':'nav-item'} onClick={()=>{setActiveTab('history'); setNavOpen(false)}}>History</button>
          <button className={activeTab==='ledgers'?'nav-item active':'nav-item'} onClick={()=>{setActiveTab('ledgers'); setNavOpen(false)}}>Ledgers</button>
          <button className={activeTab==='profiles'?'nav-item active':'nav-item'} onClick={()=>{setActiveTab('profiles'); setNavOpen(false)}}>Profiles</button>
        </nav>
      </aside>

      <main className="content container">
        <div className="header">
          <div className="title-badge">
            <button className="btn ghost hamburger" onClick={()=>setNavOpen(true)}>☰</button>
            <h1>PocketPoker</h1>
            <span className="badge">Local</span>
            <span className="badge phase">Phase 2</span>
          </div>
        </div>

        {activeTab==='game' && <GameView />}
        {activeTab==='history' && <HistoryView />}
        {activeTab==='ledgers' && <LedgersView />}
        {activeTab==='profiles' && <ProfilesView />}
      </main>
    </div>
  );
}
