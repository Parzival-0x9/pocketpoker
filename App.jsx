
import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./components/PlayerRow.jsx";
import { aud, sum, round2, settle, nextFridayISO, toCSV } from "./lib/calc.js";

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
  const [theme,setTheme]=useState(()=>localStorage.getItem(THEME) || "dark");
  const [felt,setFelt]=useState(()=>localStorage.getItem(FELT) || "emerald");
  const [expanded,setExpanded]=useState({});
  const [ledgerExpanded,setLedgerExpanded]=useState({});
  const [profiles,setProfiles]=useState(()=>{ try{ return JSON.parse(localStorage.getItem(PROFILES)) || {}; } catch { return {}; } });
  const [celebrated, setCelebrated] = useState(new Set());

  const [tab, setTab] = useState(()=> localStorage.getItem('pp_tab') || 'game');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const tabs = [
    { id:'game', label:'Game' },
    { id:'history', label:'History' },
    { id:'ledgers', label:'Ledgers' },
    { id:'profiles', label:'Profiles' },
  ];
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

  const knownNames = useMemo(()=>{
    const set = new Set();
    players.forEach(p=> p.name && set.add(p.name));
    history.forEach(g=> g.players.forEach(p=> p.name && set.add(p.name)));
    return Array.from(set).sort();
  }, [players, history]);

  const GameSection = () => (
    <div className="surface" style={{marginTop:12}}>
      <div className="controls">
        <div className="stack">
          <button className="btn primary" onClick={startGame}>Start New Game</button>
          <button className="btn secondary" onClick={addPlayer}>Add Player</button>
          <button className="btn danger" onClick={resetGame}>Reset Players</button>
          <span className="pill">🎯 Enter cash-outs at the end.</span>
        </div>
        <div className="toggles toolbar">
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

      <hr className="hair" />

      <div className="table-wrapper">
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
      </div>

      {Math.abs(totals.diff) > 0.01 ? (
        <div className="header" style={{marginTop:10}}>
          <div className="ribbon">⚠️ Off by {aud(totals.diff)}. Use Auto-Balance or tick Override.</div>
          <div className="toolbar">
            <button className="btn secondary" onClick={autoBalance}>Auto-Balance</button>
            <label className="inline"><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} /> Override & Save Anyway</label>
          </div>
        </div>
      ) : (
        <div className="header" style={{marginTop:10}}>
          <div className="ribbon">✅ Balanced: totals match.</div>
          <div className="toolbar"></div>
        </div>
      )}

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:10}}>
        <button className="btn success" onClick={saveGameToHistory} disabled={Math.abs(totals.diff) > 0.01 && !overrideMismatch}>End Game & Save</button>
      </div>
    </div>
  );

  const HistorySection = () => (
    <div className="surface">
      <div className="header" style={{marginBottom:0}}>
        <h3 style={{margin:0}}>Game Overview (History)</h3>
        <div className="toolbar">
          <button className="btn secondary" onClick={exportSeason}>Export CSVs</button>
          <button className="btn danger" onClick={clearHistory}>Delete All History</button>
        </div>
      </div>
      <div className="meta">Click details to see full results, winner per-head payments, and settlement transfers.</div>
      <div className="table-wrapper">
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
                        <button className="btn danger" onClick={()=>deleteGame(g.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                  {expanded[key] && (
                    <tr>
                      <td colSpan="6">
                        <div className="detail">
                          <strong>Per-player results</strong>
                          <div className="table-wrapper">
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
                          </div>

                          {g.perHead && (
                            <div>
                              <div style={{height:8}} />
                              <strong>Winner's A${g.perHead.amount} per-head payments</strong> <span className="meta">Winner: {g.perHead.winner} • Due: {new Date(g.perHead.due).toLocaleString()}</span>
                              <div className="table-wrapper">
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
                                            <select value={rec.method||""} onChange={e=>setPerHeadMethod(g.id,name,e.target.value||null)}>
                                              <option value="">—</option>
                                              <option value="cash">Cash</option>
                                              <option value="payid">PayID</option>
                                            </select>
                                          </td>
                                          <td className="center">
                                            {rec.paid ? <span className="pill">Paid</span> :
                                              <button className="btn success" onClick={()=>markPerHeadPaid(g.id,name,rec.method||'cash')}>Mark paid</button>}
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
                            </div>
                          )}

                          <div style={{height:8}} />
                          <strong>Transfers for settlement</strong>
                          <div className="table-wrapper">
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
    </div>
  );

  const LedgersSection = () => (
    <div className="surface">
      <h3 style={{marginTop:0}}>Player Ledgers (Cumulative)</h3>
      <div className="meta">Clean + collapsible. Click Show to reveal who they owe / who owes them.</div>
      <div className="table-wrapper">
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
                          <div className="table-wrapper">
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
                          </div>
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
    </div>
  );

  const ProfilesSection = () => (
    <div className="surface">
      <div className="header"><h3 style={{margin:0}}>Players & Profiles</h3></div>
      <div className="meta">Add optional PayIDs so it’s one tap to copy during payouts.</div>
      <div className="table-wrapper">
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
                  <td><input type="text" value={v} onChange={e=>setProfiles(p=>({...p,[n]:{payid:e.target.value}}))} placeholder="email/phone PayID" /></td>
                  <td className="center">{v ? <button className="btn secondary" onClick={()=>copyPayID(n)}>Copy</button> : <span className="meta">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <div className="topbar">
        <button className="hamburger" onClick={()=>setDrawerOpen(true)}>☰</button>
        <div className="brand">
          <h1>PocketPoker</h1>
          <span className="badge">Local</span>
        </div>
        <div className="top-tabs">
          {tabs.map(t=>(
            <button key={t.id} className={"tabbtn"+(tab===t.id?" active":"")} onClick={()=>setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div className="toolbar" style={{marginLeft:'auto'}}>
          <div className="switch">
            <button className={theme==='dark' ? 'active' : 'ghost'} onClick={()=>setTheme('dark')}>🌙</button>
            <button className={theme==='light' ? 'active' : 'ghost'} onClick={()=>setTheme('light')}>☀️</button>
          </div>
          <div className="switch">
            <button className={felt==='emerald' ? 'active' : 'ghost'} onClick={()=>setFelt('emerald')}>💚</button>
            <button className={felt==='midnight' ? 'active' : 'ghost'} onClick={()=>setFelt('midnight')}>🌌</button>
          </div>
        </div>
      </div>
      <div className={"drawer-backdrop"+(drawerOpen?" open":"")} onClick={()=>setDrawerOpen(false)} />
      <div className={"drawer"+(drawerOpen?" open":"")}>
        <div className="title-badge" style={{marginBottom:10}}>
          <strong>Navigate</strong>
        </div>
        <div className="navgroup">
          {tabs.map(t=>(
            <button key={t.id} className={"tabbtn"+(tab===t.id?" active":"")} onClick={()=>{setTab(t.id); setDrawerOpen(false);}}>{t.label}</button>
          ))}
        </div>
        <div style={{height:10}} />
        <div className="title-badge"><strong>Appearance</strong></div>
        <div style={{height:6}} />
        <div className="navgroup">
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

      <div className="spacer" />

      <div className="container">
        <div className="kicker">Next Friday at 5pm in <strong>{days}d {hrs}h {mins}m {secs}s</strong> — get your $20 ready. 🪙</div>

        {alerts.length>0 && (
          <div className="surface" style={{marginTop:12}}>
            {alerts.map(a=> (
              <div key={a.id} className="alert" style={{marginBottom:8}}>
                Unpaid A${a.amount} per-head — winner <strong>{a.winner}</strong>, due <strong>{new Date(a.due).toLocaleString()}</strong>. Unpaid: {a.unpaid.join(', ')}.
              </div>
            ))}
          </div>
        )}

        {tab==='game' && <GameSection />}
        {tab==='history' && <HistorySection />}
        {tab==='ledgers' && <LedgersSection />}
        {tab==='profiles' && <ProfilesSection />}

        <div className="footer meta">Tip: Use ☰ to switch sections on mobile. Tables scroll sideways inside their cards.</div>
      </div>
    </div>
  );
}
