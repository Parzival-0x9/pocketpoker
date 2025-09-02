import React, { useMemo, useState, useEffect } from "react";
import PlayerRow from "./PlayerRow.jsx";
import { aud, sum, round2, settle, nextFridayISO, toCSV } from "./calc.js";

// ===============================
// 2B Host Lock — minimal, safe, no layout changes
// ===============================

// Persistent device id (per browser) for lock API
const DEVICE_KEY = "pp_device";
function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) + "-" + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

// Remember who this device is (local only)
const WHOAMI_KEY = "pp_whoami";
function getWhoAmI() {
  try { return localStorage.getItem(WHOAMI_KEY) || ""; } catch { return ""; }
}
function setWhoAmI(name) {
  try { name ? localStorage.setItem(WHOAMI_KEY, String(name)) : localStorage.removeItem(WHOAMI_KEY); } catch {}
}

// Small name picker (buttons for current players). No JSX styles used.
function chooseLocker(names) {
  if (!Array.isArray(names) || names.length === 0) {
    const v = window.prompt("No named players yet. Type the host's name:");
    return Promise.resolve(v && v.trim() ? v.trim() : null);
  }
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "5000";
    root.style.display = "flex";
    root.style.alignItems = "center";
    root.style.justifyContent = "center";

    const backdrop = document.createElement("div");
    backdrop.style.position = "absolute";
    backdrop.style.inset = "0";
    backdrop.style.background = "rgba(0,0,0,.45)";

    const card = document.createElement("div");
    card.style.position = "relative";
    card.style.background = "var(--surface,#1f2937)";
    card.style.color = "inherit";
    card.style.borderRadius = "14px";
    card.style.padding = "14px";
    card.style.width = "min(92vw,420px)";
    card.style.boxShadow = "0 10px 30px rgba(0,0,0,.3)";

    const title = document.createElement("div");
    title.textContent = "Activate Host Lock";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";

    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexWrap = "wrap";
    list.style.gap = "8px";
    list.style.margin = "6px 0";
    list.style.maxHeight = "240px";
    list.style.overflow = "auto";

    names.forEach((n) => {
      const btn = document.createElement("button");
      btn.textContent = n;
      btn.style.padding = "8px 12px";
      btn.style.borderRadius = "10px";
      btn.style.border = "1px solid rgba(255,255,255,.15)";
      btn.style.background = "rgba(255,255,255,.05)";
      btn.style.cursor = "pointer";
      btn.addEventListener("click", () => cleanup(n));
      list.appendChild(btn);
    });

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "10px";

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.padding = "8px 12px";
    cancel.style.borderRadius = "10px";
    cancel.style.border = "1px solid rgba(255,255,255,.15)";
    cancel.style.background = "transparent";
    cancel.style.cursor = "pointer";
    cancel.addEventListener("click", () => cleanup(null));

    root.appendChild(backdrop);
    actions.appendChild(cancel);
    card.appendChild(title);
    card.appendChild(list);
    card.appendChild(actions);
    root.appendChild(card);
    document.body.appendChild(root);

    const cleanup = (val = null) => { root.remove(); resolve(val); };
    backdrop.addEventListener("click", () => cleanup(null));
  });
}

// ===============================
// App constants & local storage
// ===============================
const API_BASE = ""; // same origin
const SEASON_ID = (import.meta && import.meta.env && import.meta.env.VITE_SEASON_ID) || "default";

const DEFAULT_BUYIN = 50, DEFAULT_PERHEAD = 20;
const uid = () => Math.random().toString(36).slice(2, 9);
const blank = () => ({ id: uid(), name: "", buyIns: 0, cashOut: 0 });
const LS = "pocketpoker_state";

const load = () => { try { const r = localStorage.getItem(LS); return r ? JSON.parse(r) : null; } catch { return null; } };
const save = (s) => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} };

// ===============================
// Equal Settlement helper (restored)
// ===============================
function equalSettlement(input) {
  const arr = (input || []).map((p) => {
    const name = p.name || "Player";
    let net = 0;
    if (typeof p.net === "number") net = p.net;
    else if (typeof p.netAdj === "number") net = p.netAdj;
    else {
      const cash = Number(p.cashOutAdj ?? p.cashOut ?? 0);
      const buyIns = Number(p.buyIns ?? 0) * (window.__pp_buyInAmount ?? 0);
      net = cash - buyIns;
    }
    return { name, net: round2(net) };
  });
  return settle(arr);
}

// ===============================
// Component
// ===============================
export default function App() {
  const [players, setPlayers] = useState([blank(), blank()]);
  const [buyInAmount, setBuyInAmount] = useState(DEFAULT_BUYIN);
  const [applyPerHead, setApplyPerHead] = useState(false);
  const [perHeadAmount, setPerHeadAmount] = useState(DEFAULT_PERHEAD);
  const [history, setHistory] = useState([]);

  // Cloud sync bits
  const [cloudVersion, setCloudVersion] = useState(0);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | upToDate | error

  // Host Lock
  const [hostLock, setHostLock] = useState({ active: false, by: null, until: null, at: null });
  const [whoAmI, setWhoAmIState] = useState(() => getWhoAmI() || "");

  // expose buy-in for equalSettlement fallback
  useEffect(() => { window.__pp_buyInAmount = buyInAmount; }, [buyInAmount]);

  // basic computed
  const playerNames = useMemo(
    () => Array.from(new Set((players || []).map((p) => (p.name || "").trim()).filter(Boolean))),
    [players]
  );
  const canEdit = !hostLock.active || (whoAmI && hostLock.by && whoAmI === hostLock.by);

  // ---- API helpers
  async function apiGetSeason() {
    const res = await fetch(`${API_BASE}/api/season/get?id=${encodeURIComponent(SEASON_ID)}`);
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }
  async function apiAppendGame(game) {
    const res = await fetch(`${API_BASE}/api/season/append-game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": String(cloudVersion) },
      body: JSON.stringify({ seasonId: SEASON_ID, game })
    });
    if (res.status === 409) {
      // refresh and retry once
      const doc = await apiGetSeason();
      hydrateFromDoc(doc);
      const res2 = await fetch(`${API_BASE}/api/season/append-game`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "If-Match": String(doc.version || 0) },
        body: JSON.stringify({ seasonId: SEASON_ID, game })
      });
      if (!res2.ok) throw new Error(await res2.text());
      return await res2.json();
    }
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }
  async function apiDeleteGame(gameId) {
    const res = await fetch(`${API_BASE}/api/season/delete-game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": String(cloudVersion) },
      body: JSON.stringify({ seasonId: SEASON_ID, gameId })
    });
    if (res.status === 409) {
      // refresh and retry once
      const doc = await apiGetSeason();
      hydrateFromDoc(doc);
      const res2 = await fetch(`${API_BASE}/api/season/delete-game`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "If-Match": String(doc.version || 0) },
        body: JSON.stringify({ seasonId: SEASON_ID, gameId })
      });
      if (!res2.ok) throw new Error(await res2.text());
      return await res2.json();
    }
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  // Host lock toggle — sends {action, byName?, deviceId}
  async function apiLockSeason(locked, byName) {
    const deviceId = getDeviceId();
    const payload = {
      seasonId: SEASON_ID,
      action: locked ? "lock" : "unlock",
      deviceId
    };
    if (locked && byName) payload.byName = byName;

    const res = await fetch(`${API_BASE}/api/season/lock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": deviceId,
        "x-client-name": byName || hostLock.by || "Unknown"
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 423) {
      const doc = await res.json().catch(() => null);
      alert(doc?.lock?.byName ? `Game is locked by ${doc.lock.byName} on another device.` : "Game is locked by another device.");
      if (doc) hydrateFromDoc(doc);
      return;
    }

    if (!res.ok) {
      alert(await res.text());
      return;
    }
    const doc = await res.json().catch(() => null);
    if (doc) hydrateFromDoc(doc);
  }

  // Merge server doc into local UI state (single lock variable!)
  function hydrateFromDoc(doc) {
    if (doc && Array.isArray(doc.games)) setHistory(doc.games);
    if (doc && typeof doc.version === "number") setCloudVersion(doc.version);

    const lk = doc && (doc.lock || null);
    if (lk) {
      const active = !!(lk.active ?? lk.locked ?? true);
      const by = lk.byName || lk.by || lk.user || lk.device || null;
      const until = lk.until || lk.unlockAt || null;
      const at = lk.lockedAt || lk.at || null;
      setHostLock({ active, by, until, at });
    } else {
      setHostLock({ active: false, by: null, until: null, at: null });
    }
  }

  // Manual refresh
  async function refreshSeason() {
    try {
      setSyncStatus("syncing");
      const doc = await apiGetSeason();
      hydrateFromDoc(doc);
      setSyncStatus("upToDate");
    } catch (e) {
      setSyncStatus("error");
    }
  }

  // Load local, then fetch server on mount
  useEffect(() => {
    const s = load();
    if (s) {
      setPlayers(s.players?.length ? s.players : [blank(), blank()]);
      setBuyInAmount(s.buyInAmount ?? DEFAULT_BUYIN);
      setApplyPerHead(!!s.applyPerHead);
      setPerHeadAmount(s.perHeadAmount ?? DEFAULT_PERHEAD);
      setHistory(s.history ?? []);
    }
    (async () => {
      try {
        setSyncStatus("syncing");
        const doc = await apiGetSeason();
        hydrateFromDoc(doc);
        setSyncStatus("upToDate");
      } catch (e) {
        setSyncStatus("error");
      }
    })();
  }, []);

  // Persist local
  useEffect(() => {
    save({ players, buyInAmount, applyPerHead, perHeadAmount, history });
  }, [players, buyInAmount, applyPerHead, perHeadAmount, history]);

  // Poll every 10s for remote changes (version or lock only)
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const doc = await apiGetSeason();
        const remoteVersion = doc?.version ?? 0;
        const lk = doc?.lock || null;

        const active = !!(lk?.active ?? lk?.locked ?? false);
        const by = lk?.byName || lk?.by || null;

        if (remoteVersion !== cloudVersion || active !== hostLock.active || by !== hostLock.by) {
          hydrateFromDoc(doc);
        }
      } catch {}
    }, 10000);
    return () => clearInterval(t);
  }, [cloudVersion, hostLock.active, hostLock.by]);

  // Totals
  const totals = useMemo(() => {
    const base = players.map((p) => ({ ...p, buyInTotal: round2(p.buyIns * buyInAmount), baseCash: p.cashOut }));
    const withNet = base.map((p) => ({ ...p, net: round2(p.baseCash - p.buyIns * buyInAmount) }));
    const top = [...withNet].sort((a, b) => b.net - a.net)[0];
    let adjusted = withNet.map((p) => ({ ...p, prize: 0, cashOutAdj: round2(p.baseCash), netAdj: round2(p.baseCash - p.buyIns * buyInAmount) }));

    if (applyPerHead && top) {
      const heads = Math.max(0, players.length - 1);
      adjusted = withNet.map((p) => {
        if (p.id === top.id) {
          const cash = round2(p.baseCash + perHeadAmount * heads);
          return { ...p, prize: perHeadAmount * heads, cashOutAdj: cash, netAdj: round2(cash - p.buyIns * buyInAmount) };
        } else {
          const cash = round2(p.baseCash - perHeadAmount);
          return { ...p, prize: -perHeadAmount, cashOutAdj: cash, netAdj: round2(cash - p.buyIns * buyInAmount) };
        }
      });
    }

    const buyInSum = round2(sum(adjusted.map((p) => p.buyInTotal)));
    const cashAdjSum = round2(sum(adjusted.map((p) => p.cashOutAdj)));
    const diff = round2(cashAdjSum - buyInSum);
    const txns = settle(adjusted.map((p) => ({ name: p.name || "Player", net: p.netAdj })));
    const sorted = [...adjusted].sort((a, b) => b.net - a.net);
    const winner = sorted.length ? sorted[0] : null;
    const perHeadPayers = winner ? adjusted.filter((p) => p.id !== winner.id).map((p) => p.name || "Player") : [];
    return { adjusted, top, buyInSum, cashAdjSum, diff, txns, winner, perHeadPayers };
  }, [players, buyInAmount, applyPerHead, perHeadAmount]);

  function updatePlayer(u) { setPlayers((ps) => (u?._remove ? ps.filter((p) => p.id !== u.id) : ps.map((p) => (p.id === u.id ? u : p)))); }
  const addPlayer = () => setPlayers((ps) => [...ps, blank()]);
  const startGame = () => setPlayers((ps) => ps.map((p) => ({ ...p, buyIns: 0, cashOut: 0 })));
  const resetGame = () => setPlayers([blank(), blank()]);

  async function saveGameToHistory() {
    const stamp = new Date().toISOString();
    const perHeadDue = nextFridayISO(stamp);
    const perHeadPayments = {};
    totals.perHeadPayers.forEach((n) => (perHeadPayments[n] = { paid: false, method: null, paidAt: null }));
    const g = {
      id: uid(),
      stamp,
      settings: { buyInAmount, perHead: applyPerHead ? perHeadAmount : 0 },
      players: totals.adjusted.map((p) => ({ name: p.name || "Player", buyIns: p.buyIns, buyInTotal: p.buyInTotal, cashOut: p.cashOutAdj, prize: p.prize, net: p.netAdj })),
      totals: { buyIns: totals.buyInSum, cashOuts: totals.cashAdjSum, diff: totals.diff },
      txns: totals.txns,
      perHead: applyPerHead
        ? { winner: totals.winner?.name || "Winner", amount: perHeadAmount, payers: totals.perHeadPayers, due: perHeadDue, payments: perHeadPayments, celebrated: false }
        : null
    };
    try {
      setSyncStatus("syncing");
      const doc = await apiAppendGame(g);
      hydrateFromDoc(doc);
      setSyncStatus("upToDate");
    } catch (e) {
      console.error(e);
      setHistory((h) => [g, ...h]); // local fallback
      setSyncStatus("error");
    }
  }

  function autoBalance() {
    const { top, diff } = totals; if (!top || Math.abs(diff) < 0.01) return;
    setPlayers((ps) => ps.map((p) => (p.id === top.id ? { ...p, cashOut: round2(p.cashOut - diff) } : p)));
  }

  function deleteGame(id) {
    if (!window.confirm("Delete this game from history?")) return;
    (async () => {
      try {
        setSyncStatus("syncing");
        const doc = await apiDeleteGame(id);
        hydrateFromDoc(doc);
        setSyncStatus("upToDate");
      } catch (e) {
        console.error(e);
        setHistory((h) => h.filter((g) => g.id !== id)); // local fallback
        setSyncStatus("error");
      }
    })();
  }

  // --- UI ---
  return (
    <>
      {/* Header with Sync + Host Lock */}
      <div className="header" style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <h1 style={{margin:0}}>PocketPoker</h1>
          {hostLock.active && (
            <span className="pill" style={{marginLeft:8}}>🔒 Locked{hostLock.by ? ` by ${hostLock.by}` : ""}</span>
          )}
        </div>
        <div className="toolbar" style={{display:"flex",alignItems:"center",gap:8}}>
          <span className="meta"><strong>Sync:</strong> {syncStatus} • v{cloudVersion}</span>
          <button className="btn ghost small" onClick={refreshSeason}>Refresh</button>
          <button
            className="btn secondary"
            onClick={async () => {
              if (!hostLock.active) {
                const pick = await chooseLocker(playerNames);
                if (!pick) return;
                setWhoAmIState(pick); setWhoAmI(pick);
                await apiLockSeason(true, pick);
              } else {
                await apiLockSeason(false);
              }
            }}
          >
            {hostLock.active ? (hostLock.by ? `Unlock (${hostLock.by})` : "Unlock") : "Activate Host Lock"}
          </button>
        </div>
      </div>

      {/* Controls row (unchanged from 2A except readonly gating) */}
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

      {/* Table */}
      <div style={{position:"relative"}}>
        {/* read-only overlay (doesn't block header) */}
        {(hostLock.active && (!whoAmI || whoAmI !== hostLock.by)) && (
          <>
            <div
              title="Host Lock: read-only"
              style={{position:'absolute', inset:0, background:'rgba(0,0,0,.08)', borderRadius:18, pointerEvents:'auto'}}
            />
            <div
              style={{position:'absolute', top:10, right:10, background:'rgba(0,0,0,.65)', color:'#fff', padding:'6px 10px',
                      borderRadius:12, border:'1px solid rgba(255,255,255,.15)', fontSize:12}}
            >
              🔒 Read-only{hostLock.by ? ` — ${hostLock.by}` : ""}
            </div>
          </>
        )}

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
            {players.map((p) => (<PlayerRow key={p.id} p={p} onChange={updatePlayer} buyInAmount={buyInAmount} />))}
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
        <div className="header" style={{marginTop:12}}>
          <div className="ribbon">⚠️ Off by {aud(totals.diff)}. Use Auto-Balance or tick Override.</div>
          <div className="toolbar">
            <button className="btn secondary" onClick={autoBalance} disabled={!canEdit}>Auto-Balance</button>
            <label className="inline"><input type="checkbox" onChange={()=>{}} /> Override & Save</label>
          </div>
        </div>
      ) : (
        <div className="header" style={{marginTop:12}}>
          <div className="ribbon">✅ Balanced: totals match.</div>
          <div className="toolbar"></div>
        </div>
      )}

      <div className="toolbar" style={{justifyContent:'flex-end', marginTop:12}}>
        <button className="btn success" onClick={saveGameToHistory} disabled={(Math.abs(totals.diff) > 0.01) || !canEdit}>End Game & Save</button>
      </div>

      {/* History (unchanged list, minimal for 2B) */}
      <div className="surface" style={{marginTop:16}}>
        <div className="header">
          <h3 style={{margin:0}}>History</h3>
          <div className="toolbar">
            <button className="btn secondary" onClick={()=>{
              const rows = [["game_id","stamp","player","buy_in","cash_out_adj","prize_adj","net"]];
              history.forEach(g=> g.players.forEach(p => rows.push([g.id, g.stamp, p.name, p.buyInTotal, p.cashOut, p.prize, p.net])));
              const csv = toCSV(rows);
              const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = "players.csv"; a.click();
              setTimeout(()=>URL.revokeObjectURL(url), 1500);
            }}>Export CSV</button>
          </div>
        </div>
        <table className="table">
          <thead><tr><th>When</th><th>Summary</th><th className="center">Totals</th><th className="center">Actions</th></tr></thead>
          <tbody>
            {history.length===0 ? (
              <tr><td colSpan="4" className="center meta">No games saved yet.</td></tr>
            ) : history.map(g=>{
              const playersSorted=[...g.players].sort((a,b)=>b.net-a.net);
              const summary=playersSorted.map(p=>(
                <span key={p.name} style={{marginRight:8}}>
                  {p.name} ({p.net>=0?'+':''}{p.net.toFixed(2)})
                </span>
              ));
              return (
                <tr key={g.id}>
                  <td className="mono meta">{new Date(g.stamp).toLocaleString()}</td>
                  <td>{summary}</td>
                  <td className="center mono">{aud(g.totals.buyIns)} / {aud(g.totals.cashOuts)} ({aud(g.totals.diff)})</td>
                  <td className="center">
                    <button className="btn danger" onClick={()=>deleteGame(g.id)} disabled={!canEdit}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
