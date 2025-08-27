
import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./PlayerRow.jsx";
import { aud, sum, round2, settle, nextFridayISO, toCSV } from "./calc.js";

const DEFAULT_BUYIN=50, DEFAULT_PERHEAD=20, uid=()=>Math.random().toString(36).slice(2,9);
const blank=()=>({id:uid(),name:"",buyIns:0,cashOut:0}), LS="pocketpoker_state";
const load=()=>{try{const r=localStorage.getItem(LS);return r?JSON.parse(r):null}catch{return null}};
const save=(s)=>{try{localStorage.setItem(LS,JSON.stringify(s))}catch{}};

function useCountdownToFriday(){
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{ const i=setInterval(()=>setNow(Date.now()),1000); return ()=>clearInterval(i); },[]);
  const due = new Date(nextFridayISO()); const diff = Math.max(0, due.getTime()-now);
  const days=Math.floor(diff/86400000); const hrs=Math.floor((diff%86400000)/3600000);
  const mins=Math.floor((diff%3600000)/60000); const secs=Math.floor((diff%60000)/1000);
  return { days, hrs, mins, secs };
}

export default function App(){
  const [players,setPlayers]=useState([blank(),blank()]);
  const [buyInAmount,setBuyInAmount]=useState(DEFAULT_BUYIN);
  const [applyPerHead,setApplyPerHead]=useState(false);
  const [perHeadAmount,setPerHeadAmount]=useState(DEFAULT_PERHEAD);
  const [history,setHistory]=useState([]);
  const [overrideMismatch,setOverrideMismatch]=useState(false);
  const [tab, setTab] = useState(()=> localStorage.getItem('pp_tab') || 'game');
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(()=>{ localStorage.setItem('pp_tab', tab); }, [tab]);

  useEffect(()=>{ const s=load();
    if(s){ setPlayers(s.players?.length?s.players:[blank(),blank()]);
      setBuyInAmount(s.buyInAmount ?? DEFAULT_BUYIN);
      setApplyPerHead(!!s.applyPerHead);
      setPerHeadAmount(s.perHeadAmount ?? DEFAULT_PERHEAD);
      setHistory(s.history ?? []); }
  },[]);
  useEffect(()=>{ save({players,buyInAmount,applyPerHead,perHeadAmount,history}) },
    [players,buyInAmount,applyPerHead,perHeadAmount,history]);

  const {days,hrs,mins,secs} = useCountdownToFriday();

  const totals=useMemo(()=>{
    const base=players.map(p=>({...p, buyInTotal:round2(p.buyIns*buyInAmount), baseCash:p.cashOut||0, net: round2((p.cashOut||0) - p.buyIns*buyInAmount)}));
    let adjusted=[...base];
    if (applyPerHead && base.length>0){
      const top=[...base].sort((a,b)=>b.net-a.net)[0];
      const heads=Math.max(0, base.length-1);
      adjusted = base.map(p=> p===top
        ? ({...p, baseCash: round2(p.baseCash + perHeadAmount*heads), net: round2(p.baseCash + perHeadAmount*heads - p.buyIns*buyInAmount)})
        : ({...p, baseCash: round2(p.baseCash - perHeadAmount), net: round2(p.baseCash - perHeadAmount - p.buyIns*buyInAmount)})
      );
    }
    const buyInSum = round2(sum(adjusted.map(p=> p.buyIns*buyInAmount)));
    const cashSum = round2(sum(adjusted.map(p=> p.baseCash)));
    const diff = round2(cashSum - buyInSum);
    return { list: adjusted, buyInSum, cashSum, diff };
  }, [players, buyInAmount, applyPerHead, perHeadAmount]);

  const update = (u)=> setPlayers(ps=> u?._remove ? ps.filter(p=>p.id!==u.id) : ps.map(p=>p.id===u.id?u:p));
  const addPlayer=()=>setPlayers(ps=>[...ps,blank()]);
  const start=()=> setPlayers(ps=> ps.map(p=>({...p, buyIns:0, cashOut:0})));
  const reset=()=> setPlayers([blank(),blank()]);
  function autoBalance(){ const {list,diff}=totals; if(!list.length||Math.abs(diff)<0.01) return;
    const top=[...list].sort((a,b)=>b.net-a.net)[0];
    setPlayers(ps=>ps.map(p=>p.id===top.id?{...p,cashOut:round2((p.cashOut||0) - diff)}:p));
  }
  function saveGame(){
    if (Math.abs(totals.diff) > 0.01 && !overrideMismatch) { alert("Totals don’t match. Enable override to save."); return; }
    const g={ id:uid(), stamp:new Date().toISOString(),
      players: totals.list.map(p=>({name:p.name||"Player",buyIns:p.buyIns,buyInTotal:round2(p.buyIns*buyInAmount),cashOut:p.baseCash,net:p.net})),
      totals:{buyIns:totals.buyInSum,cashOuts:totals.cashSum,diff:totals.diff},
    };
    setHistory(h=>[g,...h]);
    alert("Saved to history!");
  }

  const GameSectionDesktop = () => (
    <div className="surface table-desktop" style={{marginTop:12}}>
      <div className="header">
        <div className="toolbar">
          <button className="btn primary" onClick={start}>Start New Game</button>
          <button className="btn secondary" onClick={addPlayer}>Add Player</button>
          <button className="btn danger" onClick={reset}>Reset Players</button>
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
            {players.map(p => (<PlayerRow key={p.id} p={p} onChange={update} buyInAmount={buyInAmount} />))}
          </tbody>
          <tfoot><tr>
            <th>Total</th>
            <th className="center mono">A${totals.buyInSum.toFixed(2)}</th>
            <th className="center mono">A${totals.cashSum.toFixed(2)}</th>
            <th className="center mono">{totals.diff.toFixed(2)}</th>
            <th className="center">
              <button className="btn secondary" onClick={autoBalance}>Auto-Balance</button>
            </th>
          </tr></tfoot>
        </table>
      </div>

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:10}}>
        <label className="inline"><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} /> Override mismatch</label>
        <button className="btn success" onClick={saveGame}>End Game & Save</button>
      </div>
    </div>
  );

  const GameSectionMobile = () => (
    <div className="surface player-card" style={{marginTop:12}}>
      <div className="toolbar">
        <button className="btn primary" onClick={start}>Start</button>
        <button className="btn secondary" onClick={addPlayer}>Add</button>
        <button className="btn danger" onClick={reset}>Reset</button>
      </div>
      <hr className="hair" />
      {players.map(p => (
        <div key={p.id} className="player-row">
          <div className="full"><input className="name" value={p.name} onChange={e=>update({...p, name:e.target.value})} placeholder="Name" type="text" /></div>
          <div className="qty">
            <button className="btn secondary" onClick={()=>update({...p,buyIns:Math.max(0,p.buyIns-1)})}>–</button>
            <input className="small mono" type="number" min="0" step="1" value={p.buyIns} onChange={e=>update({...p,buyIns:Math.max(0,parseInt(e.target.value||0))})} />
            <button className="btn secondary" onClick={()=>update({...p,buyIns:p.buyIns+1})}>+</button>
          </div>
          <div className="cashout">
            <input className="small mono" type="number" min="0" step="0.01" value={p.cashOut||0} onChange={e=>update({...p,cashOut:parseFloat(e.target.value||0)})} />
            <div className="hint">cash-out</div>
          </div>
          <div className="full netblock">
            <div className="value">{((p.cashOut||0) - p.buyIns*buyInAmount).toFixed(2)}</div>
            <div className="label">Net</div>
          </div>
          <div className="full" style={{display:'flex',justifyContent:'flex-end'}}>
            <button className="btn danger" onClick={()=>update({...p,_remove:true})}>Remove</button>
          </div>
        </div>
      ))}

      <div className="totals-bar">
        <div className="item"><span className="label">Buy-ins</span><span className="value">A${totals.buyInSum.toFixed(2)}</span></div>
        <div className="item"><span className="label">Cash-outs</span><span className="value">A${totals.cashSum.toFixed(2)}</span></div>
        <div className="item"><span className="label">Net</span><span className="value">{totals.diff>=0?'+':''}{totals.diff.toFixed(2)}</span></div>
      </div>

      <div className="toolbar" style={{justifyContent:'space-between', marginTop:8}}>
        <label className="inline"><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} /> Override mismatch</label>
        <button className="btn success" onClick={saveGame}>End & Save</button>
      </div>
    </div>
  );

  const HistorySection = () => (
    <div className="surface" style={{marginTop:12}}>
      <div className="header"><strong>Game Overview (History)</strong></div>
      <div className="table-wrapper table-desktop">
        <table className="table">
          <thead><tr><th>When</th><th>Players (with net)</th><th className="center">Tot Buy-ins</th><th className="center">Tot Cash-outs</th><th className="center">Diff</th></tr></thead>
          <tbody>{history.length===0 ? (<tr><td colSpan="5" className="center meta">No games yet.</td></tr>) : history.map(g=>{
            return (<tr key={g.id}>
              <td className="mono">{new Date(g.stamp).toLocaleString()}</td>
              <td className="meta">{g.players.map(pp=>`${pp.name} (${pp.net>=0?'+':''}${pp.net.toFixed(2)})`).join(' · ')}</td>
              <td className="center mono">{aud(g.totals.buyIns)}</td>
              <td className="center mono">{aud(g.totals.cashOuts)}</td>
              <td className="center mono">{aud(g.totals.diff)}</td>
            </tr>);
          })}</tbody>
        </table>
      </div>
      <div className="player-card">
        {history.length===0 ? <div className="meta">No games yet.</div> :
          history.map(g=>(
            <div key={g.id} style={{border:'1px dashed var(--border)',borderRadius:12,padding:10,marginTop:8}}>
              <div className="mono">{new Date(g.stamp).toLocaleString()}</div>
              <div className="meta">BI {aud(g.totals.buyIns)} · CO {aud(g.totals.cashOuts)} · Diff {aud(g.totals.diff)}</div>
            </div>
          ))
        }
      </div>
    </div>
  );

  return (
    <div>
      <div className="topbar">
        <button className="hamburger" onClick={()=>setDrawerOpen(true)}>☰</button>
        <div className="brand"><h1>PocketPoker</h1><span className="badge">Local</span></div>
      </div>

      {/* Drawer */}
      <div className={"drawer-backdrop"+(drawerOpen?" open":"")} onClick={()=>setDrawerOpen(false)} />
      <aside className={"drawer"+(drawerOpen?" open":"")}>
        <strong>Navigate</strong>
        <div className="navgroup">
          {["game","history"].map(id => (
            <button key={id} className={"tabbtn"+(tab===id?" active":"")} onClick={()=>{ setTab(id); setDrawerOpen(false); }}>
              {id[0].toUpperCase()+id.slice(1)}
            </button>
          ))}
        </div>
      </aside>

      <div className="spacer" />

      <div className="container">
        <div className="meta">Next Friday in <b>{days}d {hrs}h {mins}m {secs}s</b> — get your $20 ready.</div>
        {tab==='game' && (<><GameSectionDesktop /><GameSectionMobile /></>)}
        {tab==='history' && <HistorySection />}
      </div>
    </div>
  );
}
