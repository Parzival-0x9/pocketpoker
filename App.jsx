
import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./PlayerRow.jsx";
import { aud, sum, round2, settle, nextFridayISO, toCSV } from "./calc.js";

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
  const [started,setStarted]=useState(false);
  const [overrideMismatch,setOverrideMismatch]=useState(false);
  const [tab, setTab] = useState(()=> localStorage.getItem('pp_tab') || 'game');
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(()=>{ localStorage.setItem('pp_tab', tab); }, [tab]);

  useEffect(()=>{ const s=load();
    if(s){ setPlayers(s.players?.length?s.players:[blank(),blank()]);
      setBuyInAmount(s.buyInAmount ?? DEFAULT_BUYIN);
      setApplyPerHead(!!s.applyPerHead);
      setPerHeadAmount(s.perHeadAmount ?? DEFAULT_PERHEAD);
      setHistory(s.history ?? []); setStarted(!!s.started); }
  },[]);
  useEffect(()=>{ save({players,buyInAmount,applyPerHead,perHeadAmount,history,started}) },
    [players,buyInAmount,applyPerHead,perHeadAmount,history,started]);

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
    const sorted = [...adjusted].sort((a,b)=>b.net-a.net);
    const winner = sorted.length ? sorted[0] : null;
    const perHeadPayers = winner ? adjusted.filter(p=>p.id!==winner.id).map(p=>p.name||"Player") : [];
    return { adjusted, top, buyInSum, cashAdjSum, diff, winner, perHeadPayers };
  }, [players, buyInAmount, applyPerHead, perHeadAmount]);

  function updatePlayer(u){ setPlayers(ps=> u?._remove ? ps.filter(p=>p.id!==u.id) : ps.map(p=>p.id===u.id?u:p)); }
  const addPlayer=()=>setPlayers(ps=>[...ps,blank()]);
  const startGame=()=>{ setPlayers(ps=>ps.map(p=>({ ...p, buyIns:0, cashOut:0 }))); setStarted(true); setOverrideMismatch(false); };
  const resetGame=()=>{ setPlayers([blank(),blank()]); setStarted(false); setOverrideMismatch(false); };
  function autoBalance(){ const {top,diff}=totals; if(!top||Math.abs(diff)<0.01) return; setPlayers(ps=>ps.map(p=>p.id===top.id?{...p,cashOut:round2(p.cashOut - diff)}:p)); }

  function saveGameToHistory(){
    const stamp = new Date().toISOString();
    const g={ id:uid(), stamp,
      settings:{buyInAmount, perHead: applyPerHead ? perHeadAmount : 0},
      players: totals.adjusted.map(p=>({name:p.name||"Player",buyIns:p.buyIns,buyInTotal:p.buyInTotal,cashOut:p.cashOutAdj,prize:p.prize,net:p.netAdj})),
      totals:{buyIns:totals.buyInSum,cashOuts:totals.cashAdjSum,diff:totals.diff},
    };
    setHistory(h=>[g,...h]);
  }

  /* --- Desktop section --- */
  const GameSectionDesktop = () => (
    <div className="surface table-desktop" style={{marginTop:12}}>
      <div className="header">
        <div className="toolbar">
          <button className="btn primary" onClick={startGame}>Start New Game</button>
          <button className="btn secondary" onClick={addPlayer}>Add Player</button>
          <button className="btn danger" onClick={resetGame}>Reset Players</button>
        </div>
        <div className="toolbar">
          <label className="inline">Buy-in (A$)
            <input className="small mono" type="number" min="1" step="1" value={buyInAmount} onChange={e=>setBuyInAmount(Math.max(1,parseFloat(e.target.value||50)))} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={applyPerHead} onChange={e=>setApplyPerHead(e.target.checked)} /> Winner gets A$
          </label>
          <input className="small mono" type="number" min="0" step="1" value={perHeadAmount} onChange={e=>setPerHeadAmount(Math.max(0,parseFloat(e.target.value||0)))} />
          <span className="meta">from each other player</span>
        </div>
      </div>

      <div className="table-wrapper">
        <table className="table">
          <thead><tr><th>Player</th><th className="center">Buy-ins</th><th className="center">Cash-out</th><th className="center">Net</th><th className="center">Actions</th></tr></thead>
          <tbody>
            {players.map(p => (<PlayerRow key={p.id} p={p} onChange={updatePlayer} buyInAmount={buyInAmount} />))}
          </tbody>
          <tfoot><tr>
            <th>Total</th>
            <th className="center mono">A${totals.buyInSum.toFixed(2)}</th>
            <th className="center mono">A${totals.cashAdjSum.toFixed(2)}</th>
            <th className="center mono">{totals.diff.toFixed(2)}</th>
            <th></th>
          </tr></tfoot>
        </table>
      </div>

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:10}}>
        <button className="btn success" onClick={saveGameToHistory} disabled={Math.abs(totals.diff) > 0.01 && !overrideMismatch}>End Game & Save</button>
        <button className="btn secondary" onClick={autoBalance}>Auto-Balance</button>
      </div>
    </div>
  );

  /* --- Phone section --- */
  const GameSectionMobile = () => (
    <div className="surface player-card" style={{marginTop:12}}>
      <div className="toolbar">
        <button className="btn primary" onClick={startGame}>Start</button>
        <button className="btn secondary" onClick={addPlayer}>Add</button>
        <button className="btn danger" onClick={resetGame}>Reset</button>
      </div>
      <hr className="hair" />
      {players.map(p => (
        <div key={p.id} className="player-row" style={{marginTop:8}}>
          <div className="full"><input className="name" value={p.name} onChange={e=>updatePlayer({...p, name:e.target.value})} placeholder="Name" type="text" /></div>
          <div>
            <div className="toolbar" style={{justifyContent:'center'}}>
              <button className="btn secondary" onClick={()=>updatePlayer({...p,buyIns:Math.max(0,p.buyIns-1)})}>–</button>
              <input className="small mono" type="number" min="0" step="1" value={p.buyIns} onChange={e=>updatePlayer({...p,buyIns:Math.max(0,parseInt(e.target.value||0))})} />
              <button className="btn secondary" onClick={()=>updatePlayer({...p,buyIns:p.buyIns+1})}>+</button>
            </div>
            <div className="meta" style={{textAlign:'center',marginTop:4}}>{p.buyIns} × {buyInAmount} = <span className="mono">A${(p.buyIns*buyInAmount).toFixed(2)}</span></div>
          </div>
          <div>
            <input className="small mono" type="number" min="0" step="0.01" value={p.cashOut} onChange={e=>updatePlayer({...p,cashOut:parseFloat(e.target.value||0)})} />
            <div className="meta" style={{textAlign:'center',marginTop:4}}>cash-out</div>
          </div>
          <div className="full mono" style={{textAlign:'center',marginTop:4}}>{(p.cashOut - p.buyIns*buyInAmount).toFixed(2)}</div>
          <span className="net-label">Net</span>
          <div className="full" style={{display:'flex',justifyContent:'flex-end'}}><button className="btn danger" onClick={()=>updatePlayer({...p,_remove:true})}>Remove</button></div>
        </div>
      ))}

      <div className="totals-bar">
        <div className="item"><span className="label">Buy-ins</span><span className="value">A${totals.buyInSum.toFixed(2)}</span></div>
        <div className="item"><span className="label">Cash-outs</span><span className="value">A${totals.cashAdjSum.toFixed(2)}</span></div>
        <div className="item"><span className="label">Net</span><span className="value">{totals.diff>=0?'+':''}{totals.diff.toFixed(2)}</span></div>
      </div>

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:8}}>
        <button className="btn success" onClick={saveGameToHistory} disabled={Math.abs(totals.diff) > 0.01 && !overrideMismatch}>End & Save</button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="topbar">
        <button className="hamburger" onClick={()=>setDrawerOpen(true)}>☰</button>
        <div className="brand"><h1>PocketPoker</h1><span className="badge">Local</span></div>
      </div>
      <div className="spacer" />

      <div className="container">
        <div className="meta">Next Friday in <b>{days}d {hrs}h {mins}m {secs}s</b> — get your $20 ready.</div>
        <GameSectionDesktop />
        <GameSectionMobile />
      </div>
    </div>
  );
}
