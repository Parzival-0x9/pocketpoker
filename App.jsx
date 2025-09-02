
import React, { useEffect, useMemo, useState } from "react";

/**
 * PocketPoker App.jsx — Tabbed UI + Enhancements
 * Tabs: Game | History | Profiles
 * Enhancements:
 *  - Equal-split settlement (default, deterministic)
 *  - Prize-from-pot (A$20 from initial buy-in)
 *  - Cloud season storage (get/append/delete)
 *  - Host lock (lock/unlock) + read-only overlay
 *  - Per-transfer "Paid?" toggle; winners chips show received/needed
 *  - Profiles (PayID + avatar) used in History + Transfers
 *  - CSV exports
 *  - Sync status header + manual refresh
 *  - Validation before save; override mismatch option
 */

// ===== Small utils =====
const uid = () => Math.random().toString(36).slice(2, 9);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const aud = (v) => `A$${Number(v || 0).toFixed(2)}`;

// ===== CSV helper =====
function downloadCSV(filename, rows) {
  const csv = rows
    .map(r => r.map(v => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ===== Settlement: equal-split per loser (with per-winner cap) =====
function settleEqualSplitCapped(rows) {
  const winnersBase = rows.filter(r => r.net > 0.0001).map(r => ({ name: (r.name || "Player"), need: round2(r.net) }));
  const losersBase  = rows.filter(r => r.net < -0.0001).map(r => ({ name: (r.name || "Player"), loss: round2(-r.net) }));
  const txns = [];
  if (!winnersBase.length || !losersBase.length) return txns;

  // Deterministic order: winners alphabetical; losers by larger loss first then alpha
  const winnersOrder = [...winnersBase].sort((a,b)=> a.name.localeCompare(b.name));
  const losersSorted = [...losersBase].sort((a,b)=> (b.loss - a.loss) || a.name.localeCompare(b.name));

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

// ===== Prize-from-pot application =====
function applyPrizeFromPot(base, buyInAmount, prizeAmount) {
  const withNet = base.map(p => ({ ...p, net: round2(p.baseCash - p.buyIns*buyInAmount) }));
  const N = withNet.length;
  if (N < 2) return withNet.map(p => ({
    ...p, prize: 0, cashOutAdj: round2(p.baseCash), netAdj: round2(p.baseCash - p.buyIns*buyInAmount)
  }));

  const topNet = Math.max(...withNet.map(p => p.net));
  const winners = withNet.filter(p => Math.abs(p.net - topNet) < 0.0001);
  const T = winners.length;
  const pool = round2(Number(prizeAmount || 0) * N);
  const perWinner = T>0 ? round2(pool / T) : 0;

  // Everyone contributes prizeAmount
  let adjusted = withNet.map(p => {
    const cash = round2(p.baseCash - prizeAmount);
    return { ...p, prize: round2(-prizeAmount), cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount) };
  });

  // Give pool to top winner(s)
  let distributed = 0, idx = 0;
  const winnersSet = new Set(winners.map(w => w.name));
  adjusted = adjusted.map(p => {
    if (!winnersSet.has(p.name)) return p;
    const isLast = (++idx) === T;
    const give = isLast ? round2(pool - distributed) : perWinner;
    distributed = round2(distributed + give);
    const cash = round2(p.cashOutAdj + give);
    return { ...p, prize: round2(p.prize + give), cashOutAdj: cash, netAdj: round2(cash - p.buyIns*buyInAmount) };
  });
  return adjusted;
}

// ===== Cloud constants & identity =====
const API_BASE = ""; // same-origin
const SEASON_ID = (import.meta?.env?.VITE_SEASON_ID) || "default";
const DEVICE_ID_KEY = "pp_device_id";
const DEVICE_NAME_KEY = "pp_device_name";
function ensureDeviceId(){
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = (crypto.randomUUID?.() || uid()); localStorage.setItem(DEVICE_ID_KEY, id); }
  return id;
}
function getDeviceName(){ return localStorage.getItem(DEVICE_NAME_KEY) || ""; }
function setDeviceNameLS(n){ localStorage.setItem(DEVICE_NAME_KEY, n || ""); }

// ===== Cloud API helpers =====
async function apiGetSeason(){
  const res = await fetch(`${API_BASE}/api/season/get?id=${encodeURIComponent(SEASON_ID)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiAppendGame(game, version, deviceId, deviceName){
  const headers = { "Content-Type":"application/json", "If-Match": String(version), "X-Client-Id": deviceId, "X-Client-Name": deviceName || "Unknown" };
  let res = await fetch(`${API_BASE}/api/season/append-game`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, game }) });
  if (res.status === 409) {
    const latest = await apiGetSeason();
    res = await fetch(`${API_BASE}/api/season/append-game`, { method:"POST", headers:{...headers,"If-Match":String(latest.version||0)}, body: JSON.stringify({ seasonId: SEASON_ID, game }) });
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiDeleteGame(gameId, version, deviceId, deviceName){
  const headers = { "Content-Type":"application/json", "If-Match": String(version), "X-Client-Id": deviceId, "X-Client-Name": deviceName || "Unknown" };
  let res = await fetch(`${API_BASE}/api/season/delete-game`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, gameId }) });
  if (res.status === 409) {
    const latest = await apiGetSeason();
    res = await fetch(`${API_BASE}/api/season/delete-game`, { method:"POST", headers:{...headers,"If-Match":String(latest.version||0)}, body: JSON.stringify({ seasonId: SEASON_ID, gameId }) });
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiLock(action, byName, deviceId){
  const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": byName || "Unknown" };
  const res = await fetch(`${API_BASE}/api/season/lock`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, action, byName, deviceId }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiMarkPayment(gameId, idx, paid, deviceId, deviceName){
  const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": deviceName || "Unknown" };
  const res = await fetch(`${API_BASE}/api/season/mark-payment`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, gameId, idx, paid }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiProfileUpsert(name, fields, deviceId, deviceName){
  const headers = { "Content-Type":"application/json", "X-Client-Id": deviceId, "X-Client-Name": deviceName || "Unknown" };
  const res = await fetch(`${API_BASE}/api/season/profile-upsert`, { method:"POST", headers, body: JSON.stringify({ seasonId: SEASON_ID, name, ...fields }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ===== Main App =====
export default function App(){
  // Tabs
  const [tab, setTab] = useState("game"); // game | history | profiles

  // Game inputs
  const [players, setPlayers] = useState([
    { id: uid(), name: "", buyIns: 0, cashOut: 0 },
    { id: uid(), name: "", buyIns: 0, cashOut: 0 },
  ]);
  const [buyInAmount, setBuyInAmount] = useState(50);
  const [prizeFromPot, setPrizeFromPot] = useState(true);
  const [prizeAmount, setPrizeAmount] = useState(20);
  const [settlementMode, setSettlementMode] = useState("equalSplit"); // default
  const [overrideMismatch, setOverrideMismatch] = useState(false);

  // Cloud state
  const [history, setHistory] = useState([]);
  const [cloudVersion, setCloudVersion] = useState(0);
  const [syncStatus, setSyncStatus] = useState("idle");
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lock, setLock] = useState(null); // { deviceId, byName, expiresAt }
  const [profiles, setProfiles] = useState({}); // { name: { payId, avatarDataUrl } }
  const [expanded, setExpanded] = useState({}); // gameId -> bool

  // Device identity
  const deviceId = ensureDeviceId();
  const [deviceName, setDeviceName] = useState(getDeviceName());
  useEffect(() => { setDeviceNameLS(deviceName); }, [deviceName]);

  // Computations
  const totals = useMemo(() => {
    const base = (players || []).map(p => ({
      id: p.id, name: p.name || "Player",
      buyIns: Number(p.buyIns || 0),
      cashOut: Number(p.cashOut || 0),
      buyInTotal: round2((Number(p.buyIns || 0)) * (Number(buyInAmount || 0))),
      baseCash: round2(Number(p.cashOut || 0))
    }));

    // Start with no prize adj
    let adjusted = base.map(p => ({
      name: p.name,
      buyIns: p.buyIns,
      buyInTotal: p.buyInTotal,
      prize: 0,
      cashOutAdj: p.baseCash,
      netAdj: round2(p.baseCash - p.buyIns*buyInAmount)
    }));

    if (prizeFromPot) {
      adjusted = applyPrizeFromPot(base, buyInAmount, prizeAmount);
    }

    const buyInSum = round2(sum(adjusted.map(p => p.buyInTotal)));
    const cashAdjSum = round2(sum(adjusted.map(p => p.cashOutAdj)));
    const diff = round2(cashAdjSum - buyInSum);

    // Settlement basis: After prize adjustment, remove prize component so losers don't overpay
    const basis = adjusted.map(p => ({ name: p.name, net: round2(p.netAdj - p.prize) }));
    const txns = settlementMode === "equalSplit" ? settleEqualSplitCapped(basis) : [];

    return { adjusted, buyInSum, cashAdjSum, diff, txns, prizePool: prizeFromPot ? round2(prizeAmount * adjusted.length) : 0 };
  }, [players, buyInAmount, prizeFromPot, prizeAmount, settlementMode]);

  // Locked by other?
  const lockedByOther = !!(lock && lock.deviceId && lock.deviceId !== deviceId && (new Date(lock.expiresAt) > new Date()));

  // Build payload
  function buildGame(){
    return {
      id: uid(),
      stamp: new Date().toISOString(),
      settings: {
        buyInAmount,
        prize: prizeFromPot ? { mode: "pot_all", amount: prizeAmount } : { mode: "none", amount: 0 },
        settlement: { mode: settlementMode }
      },
      players: totals.adjusted.map(p => ({
        name: p.name || "Player",
        buyIns: p.buyIns,
        buyInTotal: p.buyInTotal,
        cashOut: p.cashOutAdj,
        prize: p.prize,
        net: p.netAdj
      })),
      totals: { buyIns: totals.buyInSum, cashOuts: totals.cashAdjSum, diff: totals.diff },
      txns: totals.txns,
      savedBy: { deviceId, deviceName: deviceName || "Unknown" },
      overrideMismatch
    };
  }

  // Validation
  function validateBeforeSave(totalsObj){
    const errs = [];
    if ((players || []).length < 2) errs.push("At least two players.");
    const any = players.some(p => (p.buyIns||0) > 0 || (p.cashOut||0) > 0);
    if (!any) errs.push("No inputs entered.");
    if (Math.abs(totalsObj?.diff || 0) > 0.01 && !overrideMismatch) errs.push("Totals not balanced. Tick override to force.");
    return errs;
  }

  // Actions
  async function saveGame(){
    const g = buildGame();
    const errs = validateBeforeSave(g.totals);
    if (errs.length) { alert("Cannot save:\n- " + errs.join("\n- ")); return; }
    try{
      const out = await apiAppendGame(g, cloudVersion, deviceId, deviceName);
      setHistory(out.games || []); setCloudVersion(out.version || 0); setLock(out.lock || null); setProfiles(out.profiles || {});
      setTab("history");
    }catch(e){
      console.error(e);
      const msg = String(e.message||"").toLowerCase();
      if (msg.includes("429")) return alert("Too many saves. Please wait a moment.");
      if (msg.includes("locked")) return alert("Locked by host. Ask to unlock.");
      alert("Save failed.");
    }
  }
  async function removeGame(id){
    if (!confirm("Delete this game?")) return;
    try{
      const out = await apiDeleteGame(id, cloudVersion, deviceId, deviceName);
      setHistory(out.games || []); setCloudVersion(out.version || 0); setLock(out.lock || null);
    }catch(e){ console.error(e); alert("Delete failed."); }
  }
  async function togglePaid(g, idx){
    try{
      const out = await apiMarkPayment(g.id, idx, !g.txns[idx].paid, deviceId, deviceName);
      setHistory(out.games || []); setCloudVersion(out.version || 0);
    }catch(e){ console.error(e); alert("Payment toggle failed."); }
  }

  // Load + poll
  useEffect(() => { (async ()=>{
    try{
      setSyncStatus("syncing");
      const doc = await apiGetSeason();
      setHistory(doc.games || []); setCloudVersion(doc.version || 0); setLock(doc.lock || null); setProfiles(doc.profiles || {});
      setSyncStatus("upToDate"); setLastSyncAt(new Date());
    }catch(e){ console.error(e); setSyncStatus("error"); }
  })(); }, []);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try{
        const doc = await apiGetSeason();
        if ((doc.version || 0) !== cloudVersion) {
          setHistory(doc.games || []); setCloudVersion(doc.version || 0); setLock(doc.lock || null); setProfiles(doc.profiles || {});
        }
        setLastSyncAt(new Date());
        if (!dead) setTimeout(tick, document.hidden ? 30000 : 10000);
      }catch(e){
        if (!dead) setTimeout(tick, 30000);
      }
    };
    const t = setTimeout(tick, 10000);
    return () => { dead = true; clearTimeout(t); };
  }, [cloudVersion]);

  // --- UI containers ---
  const container = { padding: 12, maxWidth: 960, margin: "0 auto" };
  const card = { padding: 10, border: "1px solid #eee", borderRadius: 8 };

  return (
    <div style={container}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0 }}>PocketPoker</h2>
        <div style={{ fontSize: 13 }}>
          Sync: <strong>{syncStatus}</strong>{" "}
          <span style={{ fontFamily: "monospace" }}>v{cloudVersion}</span>
          {" "}{lastSyncAt && <>• {lastSyncAt.toLocaleTimeString()}</>}
          <button style={{ marginLeft: 8 }} onClick={async()=>{
            try{ setSyncStatus("syncing"); const doc=await apiGetSeason(); setHistory(doc.games||[]); setCloudVersion(doc.version||0); setLock(doc.lock||null); setProfiles(doc.profiles||{}); setSyncStatus("upToDate"); setLastSyncAt(new Date()); }
            catch(e){ setSyncStatus("error"); }
          }}>Refresh</button>
        </div>
      </header>

      {/* Host lock */}
      <section style={{ ...card, marginTop: 8 }}>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <label>Device:&nbsp;
            <input value={deviceName} onChange={e=>setDeviceName(e.target.value)} placeholder="Your name (for audit)" />
          </label>
          {lock ? (
            <>
              <span style={{ padding:"4px 8px", background:"#fee", borderRadius:999 }}>
                🔒 Locked by <strong>{lock.byName || "Host"}</strong>{lock.expiresAt ? ` • until ${new Date(lock.expiresAt).toLocaleString()}` : ""}
              </span>
              <button disabled={lock.deviceId !== deviceId} onClick={async()=>{
                try{ const out = await apiLock("unlock", deviceName, deviceId); setLock(out.lock || null); setCloudVersion(out.version || cloudVersion); }
                catch(e){ alert("Unlock failed: " + (e.message || "")); }
              }}>Unlock</button>
            </>
          ) : (
            <button onClick={async()=>{
              try{ const out = await apiLock("lock", deviceName || "Host", deviceId); setLock(out.lock || null); setCloudVersion(out.version || cloudVersion); }
              catch(e){ alert("Lock failed: " + (e.message || "")); }
            }}>Activate Host Lock</button>
          )}
        </div>
        <div style={{ fontSize: 12, color:"#666" }}>Auto-unlocks next day (Brisbane time).</div>
      </section>

      {/* Tabs */}
      <nav style={{ display:"flex", gap:8, marginTop:8 }}>
        {["game","history","profiles"].map(key => (
          <button key={key}
            onClick={()=>setTab(key)}
            style={{
              padding:"6px 10px",
              border:"1px solid #ddd",
              borderBottom: tab===key ? "2px solid #333" : "1px solid #ddd",
              background: tab===key ? "#fff" : "#f8f8f8",
              borderRadius:6,
              fontWeight: tab===key ? 700 : 400
            }}
          >
            {key==="game"?"Game":key==="history"?"History":"Profiles"}
          </button>
        ))}
      </nav>

      {/* GAME TAB */}
      {tab==="game" && (
        <section style={{ ...card, marginTop: 8, position:"relative" }}>
          {lockedByOther && (
            <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.25)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:5 }}>
              <div style={{ background:"#fff", padding:"6px 10px", borderRadius:999 }}>🔒 Read-only: locked by {lock?.byName || "Host"}</div>
            </div>
          )}

          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
            <label>Buy-in A$ <input type="number" min="1" step="1" value={buyInAmount} onChange={e=>setBuyInAmount(Math.max(1, parseFloat(e.target.value||50)))} disabled={lockedByOther}/></label>
            <label><input type="checkbox" checked={prizeFromPot} onChange={e=>setPrizeFromPot(e.target.checked)} disabled={lockedByOther}/> Prize from pot</label>
            <label>A$ <input type="number" min="0" step="1" value={prizeAmount} onChange={e=>setPrizeAmount(Math.max(0, parseFloat(e.target.value||0)))} disabled={lockedByOther}/></label>
            <label>Settlement
              <select value={settlementMode} onChange={e=>setSettlementMode(e.target.value)} disabled={lockedByOther}>
                <option value="equalSplit">Equal-split per loser</option>
              </select>
            </label>
          </div>

          <table style={{ width:"100%", borderCollapse:"collapse", marginTop: 8 }}>
            <thead>
              <tr><th align="left">Player</th><th>Buy-ins</th><th>Cash-out</th><th>Net</th><th></th></tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr key={p.id}>
                  <td><input value={p.name} onChange={e=>setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,name:e.target.value}:x))} placeholder="Name" disabled={lockedByOther}/></td>
                  <td align="center"><input type="number" min="0" step="1" value={p.buyIns} onChange={e=>setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,buyIns:Math.max(0,parseInt(e.target.value||0))}:x))} disabled={lockedByOther}/></td>
                  <td align="center"><input type="number" step="1" value={p.cashOut} onChange={e=>setPlayers(ps=>ps.map(x=>x.id===p.id?{...x,cashOut:parseFloat(e.target.value||0)}:x))} disabled={lockedByOther}/></td>
                  <td align="center" style={{ fontFamily:"monospace" }}>{round2(p.cashOut - p.buyIns*buyInAmount).toFixed(2)}</td>
                  <td align="center"><button onClick={()=>setPlayers(ps=>ps.filter(x=>x.id!==p.id))} disabled={lockedByOther}>Remove</button></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th>Total</th><th align="center" style={{fontFamily:"monospace"}}>{aud(totals.buyInSum)}</th><th align="center" style={{fontFamily:"monospace"}}>{aud(totals.cashAdjSum)}</th><th align="center" style={{fontFamily:"monospace"}}>{totals.diff.toFixed(2)}</th><th/></tr>
            </tfoot>
          </table>

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop: 8 }}>
            <div style={{ fontSize: 12, color: Math.abs(totals.diff)>0.01 ? "#b00" : "#0a0" }}>
              {Math.abs(totals.diff)>0.01 ? ("⚠️ Off by " + aud(totals.diff)) : "✅ Balanced"}
            </div>
            <div>
              <label style={{ marginRight: 8 }}><input type="checkbox" checked={overrideMismatch} onChange={e=>setOverrideMismatch(e.target.checked)} disabled={lockedByOther}/> Override mismatch</label>
              <button onClick={()=>setPlayers(ps=>[...ps, { id: uid(), name:"", buyIns:0, cashOut:0 }])} disabled={lockedByOther}>Add Player</button>
              <button onClick={saveGame} disabled={lockedByOther} style={{ marginLeft: 6 }}>End Game & Save</button>
            </div>
          </div>
        </section>
      )}

      {/* HISTORY TAB */}
      {tab==="history" && (
        <section style={{ ...card, marginTop: 8 }}>
          <h3 style={{ margin: "4px 0 8px" }}>History</h3>
          {history.length === 0 ? <div style={{ color:"#666" }}>No games yet.</div> : (
            <div style={{ display:"grid", gap: 8 }}>
              {history.map(g => {
                const winNeed = {}; const winPaid = {};
                (g.players || []).forEach(p => { if ((p.net || 0) > 0) { winNeed[p.name] = round2((winNeed[p.name] || 0) + p.net); } });
                (g.txns || []).forEach(t => { winPaid[t.to] = round2((winPaid[t.to] || 0) + (t.paid ? t.amount : 0)); });

                const isOpen = !!expanded[g.id];
                const toggleOpen = () => setExpanded(s => ({ ...s, [g.id]: !s[g.id] }));

                const rPlayers = [["name","buyIns","buyInTotal","cashOutAdj","prizeAdj","net"]];
                (g.players || []).forEach(p => rPlayers.push([p.name, p.buyIns, p.buyInTotal, p.cashOut, p.prize, p.net]));
                const rTx = [["from","to","amount","paid"]];
                (g.txns || []).forEach(t => rTx.push([t.from, t.to, t.amount, t.paid ? "yes" : "no"]));

                // prize info
                const N = (g.players || []).length;
                const feePer = (g?.settings?.prize?.mode === "pot_all" ? Number(g?.settings?.prize?.amount || 20) : 0);
                const prizePool = round2(N * feePer);
                const winners = (g.players || []).filter(p => (p.net || 0) > 0).map(p => p.name);

                return (
                  <div key={g.id} style={{ border:"1px solid #eee", borderRadius: 8, padding: 10 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      <div>
                        <div style={{ fontFamily:"monospace" }}>{new Date(g.stamp).toLocaleString()}</div>
                        <div style={{ fontSize:12, color:"#666" }}>{(g.players || []).map(p => p.name).join(", ")}</div>
                      </div>
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                        <button onClick={()=>downloadCSV("players.csv", rPlayers)}>Export Players CSV</button>
                        <button onClick={()=>downloadCSV("transfers.csv", rTx)}>Export Transfers CSV</button>
                        <button onClick={toggleOpen}>{isOpen ? "Hide details" : "Details"}</button>
                        <button onClick={()=>removeGame(g.id)}>Delete</button>
                      </div>
                    </div>

                    {/* Winners chips */}
                    <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginTop: 8 }}>
                      {(g.players || []).filter(p => (p.net || 0) > 0).map(p => {
                        const need = winNeed[p.name] || 0, got = winPaid[p.name] || 0;
                        const done = Math.abs(need - got) < 0.01;
                        const avatar = profiles?.[p.name]?.avatarDataUrl || "";
                        return (
                          <div key={p.name} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", border:"1px solid #eee", borderRadius: 999, background: done ? "#eaffea" : "#fff" }}>
                            <div style={{ width:28, height:28, borderRadius:"50%", overflow:"hidden", background:"#ddd" }}>
                              {avatar ? <img src={avatar} alt="" width={28} height={28}/> : null}
                            </div>
                            <div><strong>{p.name}</strong><div style={{ fontSize:11, color:"#666" }}>{aud(got)} / {aud(need)}</div></div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Transfers */}
                    <div style={{ marginTop: 8 }}>
                      <table style={{ width:"100%", borderCollapse:"collapse" }}>
                        <thead><tr><th align="left">From</th><th align="left">To</th><th align="right">Amount</th><th align="center">Paid?</th></tr></thead>
                        <tbody>
                          {(g.txns || []).map((t, idx) => (
                            <tr key={idx}>
                              <td>{t.from}{profiles?.[t.from]?.payId ? <> (PayID: {profiles[t.from].payId})</> : null}</td>
                              <td>{t.to}{profiles?.[t.to]?.payId ? <> (PayID: {profiles[t.to].payId})</> : null}</td>
                              <td align="right" style={{ fontFamily:"monospace" }}>{aud(t.amount)}</td>
                              <td align="center"><input type="checkbox" checked={!!t.paid} onChange={()=>togglePaid(g, idx)} disabled={lockedByOther}/></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Ledger / details */}
                    {isOpen && (
                      <div style={{ marginTop: 8, background:"#fafafa", border:"1px dashed #ddd", borderRadius: 8, padding: 8 }}>
                        <div style={{ marginBottom: 6, fontWeight: 600 }}>Ledger</div>
                        <table style={{ width:"100%", borderCollapse:"collapse" }}>
                          <thead><tr><th align="left">Player</th><th align="right">Buy-in</th><th align="right">Cash (adj)</th><th align="right">Prize adj</th><th align="right">Net</th></tr></thead>
                          <tbody>
                            {(g.players || []).map((p, i) => (
                              <tr key={i}>
                                <td>{p.name}</td>
                                <td align="right" style={{ fontFamily:"monospace" }}>{aud(p.buyInTotal)}</td>
                                <td align="right" style={{ fontFamily:"monospace" }}>{aud(p.cashOut)}</td>
                                <td align="right" style={{ fontFamily:"monospace" }}>{aud(p.prize)}</td>
                                <td align="right" style={{ fontFamily:"monospace" }}>{aud(p.net)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {feePer > 0 && (
                          <div style={{ marginTop: 8, fontSize: 12 }}>
                            <div>Prize pool: {N} × {aud(feePer)} = <strong>{aud(prizePool)}</strong></div>
                            <div>Distributed to top winner(s): {winners.join(", ") || "—"}</div>
                            <div>Everyone contributed {aud(feePer)} (shown as −{feePer} prize adj), winners received their share (shown as +).</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* PROFILES TAB */}
      {tab==="profiles" && (
        <section style={{ ...card, marginTop: 8 }}>
          <h3 style={{ margin:"4px 0 8px" }}>Profiles</h3>
          {(() => {
            const nameSet = new Set();
            players.forEach(p => p.name && nameSet.add(p.name));
            history.forEach(g => (g.players || []).forEach(p => p.name && nameSet.add(p.name)));
            const names = Array.from(nameSet).sort();
            if (names.length === 0) return <div style={{ color:"#666" }}>No names yet. Add players above and save a game.</div>;
            return (
              <div style={{ display:"grid", gap: 8 }}>
                {names.map(name => {
                  const prof = profiles?.[name] || {};
                  return (
                    <div key={name} style={{ display:"flex", alignItems:"center", gap:12, padding:10, border:"1px solid #eee", borderRadius: 8 }}>
                      <div style={{ width:48, height:48, borderRadius:"50%", overflow:"hidden", background:"#ddd" }}>
                        {prof.avatarDataUrl ? <img src={prof.avatarDataUrl} alt="" width={48} height={48}/> : null}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div><strong>{name}</strong></div>
                        <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:4, flexWrap:"wrap" }}>
                          <input placeholder="PayID (email/phone)" defaultValue={prof.payId || ""} onBlur={async e=>{
                            try{ const out = await apiProfileUpsert(name, { payId: e.target.value }, deviceId, deviceName); setProfiles(out.profiles || {}); setCloudVersion(out.version || cloudVersion); }
                            catch(e){ alert("Saving PayID failed."); }
                          }} style={{ minWidth: 240 }}/>
                          <label style={{ fontSize: 12 }}>Avatar: <input type="file" accept="image/*" onChange={e=>{
                            const file = e.target.files?.[0]; if (!file) return;
                            const reader = new FileReader();
                            reader.onload = async () => {
                              try{ const out = await apiProfileUpsert(name, { avatarDataUrl: String(reader.result || "") }, deviceId, deviceName); setProfiles(out.profiles || {}); setCloudVersion(out.version || cloudVersion); }
                              catch(e){ alert("Avatar upload failed (file too big?)"); }
                            };
                            reader.readAsDataURL(file);
                          }}/></label>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </section>
      )}
    </div>
  );
}
