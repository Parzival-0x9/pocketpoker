// Phase 2a: Prize from pot (A$ per non-winner) + deterministic equal-split by default
// - NEW: Winner(s) receive prize funded from the pot: each non-winner contributes A$amount.
// - Ties: pool is split equally among tied top winners (last winner gets rounding cent).
// - Keeps Phase 1 settlement modes, but DEFAULT = "equalSplit" to avoid misclicks.
// - Removes per-head side-payment for NEW games (old history is still rendered if present).
// - Compact mobile layout preserved (tabs + drawer).

import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./components/PlayerRow.jsx";
import { aud, sum, round2, settle, toCSV } from "./lib/calc.js";

const DEFAULT_BUYIN=50, DEFAULT_PRIZE=20, uid=()=>Math.random().toString(36).slice(2,9);
const blank=()=>({id:uid(),name:"",buyIns:0,cashOut:0}), LS="pocketpoker_state", THEME="pp_theme", FELT="pp_felt", PROFILES="pp_profiles";
const load=()=>{try{const r=localStorage.getItem(LS);return r?JSON.parse(r):null}catch{return null}};
const save=(s)=>{try{localStorage.setItem(LS,JSON.stringify(s))}catch{}};

// === Deterministic equal-split per-loser (cap & redistribute) ===
// Fixed ordering so results are identical across devices:
// - Losers processed by loss DESC, tie-break by name A→Z.
// - Winners considered by name A→Z.
// - The last eligible winner (in that fixed order) gets the rounding cent.
function settleEqualSplitCapped(rows){
  const winnersBase = rows
    .filter(r=> r.net > 0.0001)
    .map(r=>({ name: (r.name||"Player"), need: round2(r.net) }));
  const losersBase  = rows
    .filter(r=> r.net < -0.0001)
    .map(r=>({ name: (r.name||"Player"), loss: round2(-r.net) }));

  const txns = [];
  if (!winnersBase.length || !losersBase.length) return txns;

  const winnersOrder = [...winnersBase].sort((a,b)=> a.name.localeCompare(b.name)); // winners A→Z
  const losersSorted = [...losersBase].sort((a,b)=> (b.loss - a.loss) || a.name.localeCompare(b.name)); // biggest loss first

  const getEligible = () => winnersOrder.filter(w => w.need > 0.0001);

  losersSorted.forEach(L => {
    let remaining = round2(L.loss);
    while (remaining > 0.0001) {
      const eligible = getEligible();
      if (!eligible.length) break;

      const equalRaw = remaining / eligible.length;
      let distributed = 0;

      for (let i = 0; i < eligible.length; i++) {
        const w = eligible[i];
        const isLast = i === eligible.length - 1;
        const shareTarget = Math.min(equalRaw, w.need);
        let give = isLast ? round2(remaining - distributed) : round2(shareTarget);

        // Clamp after rounding to avoid overpayment
        give = Math.min(give, round2(w.need), round2(remaining - distributed));

        if (give > 0.0001) {
          txns.push({ from: L.name, to: w.name, amount: round2(give) });
          w.need = round2(w.need - give);
          distributed = round2(distributed + give);
        }
      }

      remaining = round2(remaining - distributed);
      if (distributed <= 0.0001) break; // safety
    }
  });

  return txns;
}
// === END deterministic equal-split ===

export default function App(){
  const [players,setPlayers]=useState([blank(),blank()]);
  const [buyInAmount,setBuyInAmount]=useState(DEFAULT_BUYIN);

  // Phase 2a: Prize from pot (default ON @ A$20)
  const [prizeFromPot,setPrizeFromPot]=useState(true);
  const [prizeAmount,setPrizeAmount]=useState(DEFAULT_PRIZE);

  // Settlement mode (DEFAULT equalSplit to avoid misclicks)
  const [settlementMode, setSettlementMode] = useState("equalSplit");

  const [history,setHistory]=useState([]);
  const [started,setStarted]=useState(false);
  const [overrideMismatch,setOverrideMismatch]=useState(false);
  const [theme,setTheme]=useState(()=>localStorage.getItem(THEME) || "dark");
  const [felt,setFelt]=useState(()=>localStorage.getItem(FELT) || "emerald");
  const [expanded,setExpanded]=useState({});
  const [ledgerExpanded,setLedgerExpanded]=useState({});
  const [profiles,setProfiles]=useState(()=>{ try{ return JSON.parse(localStorage.getItem(PROFILES)) || {}; } catch { return {}; } });

  // Compact mobile: tabs + drawer
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tab, setTab] = useState(()=> localStorage.getItem("pp_tab") || "game");
  useEffect(()=>{ localStorage.setItem("pp_tab", tab); }, [tab]);

  // Load
  useEffect(()=>{ 
    const s=load();
    if(s){
      setPlayers(s.players?.length?s.players:[blank(),blank()]);
      setBuyInAmount(s.buyInAmount ?? DEFAULT_BUYIN);

      // Prefer Phase 2a fields if present; otherwise set defaults
      setPrizeFromPot( typeof s.prizeFromPot === "boolean" ? s.prizeFromPot : true );
      setPrizeAmount( typeof s.prizeAmount === "number" ? s.prizeAmount : DEFAULT_PRIZE );

      // DEFAULT to equalSplit when absent/unknown
      const mode = s.settlementMode;
      setSettlementMode( mode === "proportional" || mode === "equalSplit" ? mode : "equalSplit" );

      setHistory(s.history ?? []);
      setStarted(!!s.started);
    }
  },[]);
  useEffect(()=>{ 
    save({players,buyInAmount,prizeFromPot,prizeAmount,history,started,settlementMode});
  }, [players,buyInAmount,prizeFromPot,prizeAmount,history,started,settlementMode]);

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

  const totals=useMemo(()=>{
    // Base nets from buy-ins and raw cash-outs
    const base=players.map(p=>({...p, buyInTotal:round2(p.buyIns*buyInAmount), baseCash:p.cashOut }));
    const withNet=base.map(p=>({...p, net: round2(p.baseCash - p.buyIns*buyInAmount)}));

    // Prize from pot (Phase 2a): apply to cashOutAdj / netAdj
    let adjusted = withNet.map(p=>({...p, prize:0, cashOutAdj:round2(p.baseCash), netAdj: round2(p.baseCash - p.buyIns*buyInAmount)}));

    if (prizeFromPot && players.length>=2) {
      // Find top winners (ties supported)
      const topNet = Math.max(...withNet.map(p=>p.net));
      const winners = withNet.filter(p=> Math.abs(p.net - topNet) < 0.0001);
      const T = winners.length;
      const nonWinners = withNet.filter(p=> Math.abs(p.net - topNet) >= 0.0001);
      const pool = round2(prizeAmount * nonWinners.length);

      if (T>0 && pool>0.0001) {
        const per = round2(pool / T);
        let distributed = 0;

        // winners: +pool split
        let idx=0;
        adjusted = adjusted.map(p=>{
          if (Math.abs(p.net - topNet) < 0.0001) {
            const isLast = (idx === T-1);
            const give = isLast ? round2(pool - distributed) : per;
            distributed = round2(distributed + give);
            const cash = round2(p.baseCash + give);
            idx++;
            return {...p, prize: give, cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount)};
          }
          return p;
        });

        // non-winners: -prizeAmount each
        adjusted = adjusted.map(p=>{
          if (Math.abs(p.net - topNet) >= 0.0001) {
            const cash = round2(p.baseCash - prizeAmount);
            return {...p, prize: -prizeAmount, cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount)};
          }
          return p;
        });
      }
    }

    const buyInSum = round2(sum(adjusted.map(p=> p.buyInTotal)));
    const cashAdjSum = round2(sum(adjusted.map(p=> p.cashOutAdj)));
    const diff = round2(cashAdjSum - buyInSum);

    // Settlement (DEFAULT equalSplit)
    const basis = adjusted.map(p=>({ name: p.name || "Player", net: p.netAdj }));
    const txns = settlementMode === "equalSplit"
      ? settleEqualSplitCapped(basis)
      : settle(basis); // proportional (legacy)

    const sorted = [...adjusted].sort((a,b)=>b.netAdj-a.netAdj);
    const top = sorted.length ? sorted[0] : null;

    return { adjusted, buyInSum, cashAdjSum, diff, txns, top };
  }, [players, buyInAmount, prizeFromPot, prizeAmount, settlementMode]);

  function updatePlayer(u){ setPlayers(ps=> u?._remove ? ps.filter(p=>p.id!==u.id) : ps.map(p=>p.id===u.id?u:p)); }
  const addPlayer=()=>setPlayers(ps=>[...ps,blank()]);
  const startGame=()=>{ setPlayers(ps=>ps.map(p=>({ ...p, buyIns:0, cashOut:0 }))); setStarted(true); setOverrideMismatch(false); };
  const resetGame=()=>{ setPlayers([blank(),blank()]); setStarted(false); setOverrideMismatch(false); };

  function saveGameToHistory(){
    const stamp = new Date().toISOString();
    const g={ id:uid(), stamp,
      settings:{
        buyInAmount,
        prize: prizeFromPot ? { mode:'pot', amount: prizeAmount } : { mode:'none', amount: 0 },
        settlement: { mode: settlementMode }
      },
      players: totals.adjusted.map(p=>({
        name:p.name||"Player",buyIns:p.buyIns,buyInTotal:p.buyInTotal,
        cashOut:p.cashOutAdj,prize:p.prize,net:p.netAdj
      })),
      totals:{buyIns:totals.buyInSum,cashOuts:totals.cashAdjSum,diff:totals.diff},
      txns: totals.txns
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

  // CSV export
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
    history.forEach(g=> (g.txns||[]).forEach(t=> r2.push([g.id, g.stamp, t.from, t.to, t.amount])));
    downloadCSV("transfers.csv", r2);

    // Legacy per-head only for old games (if present)
    const r3 = [["game_id","stamp","winner","payer","amount","paid","method","paid_at","due"]];
    history.forEach(g=>{
      if(!g.perHead) return;
      g.perHead.payers.forEach(name=>{
        const rec = g.perHead.payments?.[name] || {paid:false,method:null,paidAt:null};
        r3.push([g.id, g.stamp, g.perHead.winner, name, g.perHead.amount, rec.paid, rec.method, rec.paidAt, g.perHead.due]);
      });
    });
    if (r3.length>1) downloadCSV("perhead_legacy.csv", r3);
  }

  // Suggested names
  const knownNames = useMemo(()=>{
    const set = new Set();
    players.forEach(p=> p.name && set.add(p.name));
    history.forEach(g=> g.players.forEach(p=> p.name && set.add(p.name)));
    return Array.from(set).sort();
  }, [players, history]);

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

  // --- Sections ---
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
          <span className="meta">per non-winner (split among top winner(s))</span>
        </div>
        {/* Settlement mode */}
        <div className="toggles toolbar" style={{marginTop:8}}>
          <label className="inline">
            Settlement
            <select value={settlementMode} onChange={e=>setSettlementMode(e.target.value)}>
              <option value="equalSplit">Equal-split per loser (default)</option>
              <option value="proportional">Proportional (legacy)</option>
            </select>
          </label>
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
          <button className="btn danger" onClick={clearHistory}>Delete All</button>
        </div>
      </div>
      <div className="meta">Tap details to see prize-from-pot and settlement transfers.</div>
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
            const prizeNote = (()=>{
              const pm = g.settings?.prize?.mode;
              if (pm === 'pot') {
                const amt = g.settings?.prize?.amount ?? 0;
                const topNet = Math.max(...g.players.map(p=>p.net));
                const T = g.players.filter(p=> Math.abs(p.net - topNet) < 0.0001).length;
                const N = g.players.length;
                const pool = amt * Math.max(0, N - T);
                return `Prize from pot: A$${amt} × ${Math.max(0,N-T)} = A$${pool.toFixed(2)} split among top ${T}`;
              } else if (g.perHead) {
                return `Legacy per-head: A$${g.perHead.amount} owed to ${g.perHead.winner}`;
              }
              return null;
            })();
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
                        {prizeNote && <div className="meta" style={{marginBottom:8}}>{prizeNote}</div>}
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

                        {/* Legacy per-head section only for old games that still have it */}
                        {g.perHead && (
                          <div>
                            <div style={{height:8}} />
                            <strong>Legacy per-head payments</strong> <span className="meta">Winner: {g.perHead.winner} • Due: {new Date(g.perHead.due).toLocaleString()}</span>
                            <table className="table">
                              <thead><tr><th>Payer</th><th className="center">Method</th><th className="center">Status</th><th className="center">Paid at</th><th className="center">PayID</th></tr></thead>
                              <tbody>
                                {g.perHead.payers.map(name=>{
                                  const rec = g.perHead.payments?.[name] || {paid:false,method:null,paidAt:null};
                                  const overdue = !rec.paid && (Date.now() > new Date(g.perHead.due).getTime());
                                  return (
                                    <tr key={name}>
                                      <td>{name}</td>
                                      <td className="center">{rec.method || '—'}</td>
                                      <td className="center">{rec.paid ? <span className="pill">Paid</span> : <span className="pill">Unpaid</span>}{overdue && <div className="meta">⚠️ overdue</div>}</td>
                                      <td className="center mono">{rec.paidAt ? new Date(rec.paidAt).toLocaleString() : '—'}</td>
                                      <td className="center">{profiles[name]?.payid ? <span className="pill">has PayID</span> : <span className="meta">—</span>}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div style={{height:8}} />
                        <strong>Transfers for settlement</strong> <span className="meta">Mode: {g.settings?.settlement?.mode === 'equalSplit' ? 'Equal-split per loser' : 'Proportional (legacy)'}</span>
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
    </div>
  );

  const LedgersSection = (
    <div className="surface">
      <h3 style={{marginTop:0}}>Player Ledgers (Cumulative)</h3>
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
                <td><input type="text" value={v} onChange={e=>setProfiles(p=>({...p,[n]:{payid:e.target.value}}))} placeholder="email/phone PayID" /></td>
                <td className="center">{v ? <button className="btn secondary" onClick={()=>{
                  if(navigator.clipboard && window.isSecureContext){
                    navigator.clipboard.writeText(v); alert('PayID copied for '+n);
                  } else {
                    const area=document.createElement('textarea'); area.value=v; document.body.appendChild(area); area.select();
                    document.execCommand('copy'); area.remove(); alert('PayID copied for '+n);
                  }
                }}>Copy</button> : <span className="meta">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {/* Topbar */}
      <div className="pp-topbar">
        <button className="pp-burger" onClick={()=>setSidebarOpen(true)}>☰</button>
        <div className="brand">
          <h1>PocketPoker</h1>
          <span className="badge">Local</span>
        </div>
      </div>

      {/* Drawer */}
      <div className={"pp-drawer " + (sidebarOpen?'open':'')}>
        <div className="title-badge" style={{justifyContent:'space-between', width:'100%'}}>
          <strong>Menu</strong>
          <button className="pp-burger" onClick={()=>setSidebarOpen(false)}>✕</button>
        </div>
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
        {/* No per-head countdown banner in Phase 2a */}

        {tab==="game" && GameSection}
        {tab==="history" && HistorySection}
        {tab==="ledgers" && LedgersSection}
        {tab==="profiles" && ProfilesSection}

        {/* Bottom tabbar for quick nav on mobile */}
        <div className="tabbar">
          <button className={"btn " + (tab==='game'?'primary':'secondary')} onClick={()=>setTab('game')}>Game</button>
          <button className={"btn " + (tab==='history'?'primary':'secondary')} onClick={()=>setTab('history')}>History</button>
          <button className={"btn " + (tab==='ledgers'?'primary':'secondary')} onClick={()=>setTab('ledgers')}>Ledgers</button>
          <button className={"btn " + (tab==='profiles'?'primary':'secondary')} onClick={()=>setTab('profiles')}>Profiles</button>
        </div>

        <div className="footer meta">Tip: “Start New” keeps players, zeroes amounts. Prize is funded from the pot.</div>
      </div>
    </>
  );
}
