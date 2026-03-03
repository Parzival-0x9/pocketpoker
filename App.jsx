import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchDatabaseState,
  hasDatabase,
  pushDatabaseState,
  subscribeDatabaseState,
} from "./supabase";
import {
  BalanceStatus,
  BottomStickyAction,
  HighlightCard,
  PrimaryNavTabs,
  PrizeSummary,
  QuickActionsTop,
  SessionHeader,
  SimpleListCard,
  StatsHero,
  SyncStatusInline,
} from "./components/DashboardHeader";

const DB_KEY = "classmates_db_v1";
const SESSION_KEY = "classmates_device_user_v1";
const DEVICE_KEY = "classmates_device_id_v1";
const ONLINE_WINDOW_MS = 120000;
const SYNC_STALE_MS = 45000;

const uid = () => Math.random().toString(36).slice(2, 10);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const safeName = (v) => {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.trim() || "Player";
};
const money = (n) =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(Number(n) || 0);

function blankPlayer() {
  return { id: uid(), name: "", buyIns: 0, cashOut: 0 };
}

function defaultDB() {
  return {
    rev: 0,
    users: [],
    presence: {},
    autoBackups: [],
    adminEvents: [],
    live: {
      id: "live",
      title: "Classmates Live Session",
      buyInCashAmount: 50,
      buyInChipStack: 50,
      prizeEnabled: true,
      prizePerPlayer: 20,
      players: [blankPlayer(), blankPlayer()],
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    },
    history: [],
    updatedAt: new Date().toISOString(),
  };
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return defaultDB();
    const parsed = JSON.parse(raw);
    return {
      ...defaultDB(),
      ...parsed,
      rev: Number.isFinite(Number(parsed.rev)) ? Number(parsed.rev) : 0,
      live: {
        ...defaultDB().live,
        ...(parsed.live || {}),
        prizeEnabled: typeof parsed?.live?.prizeEnabled === "boolean" ? parsed.live.prizeEnabled : true,
        prizePerPlayer: Math.max(0, Number(parsed?.live?.prizePerPlayer || 20)),
        players:
          Array.isArray(parsed?.live?.players) && parsed.live.players.length
            ? parsed.live.players.map((p) => ({
                id: p.id || uid(),
                name: p.name || "",
                buyIns: Math.max(0, parseInt(p.buyIns || 0, 10) || 0),
                cashOut: Number(p.cashOut || 0),
              }))
            : [blankPlayer(), blankPlayer()],
      },
      users: normalizeUsers(parsed.users),
      presence:
        parsed.presence && typeof parsed.presence === "object" && !Array.isArray(parsed.presence)
          ? parsed.presence
          : {},
      autoBackups: Array.isArray(parsed.autoBackups)
        ? parsed.autoBackups
            .map((b) => ({
              id: b?.id || uid(),
              at: b?.at || new Date().toISOString(),
              by: safeName(b?.by || "Unknown"),
              csv: typeof b?.csv === "string" ? b.csv : "",
              label: typeof b?.label === "string" ? b.label : "Session Auto Backup",
            }))
            .filter((b) => b.csv)
        : [],
      adminEvents: Array.isArray(parsed.adminEvents) ? parsed.adminEvents : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return defaultDB();
  }
}

function toCsvCell(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let curr = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        curr += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(curr);
      curr = "";
    } else {
      curr += ch;
    }
  }
  out.push(curr);
  return out;
}

function dbToCsvPayload(db) {
  const rows = [
    ["section", "json"],
    [
      "meta",
      JSON.stringify({
        app: "classmates",
        format: "csv-v1",
        exportedAt: new Date().toISOString(),
      }),
    ],
    ["users", JSON.stringify(db.users || [])],
    ["presence", JSON.stringify(db.presence || {})],
    ["live", JSON.stringify(db.live || defaultDB().live)],
    ["history", JSON.stringify(db.history || [])],
    ["adminEvents", JSON.stringify(db.adminEvents || [])],
    ["autoBackups", JSON.stringify(db.autoBackups || [])],
  ];
  return rows.map((r) => `${toCsvCell(r[0])},${toCsvCell(r[1])}`).join("\n");
}

function historyToSessionReportCsv(history) {
  const rows = [[
    "row_type",
    "session_stamp",
    "saved_by",
    "player",
    "buy_ins",
    "cash_out",
    "net_no_prize",
    "prize_adjustment",
    "net_with_prize",
    "winner_names",
    "prize_payer",
    "prize_receiver",
    "prize_amount",
    "prize_payment_status",
  ]];

  const sessions = Array.isArray(history) ? history : [];
  sessions.forEach((h) => {
    const stamp = h?.stamp || "";
    const savedBy = safeName(h?.savedBy || "Unknown");
    const winners = Array.isArray(h?.settings?.winnerNames) ? h.settings.winnerNames.join(" | ") : "";
    const players = Array.isArray(h?.players) ? h.players : [];

    players.forEach((p) => {
      const baseNet =
        typeof p?.baseNetCash === "number"
          ? p.baseNetCash
          : round2((p?.netCash || 0) - (p?.prizeAdj || 0));
      rows.push([
        "player",
        stamp,
        savedBy,
        safeName(p?.name || "Player"),
        String(parseInt(p?.buyIns || 0, 10) || 0),
        String(round2(Number(p?.cashOut || 0))),
        String(round2(baseNet)),
        String(round2(Number(p?.prizeAdj || 0))),
        String(round2(Number(p?.netCash || 0))),
        winners,
        "",
        "",
        "",
        "",
      ]);
    });

    const prizePayments = getPrizePaymentsForSession(h);
    prizePayments.forEach((t) => {
      rows.push([
        "prize_payment",
        stamp,
        savedBy,
        "",
        "",
        "",
        "",
        "",
        "",
        winners,
        safeName(t?.from || ""),
        safeName(t?.to || ""),
        String(round2(Number(t?.amount || 0))),
        t?.paid ? "paid" : "unpaid",
      ]);
    });
  });

  return rows.map((r) => r.map((v) => toCsvCell(v)).join(",")).join("\n");
}

function csvPayloadToDb(csvText) {
  const lines = String(csvText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV backup is empty.");
  const header = parseCsvLine(lines[0]).map((x) => x.trim().toLowerCase());
  if (header[0] !== "section" || header[1] !== "json") {
    throw new Error("Invalid CSV header. Expected: section,json");
  }

  const parts = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const section = (cols[0] || "").trim();
    const jsonRaw = cols.slice(1).join(",");
    if (!section) continue;
    parts[section] = jsonRaw ? JSON.parse(jsonRaw) : null;
  }

  const candidate = {
    users: normalizeUsers(parts.users),
    presence:
      parts.presence && typeof parts.presence === "object" && !Array.isArray(parts.presence)
        ? parts.presence
        : {},
    autoBackups: Array.isArray(parts.autoBackups)
      ? parts.autoBackups
          .map((b) => ({
            id: b?.id || uid(),
            at: b?.at || new Date().toISOString(),
            by: safeName(b?.by || "Unknown"),
            csv: typeof b?.csv === "string" ? b.csv : "",
            label: typeof b?.label === "string" ? b.label : "Session Auto Backup",
          }))
          .filter((b) => b.csv)
      : [],
    adminEvents: Array.isArray(parts.adminEvents) ? parts.adminEvents : [],
    history: Array.isArray(parts.history) ? parts.history : [],
    live: {
      ...defaultDB().live,
      ...(parts.live || {}),
      players: Array.isArray(parts?.live?.players) && parts.live.players.length
        ? parts.live.players.map((p) => ({
            id: p.id || uid(),
            name: safeName(p.name),
            buyIns: Math.max(0, parseInt(p.buyIns || 0, 10) || 0),
            cashOut: Number(p.cashOut || 0),
          }))
        : [blankPlayer(), blankPlayer()],
    },
  };

  return {
    ...defaultDB(),
    ...candidate,
  };
}

function normalizeUsers(users) {
  if (!Array.isArray(users)) return [];
  const seen = new Set();
  const out = [];

  users.forEach((u) => {
    const rawUsername =
      safeName(u?.username || u?.name || String(u?.email || "").split("@")[0] || "").replace(/\s+/g, "_");
    const username = rawUsername.toLowerCase();
    const password = String(u?.password || u?.pass || "");
    if (!username || seen.has(username)) return;
    seen.add(username);
    out.push({
      id: u?.id || uid(),
      username,
      password,
      createdAt: u?.createdAt || new Date().toISOString(),
      lastLoginAt: u?.lastLoginAt || null,
    });
  });

  return out;
}

function pickNewestState(currentState, incomingState) {
  const currentRev = Number(currentState?.rev || 0);
  const incomingRev = Number(incomingState?.rev || 0);
  if (incomingRev !== currentRev) return incomingRev > currentRev ? incomingState : currentState;
  const currentTs = Date.parse(currentState?.updatedAt || "") || 0;
  const incomingTs = Date.parse(incomingState?.updatedAt || "") || 0;
  return incomingTs >= currentTs ? incomingState : currentState;
}

function compareStateFreshness(a, b) {
  const aRev = Number(a?.rev || 0);
  const bRev = Number(b?.rev || 0);
  if (aRev !== bRev) return aRev > bRev ? 1 : -1;
  const aTs = Date.parse(a?.updatedAt || "") || 0;
  const bTs = Date.parse(b?.updatedAt || "") || 0;
  if (aTs === bTs) return 0;
  return aTs > bTs ? 1 : -1;
}

function settleEqualSplitCapped(rows) {
  const winnersRaw = rows
    .filter((r) => r.net > 0.0001)
    .map((r) => ({ name: safeName(r.name), amount: round2(r.net) }));
  const losersRaw = rows
    .filter((r) => r.net < -0.0001)
    .map((r) => ({ name: safeName(r.name), amount: round2(-r.net) }));

  if (!winnersRaw.length || !losersRaw.length) return [];

  // Allocate decimal totals into whole-dollar buckets using largest remainders.
  // This keeps transfer lines clean (no cents) while preserving total balance.
  function allocateWhole(list, keyOut, targetTotal) {
    const base = list.map((x) => ({
      ...x,
      floor: Math.floor(x.amount),
      frac: x.amount - Math.floor(x.amount),
    }));
    let used = base.reduce((a, x) => a + x.floor, 0);
    let rem = Math.max(0, targetTotal - used);

    base
      .sort((a, b) => b.frac - a.frac || b.amount - a.amount || a.name.localeCompare(b.name))
      .forEach((x) => {
        x[keyOut] = x.floor + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
      });

    return base.map((x) => ({ name: x.name, [keyOut]: x[keyOut] }));
  }

  const winnersTarget = Math.round(
    winnersRaw.reduce((a, x) => a + x.amount, 0)
  );
  const losersTarget = Math.round(
    losersRaw.reduce((a, x) => a + x.amount, 0)
  );
  const target = Math.max(0, Math.min(winnersTarget, losersTarget));

  const winnersBase = allocateWhole(winnersRaw, "need", target);
  const losersBase = allocateWhole(losersRaw, "loss", target);

  const winnersOrder = [...winnersBase].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const losersSorted = [...losersBase].sort(
    (a, b) => b.loss - a.loss || a.name.localeCompare(b.name)
  );

  const txns = [];
  const eligible = () => winnersOrder.filter((w) => w.need > 0.0001);

  losersSorted.forEach((loser) => {
    let remaining = loser.loss;
    while (remaining > 0) {
      const live = eligible();
      if (!live.length) break;
      const equalRaw = remaining / live.length;
      let distributed = 0;

      for (let i = 0; i < live.length; i++) {
        const winner = live[i];
        const isLast = i === live.length - 1;
        let give = isLast
          ? remaining - distributed
          : Math.floor(Math.min(equalRaw, winner.need));

        give = Math.max(0, Math.min(give, winner.need, remaining - distributed));
        if (give > 0) {
          txns.push({
            id: null,
            from: loser.name,
            to: winner.name,
            amount: give,
            paid: false,
            paidAt: null,
            method: null,
          });
          winner.need -= give;
          distributed += give;
        }
      }

      remaining -= distributed;
      if (distributed <= 0) break;
    }
  });

  return txns.map((t, i) => ({
    ...t,
    id: t.id || `${t.from}|${t.to}|${t.amount}|${i}`,
  }));
}

function computeSession(live) {
  const cashPerBuyIn = Math.max(1, Number(live.buyInCashAmount) || 50);
  const chipsPerBuyIn = Math.max(1, Number(live.buyInChipStack) || 50);
  const chipsPerDollar = chipsPerBuyIn / cashPerBuyIn;
  const prizeEnabled = !!live.prizeEnabled;
  const prizePerPlayer = Math.max(0, Number(live.prizePerPlayer) || 0);

  let players = (live.players || []).map((p) => {
    const buyIns = Math.max(0, parseInt(p.buyIns || 0, 10) || 0);
    const cashOut = Number(p.cashOut || 0);
    const buyInCash = round2(buyIns * cashPerBuyIn);
    const buyInChips = Math.round(buyIns * chipsPerBuyIn);
    const baseNetCash = round2(cashOut - buyInCash);
    return {
      ...p,
      buyIns,
      cashOut,
      buyInCash,
      buyInChips,
      baseNetCash,
      prizeAdj: 0,
      netCash: baseNetCash,
      netChips: Math.round(baseNetCash * chipsPerDollar),
      label: safeName(p.name),
    };
  });

  const playerCount = players.length;
  let prizePool = 0;
  let winnerNames = [];
  let winnerPayoutEach = 0;
  if (prizeEnabled && prizePerPlayer > 0 && playerCount >= 2) {
    const topNet = Math.max(...players.map((p) => p.baseNetCash));
    const winners = players.filter((p) => Math.abs(p.baseNetCash - topNet) < 0.0001);
    winnerNames = winners.map((w) => w.label);
    prizePool = round2(prizePerPlayer * playerCount);
    winnerPayoutEach = winners.length > 0 ? round2(prizePool / winners.length) : 0;

    players = players.map((p) => {
      const isWinner = winnerNames.includes(p.label);
      const prizeAdj = round2((isWinner ? winnerPayoutEach : 0) - prizePerPlayer);
      const netCash = round2(p.baseNetCash + prizeAdj);
      return {
        ...p,
        prizeAdj,
        netCash,
        netChips: Math.round(netCash * chipsPerDollar),
      };
    });
  }

  const potCash = round2(players.reduce((a, p) => a + p.buyInCash, 0));
  const potChips = players.reduce((a, p) => a + p.buyInChips, 0);
  const cashOutTotal = round2(players.reduce((a, p) => a + p.buyInCash + p.netCash, 0));
  const diff = round2(cashOutTotal - potCash);

  const leader =
    players.length > 0
      ? [...players].sort((a, b) => b.baseNetCash - a.baseNetCash)[0]
      : null;

  const txnsNoPrize = settleEqualSplitCapped(
    players.map((p) => ({ name: p.label, net: p.baseNetCash }))
  );
  const txnsWithPrize = settleEqualSplitCapped(
    players.map((p) => ({ name: p.label, net: p.netCash }))
  );

  return {
    players,
    txnsNoPrize,
    txnsWithPrize,
    potCash,
    potChips,
    cashOutTotal,
    diff,
    chipsPerDollar,
    leader,
    cashPerBuyIn,
    chipsPerBuyIn,
    prizeEnabled,
    prizePerPlayer,
    prizePool,
    winnerNames,
    winnerPayoutEach,
  };
}

function normalizeTransferList(txns) {
  return (Array.isArray(txns) ? txns : []).map((t) => ({
    ...t,
    paid: !!t.paid,
    paidAt: t.paid ? t.paidAt || null : null,
  }));
}

function getSessionTransfers(session, mode) {
  const players = Array.isArray(session?.players) ? session.players : [];
  const deriveNoPrize = () =>
    settleEqualSplitCapped(
      players.map((p) => ({
        name: safeName(p.name),
        net:
          typeof p.baseNetCash === "number"
            ? p.baseNetCash
            : round2((p.netCash || 0) - (p.prizeAdj || 0)),
      }))
    );

  if (mode === "noPrize") {
    if (Array.isArray(session?.txnsNoPrize)) return normalizeTransferList(session.txnsNoPrize);
    return normalizeTransferList(deriveNoPrize());
  }
  if (Array.isArray(session?.txnsWithPrize)) return normalizeTransferList(session.txnsWithPrize);
  if (Array.isArray(session?.txns)) return normalizeTransferList(session.txns);
  return normalizeTransferList(
    settleEqualSplitCapped(
      players.map((p) => ({ name: safeName(p.name), net: p.netCash || 0 }))
    )
  );
}

function aggregateOutstanding(history, mode) {
  const rows = [];
  history.forEach((h) => {
    getSessionTransfers(h, mode).forEach((t) => {
      if (!t.paid) {
        rows.push({
          mode,
          sessionId: h.id,
          sessionStamp: h.stamp,
          from: t.from,
          to: t.to,
          amount: t.amount,
          txId: t.id,
        });
      }
    });
  });
  return rows.sort((a, b) => b.sessionStamp.localeCompare(a.sessionStamp));
}

function groupOutstandingByPlayer(rows) {
  const byPlayer = new Map();

  const ensure = (name) => {
    if (!byPlayer.has(name)) {
      byPlayer.set(name, {
        name,
        owes: [],
        owedBy: [],
        totalOwes: 0,
        totalOwedBy: 0,
      });
    }
    return byPlayer.get(name);
  };

  rows.forEach((row) => {
    const from = ensure(row.from);
    const to = ensure(row.to);

    from.owes.push(row);
    from.totalOwes = round2(from.totalOwes + row.amount);

    to.owedBy.push(row);
    to.totalOwedBy = round2(to.totalOwedBy + row.amount);
  });

  return Array.from(byPlayer.values()).sort((a, b) => {
    const aNet = a.totalOwedBy - a.totalOwes;
    const bNet = b.totalOwedBy - b.totalOwes;
    return Math.abs(bNet) - Math.abs(aNet) || a.name.localeCompare(b.name);
  });
}

function buildPlayerDebtTrackers(history) {
  const map = new Map();
  const sessions = [...(Array.isArray(history) ? history : [])].sort(
    (a, b) => (b?.stamp || "").localeCompare(a?.stamp || "")
  );

  sessions.forEach((h) => {
    const txns = normalizeTransferList(getSessionTransfers(h, "noPrize")).filter((t) => !t.paid);
    const involved = new Set();

    txns.forEach((t) => {
      involved.add(t.from);
      involved.add(t.to);
    });

    involved.forEach((name) => {
      if (!map.has(name)) {
        map.set(name, {
          player: name,
          totalOwes: 0,
          totalOwed: 0,
          sessions: [],
        });
      }
      const row = map.get(name);
      const owes = txns.filter((t) => t.from === name);
      const owed = txns.filter((t) => t.to === name);
      const owesTotal = round2(owes.reduce((a, t) => a + t.amount, 0));
      const owedTotal = round2(owed.reduce((a, t) => a + t.amount, 0));
      row.totalOwes = round2(row.totalOwes + owesTotal);
      row.totalOwed = round2(row.totalOwed + owedTotal);
      row.sessions.push({
        sessionId: h.id,
        stamp: h.stamp,
        owesTo: owes
          .reduce((m, t) => m.set(t.to, round2((m.get(t.to) || 0) + t.amount)), new Map()),
        owedBy: owed
          .reduce((m, t) => m.set(t.from, round2((m.get(t.from) || 0) + t.amount)), new Map()),
        owesTotal,
        owedTotal,
      });
    });
  });

  return Array.from(map.values())
    .map((p) => ({
      ...p,
      sessions: p.sessions.map((s) => ({
        ...s,
        owesTo: Array.from(s.owesTo.entries()).map(([name, amount]) => ({ name, amount })),
        owedBy: Array.from(s.owedBy.entries()).map(([name, amount]) => ({ name, amount })),
      })),
      net: round2(p.totalOwed - p.totalOwes),
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.player.localeCompare(b.player));
}

function useAnimatedNumber(target, durationMs = 200) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef(null);

  useEffect(() => {
    const from = Number(fromRef.current || 0);
    const to = Number(target || 0);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
    if (Math.abs(to - from) < 0.0001) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
    const start = performance.now();
    if (frameRef.current) cancelAnimationFrame(frameRef.current);

    const tick = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (to - from) * eased;
      setDisplay(next);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs]);

  return display;
}

function getPrizePaymentsForSession(session) {
  const prizePerPlayer = Math.max(0, Number(session?.settings?.prizePerPlayer || 0));
  if (!session?.settings?.prizeEnabled || prizePerPlayer <= 0) return [];

  if (Array.isArray(session?.prizePayments)) {
    return session.prizePayments.map((p) => ({
      ...p,
      paid: !!p.paid,
      paidAt: p.paid ? p.paidAt || null : null,
    }));
  }

  const players = (session?.players || []).map((p, idx) => {
    const name = safeName(p?.name);
    const baseNet =
      typeof p?.baseNetCash === "number"
        ? p.baseNetCash
        : round2((p?.netCash || 0) - (p?.prizeAdj || 0));
    return { idx, name, baseNet };
  });
  if (!players.length) return [];

  const top = Math.max(...players.map((p) => p.baseNet));
  const winnerIdx = players
    .filter((p) => Math.abs(p.baseNet - top) < 0.0001)
    .map((p) => p.idx);
  if (!winnerIdx.length) return [];

  const contributors = players.filter((p) => !winnerIdx.includes(p.idx));
  const winners = players.filter((p) => winnerIdx.includes(p.idx));
  if (!contributors.length || !winners.length) return [];

  // If there are multiple winners, assign payers to winners in round-robin.
  return contributors.map((fromPlayer, i) => ({
    id: `prize:${fromPlayer.idx}:${winners[i % winners.length].idx}:${prizePerPlayer}:${i}`,
    from: fromPlayer.name,
    to: winners[i % winners.length].name,
    amount: prizePerPlayer,
    paid: false,
    paidAt: null,
  }));
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, message: String(error?.message || error || "Unknown error") };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="app">
          <section className="panel" style={{ marginTop: 16 }}>
            <h3>App Render Error</h3>
            <div className="neg" style={{ marginTop: 8 }}>{this.state.message}</div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Refresh the page. If this persists, clear malformed history entry via Admin Settings.
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}

function MainApp() {
  const [db, setDB] = useState(() => loadDB());
  const [syncState, setSyncState] = useState(() => (hasDatabase() ? "connecting" : "local-only"));
  const [syncError, setSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [pendingCloudWrite, setPendingCloudWrite] = useState(false);
  const [manualSyncBusy, setManualSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [syncBootstrapped, setSyncBootstrapped] = useState(() => !hasDatabase());
  const [currentUserId, setCurrentUserId] = useState(
    () => localStorage.getItem(SESSION_KEY) || ""
  );
  const [showRlsHelp, setShowRlsHelp] = useState(false);
  const [tab, setTab] = useState("home");
  const [playerDebtOpen, setPlayerDebtOpen] = useState({});
  const [historyOpen, setHistoryOpen] = useState({});
  const [statsCompact, setStatsCompact] = useState(false);
  const [flashMap, setFlashMap] = useState({});
  const [activeEditPlayerId, setActiveEditPlayerId] = useState("");
  const [toasts, setToasts] = useState([]);
  const backupInputRef = useRef(null);
  const dbRef = useRef(db);
  const syncStateRef = useRef(syncState);
  const lastSyncAtRef = useRef(lastSyncAt);
  const pendingCloudWriteRef = useRef(pendingCloudWrite);
  const toastSeqRef = useRef(0);

  useEffect(() => {
    dbRef.current = db;
  }, [db]);

  useEffect(() => {
    syncStateRef.current = syncState;
  }, [syncState]);

  useEffect(() => {
    lastSyncAtRef.current = lastSyncAt;
  }, [lastSyncAt]);

  useEffect(() => {
    pendingCloudWriteRef.current = pendingCloudWrite;
  }, [pendingCloudWrite]);

  useEffect(() => {
    const onScroll = () => {
      setStatsCompact(window.scrollY > 14);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function pushToast(message) {
    const id = `toast-${Date.now()}-${toastSeqRef.current++}`;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2400);
  }

  function flashField(key, tone = "neutral") {
    setFlashMap((prev) => ({ ...prev, [key]: tone }));
    window.setTimeout(() => {
      setFlashMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 220);
  }

  function applyLocalState(nextState, broadcast = true) {
    setDB(nextState);
    localStorage.setItem(DB_KEY, JSON.stringify(nextState));
    if (!broadcast) return;
    const channel = new BroadcastChannel("classmates_live");
    channel.postMessage({ type: "db-update", payload: nextState });
    channel.close();
  }

  function writePresence(nextPresence) {
    setDB((prev) => {
      const next = {
        ...prev,
        presence: nextPresence,
      };
      localStorage.setItem(DB_KEY, JSON.stringify(next));
      const channel = new BroadcastChannel("classmates_live");
      channel.postMessage({ type: "db-update", payload: next });
      channel.close();
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    const channel = new BroadcastChannel("classmates_live");

    const applyIncoming = (incoming, options = {}) => {
      if (!incoming || typeof incoming !== "object") return;
      const preferIncoming = !!options.preferIncoming;
      setDB((prev) => {
        const next = preferIncoming ? incoming : pickNewestState(prev, incoming);
        localStorage.setItem(DB_KEY, JSON.stringify(next));
        return next;
      });
    };

    const onStorage = (e) => {
      if (e.key === DB_KEY && e.newValue) {
        try {
          applyIncoming(JSON.parse(e.newValue));
        } catch {}
      }
    };

    const onChannel = (evt) => {
      if (evt?.data?.type === "db-update" && evt.data.payload) {
        applyIncoming(evt.data.payload);
      }
    };

    channel.addEventListener("message", onChannel);
    window.addEventListener("storage", onStorage);

    let unsubscribeDb = () => {};
    let isRefreshing = false;
    if (hasDatabase()) {
      const refreshRemoteNow = async () => {
        if (cancelled || isRefreshing) return;
        isRefreshing = true;
        try {
          const remote = await fetchDatabaseState();
          if (cancelled) return;
          if (remote && typeof remote === "object") {
            const local = dbRef.current;
            if (compareStateFreshness(local, remote) > 0) {
              await pushDatabaseState(local);
            } else {
              applyIncoming(remote);
            }
          }
          setSyncState("connected");
          setSyncError("");
          setPendingCloudWrite(false);
          setLastSyncAt(new Date().toISOString());
        } catch (err) {
          if (cancelled) return;
          setSyncState("error");
          setSyncError(String(err?.message || err || "Database sync refresh failed"));
        } finally {
          isRefreshing = false;
        }
      };

      setSyncState("connecting");
      setSyncError("");
      unsubscribeDb = subscribeDatabaseState((incoming) => {
        if (cancelled) return;
        applyIncoming(incoming);
        setSyncState("connected");
        setSyncError("");
        setPendingCloudWrite(false);
        setLastSyncAt(new Date().toISOString());
      });
      (async () => {
        try {
          const remote = await fetchDatabaseState();
          if (cancelled) return;
          if (remote && typeof remote === "object") {
            // Remote state is the source of truth once database sync is enabled.
            applyIncoming(remote, { preferIncoming: true });
          } else {
            await pushDatabaseState(dbRef.current);
          }
          setSyncState("connected");
          setPendingCloudWrite(false);
          setLastSyncAt(new Date().toISOString());
        } catch (err) {
          if (cancelled) return;
          setSyncState("error");
          setSyncError(String(err?.message || err || "Database sync failed"));
        } finally {
          if (!cancelled) setSyncBootstrapped(true);
        }
      })();

      const pollId = window.setInterval(async () => {
        try {
          const remote = await fetchDatabaseState();
          if (cancelled || !remote || typeof remote !== "object") return;
          const local = dbRef.current;
          if (compareStateFreshness(local, remote) > 0) {
            await pushDatabaseState(local);
          } else {
            applyIncoming(remote);
          }
          setSyncState("connected");
          setSyncError("");
          setPendingCloudWrite(false);
          setLastSyncAt(new Date().toISOString());
        } catch (err) {
          if (cancelled) return;
          setSyncState("error");
          setSyncError(String(err?.message || err || "Database poll failed"));
        }
      }, 4000);

      const staleId = window.setInterval(() => {
        if (cancelled) return;
        const lastTs = Date.parse(lastSyncAtRef.current || "") || 0;
        const stale = !lastTs || Date.now() - lastTs > SYNC_STALE_MS;
        if (stale && syncStateRef.current !== "error") {
          setSyncState("connecting");
        }
      }, 5000);

      const onWake = () => {
        if (cancelled) return;
        setSyncState("connecting");
        refreshRemoteNow();
      };

      const onVisibility = () => {
        if (document.visibilityState === "visible") onWake();
      };

      window.addEventListener("focus", onWake);
      window.addEventListener("online", onWake);
      document.addEventListener("visibilitychange", onVisibility);

      return () => {
        cancelled = true;
        window.clearInterval(pollId);
        window.clearInterval(staleId);
        unsubscribeDb();
        window.removeEventListener("focus", onWake);
        window.removeEventListener("online", onWake);
        document.removeEventListener("visibilitychange", onVisibility);
        channel.close();
        window.removeEventListener("storage", onStorage);
      };
    }

    return () => {
      cancelled = true;
      unsubscribeDb();
      channel.close();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  function commit(next) {
    const now = new Date().toISOString();
    const prevRev = Number(dbRef.current?.rev || 0);
    const stamped = {
      ...next,
      rev: prevRev + 1,
      updatedAt: now,
      live: { ...(next.live || {}), updatedAt: now },
    };
    applyLocalState(stamped, true);
    if (hasDatabase()) {
      setPendingCloudWrite(true);
      pushDatabaseState(stamped)
        .then(() => {
          setSyncState("connected");
          setSyncError("");
          setPendingCloudWrite(false);
          setLastSyncAt(new Date().toISOString());
        })
        .catch((err) => {
          setSyncState("error");
          setSyncError(String(err?.message || err || "Database write failed"));
        });
    }
  }

  async function manualSyncNow() {
    if (!hasDatabase() || manualSyncBusy) return;
    setManualSyncBusy(true);
    setSyncState("connecting");
    setSyncError("");
    setSyncNote("");
    try {
      const remote = await fetchDatabaseState();
      const local = dbRef.current;
      let message = "Already up to date.";

      if (remote && typeof remote === "object") {
        const freshness = compareStateFreshness(local, remote);
        if (freshness > 0) {
          await pushDatabaseState(local);
          message = "Synced local changes to cloud.";
        } else if (freshness < 0) {
          setDB(() => {
            localStorage.setItem(DB_KEY, JSON.stringify(remote));
            return remote;
          });
          message = "Pulled latest data from cloud.";
        }
      } else {
        await pushDatabaseState(local);
        message = "Cloud state initialized from this device.";
      }

      setSyncState("connected");
      setPendingCloudWrite(false);
      setLastSyncAt(new Date().toISOString());
      setSyncNote(message);
    } catch (err) {
      setSyncState("error");
      setSyncError(String(err?.message || err || "Manual sync failed"));
    } finally {
      setManualSyncBusy(false);
    }
  }

  const currentUser = useMemo(() => {
    const user = (db.users || []).find((u) => u.id === currentUserId);
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      name: user.username,
      lastLoginAt: user.lastLoginAt || null,
    };
  }, [db.users, currentUserId]);

  useEffect(() => {
    if (hasDatabase() && !syncBootstrapped) return;
    if (currentUser) return;
    const users = Array.isArray(db.users) ? db.users : [];
    let deviceId = localStorage.getItem(DEVICE_KEY) || "";
    if (!deviceId) {
      deviceId = uid();
      localStorage.setItem(DEVICE_KEY, deviceId);
    }
    const now = new Date().toISOString();

    const existingForDevice = users.find((u) => u.id === deviceId);
    if (existingForDevice) {
      localStorage.setItem(SESSION_KEY, existingForDevice.id);
      setCurrentUserId(existingForDevice.id);
      return;
    }

    const guest = {
      id: deviceId,
      username: `player_${uid().slice(0, 4)}`,
      password: "",
      createdAt: now,
      lastLoginAt: now,
    };
    const nextUsers = normalizeUsers([...(users || []), guest]);
    commit({ ...db, users: nextUsers });
    localStorage.setItem(SESSION_KEY, guest.id);
    setCurrentUserId(guest.id);
  }, [currentUser, db.users, syncBootstrapped]);

  useEffect(() => {
    if (!currentUser) return;

    const stampOnline = () => {
      const now = new Date().toISOString();
      const prevPresence =
        dbRef.current?.presence && typeof dbRef.current.presence === "object"
          ? dbRef.current.presence
          : {};
      const existing = prevPresence[currentUser.id] || {};
      writePresence({
        ...prevPresence,
        [currentUser.id]: {
          userId: currentUser.id,
          name: currentUser.username,
          username: currentUser.username,
          lastSeenAt: now,
          lastLoginAt: existing.lastLoginAt || currentUser.lastLoginAt || now,
        },
      });
    };

    stampOnline();
    const timer = window.setInterval(stampOnline, 30000);
    return () => window.clearInterval(timer);
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    const chips = Number(db?.live?.buyInChipStack || 0);
    if (chips > 1) return;
    updateLive((live) => ({
      ...live,
      buyInChipStack: 50,
    }));
  }, [currentUser, db?.live?.buyInChipStack]);

  function updateLive(fn) {
    const nextLive = fn({ ...(db.live || defaultDB().live) });
    commit({
      ...db,
      live: {
        ...nextLive,
        updatedBy: currentUser?.name || "Unknown",
        updatedAt: new Date().toISOString(),
      },
    });
  }
  const computed = useMemo(() => computeSession(db.live), [db.live]);
  const lastClear = useMemo(
    () =>
      (db.adminEvents || [])
        .filter((e) => e.action === "clear-all-session-data")
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null,
    [db.adminEvents]
  );
  const outstandingNoPrize = useMemo(
    () => aggregateOutstanding(db.history, "noPrize"),
    [db.history]
  );
  const playerDebtTrackers = useMemo(
    () => buildPlayerDebtTrackers(db.history),
    [db.history]
  );
  const presenceRows = useMemo(() => {
    const now = Date.now();
    const users = Array.isArray(db.users) ? db.users : [];
    const presence = db.presence || {};
    return users
      .map((u) => {
        const p = presence[u.id] || {};
        const seenTs = Date.parse(p.lastSeenAt || "") || 0;
        return {
          userId: u.id || "",
          username: safeName(u.username || p.username || p.name || "player").toLowerCase(),
          name: safeName(u.username || p.username || p.name || "Player"),
          lastSeenAt: p.lastSeenAt || null,
          lastLoginAt: u.lastLoginAt || p.lastLoginAt || u.createdAt || null,
          online: seenTs > 0 && now - seenTs <= ONLINE_WINDOW_MS,
        };
      })
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.username.localeCompare(b.username);
      });
  }, [db.presence, db.users]);

  function setCashBuyIn(v) {
    updateLive((live) => ({
      ...live,
      buyInCashAmount: Math.max(1, Number(v) || 1),
    }));
  }

  function setChipStack(v) {
    updateLive((live) => ({
      ...live,
      buyInChipStack: Math.max(1, Number(v) || 1),
    }));
  }

  function setPrizeEnabled(v) {
    updateLive((live) => ({ ...live, prizeEnabled: !!v }));
  }

  function setPrizePerPlayer(v) {
    updateLive((live) => ({
      ...live,
      prizePerPlayer: Math.max(0, Number(v) || 0),
    }));
  }

  function updatePlayer(playerId, patch) {
    const prevPlayer = (db.live?.players || []).find((p) => p.id === playerId) || null;
    if (Object.prototype.hasOwnProperty.call(patch, "buyIns")) {
      const prevVal = Number(prevPlayer?.buyIns || 0);
      const nextVal = Number(patch.buyIns || 0);
      flashField(`${playerId}-buyins`, nextVal > prevVal ? "up" : "neutral");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "cashOut")) {
      const prevVal = Number(prevPlayer?.cashOut || 0);
      const nextVal = Number(patch.cashOut || 0);
      flashField(`${playerId}-cashout`, nextVal > prevVal ? "up" : "neutral");
    }
    setActiveEditPlayerId(playerId);
    updateLive((live) => ({
      ...live,
      players: live.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)),
    }));
  }

  function addPlayer() {
    updateLive((live) => ({ ...live, players: [...live.players, blankPlayer()] }));
    pushToast("➕ Player added");
  }

  function removePlayer(id) {
    updateLive((live) => {
      const filtered = live.players.filter((p) => p.id !== id);
      return {
        ...live,
        players: filtered.length ? filtered : [blankPlayer(), blankPlayer()],
      };
    });
  }

  function applyLastLineup() {
    const last = db.history[0];
    if (!last || !Array.isArray(last.players) || !last.players.length) {
      alert("No history yet.");
      return;
    }
    updateLive((live) => ({
      ...live,
      players: last.players.map((p) => ({ id: uid(), name: p.name || "", buyIns: 0, cashOut: 0 })),
    }));
  }

  function endAndSaveSession() {
    if (db.live.players.length < 2) {
      alert("Add at least 2 players.");
      return;
    }
    if (Math.abs(computed.diff) > 0.01) {
      alert("Session is not balanced. Adjust cash-outs first.");
      return;
    }

    const snapshot = {
      id: uid(),
      stamp: new Date().toISOString(),
      settings: {
        buyInCashAmount: computed.cashPerBuyIn,
        buyInChipStack: computed.chipsPerBuyIn,
        chipsPerDollar: computed.chipsPerDollar,
        prizeEnabled: computed.prizeEnabled,
        prizePerPlayer: computed.prizePerPlayer,
        prizePool: computed.prizePool,
        winnerNames: computed.winnerNames,
      },
      players: computed.players.map((p) => ({
        name: p.label,
        buyIns: p.buyIns,
        buyInCash: p.buyInCash,
        buyInChips: p.buyInChips,
        cashOut: p.cashOut,
        baseNetCash: p.baseNetCash,
        prizeAdj: p.prizeAdj,
        netCash: p.netCash,
        netChips: p.netChips,
      })),
      totals: {
        potCash: computed.potCash,
        potChips: computed.potChips,
        cashOutTotal: computed.cashOutTotal,
        diff: computed.diff,
      },
      txns: normalizeTransferList(computed.txnsWithPrize),
      txnsNoPrize: normalizeTransferList(computed.txnsNoPrize),
      txnsWithPrize: normalizeTransferList(computed.txnsWithPrize),
      savedBy: currentUser?.name || "Unknown",
    };

    const nextLive = {
      ...db.live,
      players: db.live.players.map((p) => ({ ...p, buyIns: 0, cashOut: 0 })),
    };

    const nextHistory = [snapshot, ...db.history];
    const autoBackupCsv = dbToCsvPayload({
      ...db,
      history: nextHistory,
      live: nextLive,
      autoBackups: db.autoBackups || [],
    });

    commit({
      ...db,
      history: nextHistory,
      live: nextLive,
      autoBackups: [
        {
          id: uid(),
          at: new Date().toISOString(),
          by: currentUser?.username || "Unknown",
          label: "Auto backup after session",
          csv: autoBackupCsv,
        },
        ...((db.autoBackups || []).slice(0, 19)),
      ],
    });

    setTab("history");
    pushToast("✔ Session saved");
  }

  function markTransfer(sessionId, txId, paid, mode) {
    const nextHistory = db.history.map((h) => {
      if (h.id !== sessionId) return h;
      const key = mode === "noPrize" ? "txnsNoPrize" : "txnsWithPrize";
      const source = getSessionTransfers(h, mode);
      return {
        ...h,
        [key]: source.map((t) =>
          t.id === txId
            ? {
                ...t,
                paid,
                paidAt: paid ? new Date().toISOString() : null,
              }
            : t
        ),
      };
    });
    commit({ ...db, history: nextHistory });
  }

  function setPrizePaymentStatus(sessionId, paymentId, paid) {
    const nextHistory = db.history.map((h) => {
      if (h.id !== sessionId) return h;
      const source = getPrizePaymentsForSession(h);
      return {
        ...h,
        prizePayments: source.map((p) =>
          p.id === paymentId
            ? {
                ...p,
                paid,
                paidAt: paid ? new Date().toISOString() : null,
              }
            : p
        ),
      };
    });
    commit({ ...db, history: nextHistory });
  }

  function resetLive() {
    if (!window.confirm("Reset live session players and values?")) return;
    updateLive((live) => ({
      ...live,
      buyInCashAmount: 50,
      buyInChipStack: 50,
      prizeEnabled: true,
      prizePerPlayer: 20,
      players: [blankPlayer(), blankPlayer()],
    }));
    pushToast("⚠ Reset complete");
  }

  function clearAllSessionData() {
    const ok = window.confirm(
      "Clear all session data?\n\nThis will remove all saved history and reset the live session board."
    );
    if (!ok) return;
    const ok2 = window.confirm(
      "This cannot be undone. Confirm clear all session data now?"
    );
    if (!ok2) return;

    const fresh = defaultDB();
    commit({
      ...db,
      live: {
        ...fresh.live,
        updatedBy: currentUser?.name || "Unknown",
      },
      adminEvents: [
        {
          id: uid(),
          action: "clear-all-session-data",
          by: currentUser?.name || "Unknown",
          byUserId: currentUser?.id || null,
          at: new Date().toISOString(),
        },
        ...(Array.isArray(db.adminEvents) ? db.adminEvents : []),
      ],
      history: [],
    });
    setPlayerDebtOpen({});
    setHistoryOpen({});
    setTab("live");
  }

  function downloadBackup() {
    const csv = dbToCsvPayload(db);
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `classmates-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadSessionReportCsv() {
    const csv = historyToSessionReportCsv(db.history || []);
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `classmates-session-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadBackupCsv(csv, label = "classmates-backup") {
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadSessionReportFromBackupCsv(csv, label = "classmates-session-report") {
    try {
      const parsed = csvPayloadToDb(String(csv || ""));
      const report = historyToSessionReportCsv(parsed.history || []);
      const blob = new Blob([report], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      alert(`Session report export failed: ${e?.message || e}`);
    }
  }

  function restoreBackupFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const safe = csvPayloadToDb(String(reader.result || ""));
        const ok = window.confirm("Restore backup and replace current app data?");
        if (!ok) return;
        commit(safe);
        alert("CSV backup restored.");
      } catch (e) {
        alert(`CSV restore failed: ${e?.message || e}`);
      } finally {
        if (backupInputRef.current) backupInputRef.current.value = "";
      }
    };
    reader.readAsText(file);
  }

  const recentGames = (db.history || []).slice(0, 3);
  const biggestPotGame = useMemo(() => {
    if (!Array.isArray(db.history) || db.history.length === 0) return null;
    return db.history.reduce((best, game) => {
      const pot = Number(game?.totals?.potCash || 0);
      const bestPot = Number(best?.totals?.potCash || 0);
      return pot > bestPot ? game : best;
    }, db.history[0]);
  }, [db.history]);
  const latestWinnerLabel = useMemo(() => {
    if (!Array.isArray(db.history) || db.history.length === 0) return "-";
    const latest = db.history[0];
    const winners = Array.isArray(latest?.settings?.winnerNames) ? latest.settings.winnerNames : [];
    return winners.length ? winners.join(", ") : "-";
  }, [db.history]);
  const syncAgeMs = Date.now() - (Date.parse(lastSyncAt || "") || 0);
  const syncHeartbeatStale = hasDatabase() && syncState === "connected" && syncAgeMs > SYNC_STALE_MS;
  const syncPending = hasDatabase() && (pendingCloudWrite || manualSyncBusy);
  const animatedPot = useAnimatedNumber(computed.potCash, 190);
  const animatedChips = useAnimatedNumber(computed.potChips, 190);
  const animatedDiff = useAnimatedNumber(computed.diff, 190);
  const diffUnbalanced = Math.abs(computed.diff) > 0.01;
  const syncStatusText = syncPending
    ? "Syncing changes..."
    : syncHeartbeatStale
      ? "Sync delayed · reconnecting..."
      : syncState === "connected"
        ? `Connected${lastSyncAt ? ` · ${new Date(lastSyncAt).toLocaleTimeString()}` : ""}`
        : syncState === "connecting"
          ? "Syncing..."
          : syncState === "error"
            ? "Sync issue"
            : "Local only";
  const syncStatusTone =
    syncState === "error" ? "error" : syncState === "connected" && !syncHeartbeatStale && !syncPending ? "connected" : "muted";
  const navTabs = [
    { key: "home", label: "Home" },
    { key: "live", label: "Live Session" },
    { key: "debts", label: "Debts" },
    { key: "history", label: "History" },
    { key: "settings", label: "Settings" },
  ];
  const visiblePresenceRows = presenceRows.slice(0, 7);

  if (!currentUser) {
    return (
      <div className="app auth-bg">
        <div className="auth-shell">
          <div className="panel auth-panel">
            <div className="muted">Loading app...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="content">
        <section className="space-y-4">
          <SessionHeader user={currentUser.name} />
        </section>

        <div
          className={`stats-hero-wrap ${statsCompact ? "is-sticky" : ""} ${
            diffUnbalanced ? "difference-unbalanced" : "difference-balanced"
          }`}
        >
          <StatsHero
            potCash={money(animatedPot)}
            chips={Math.round(animatedChips).toLocaleString()}
            difference={money(animatedDiff)}
            compact={statsCompact}
          />
        </div>

        <section className="space-y-4">
          <SyncStatusInline
            statusText={syncStatusText}
            statusTone={syncStatusTone}
            role="Admin"
            syncNote={syncNote}
            onSyncNow={manualSyncNow}
            syncBusy={manualSyncBusy}
            syncDisabled={!hasDatabase()}
          />
          {tab === "live" ? (
            <QuickActionsTop onAddPlayer={addPlayer} onLoadLineup={applyLastLineup} />
          ) : null}
        </section>

        <PrimaryNavTabs tabs={navTabs} activeTab={tab} onChange={setTab} />

        <div key={tab} className="tab-switch-anim">
        {tab === "home" && (
          <section className="space-y-3">
            <HighlightCard
              label="Home Highlight"
              value={biggestPotGame ? money(biggestPotGame?.totals?.potCash || 0) : "-"}
              detail={
                biggestPotGame
                  ? `Biggest pot · ${new Date(biggestPotGame.stamp).toLocaleString()} · ${(biggestPotGame.players || []).length} players`
                  : `Last winner: ${latestWinnerLabel}`
              }
            />

            <SimpleListCard title="Recent Games">
              {recentGames.length === 0 ? (
                <div className="text-sm text-emerald-200/65">No saved games yet.</div>
              ) : (
                recentGames.map((g) => (
                  <div key={g.id} className="flex items-center justify-between rounded-xl bg-black/10 px-3 py-2 text-sm">
                    <span className="text-emerald-50">{new Date(g.stamp).toLocaleString()}</span>
                    <span className="text-emerald-200/80">Pot {money(g.totals?.potCash || 0)}</span>
                  </div>
                ))
              )}
            </SimpleListCard>

            <SimpleListCard title="Players Online">
              {presenceRows.length === 0 ? (
                <div className="text-sm text-emerald-200/65">No active user records yet.</div>
              ) : (
                visiblePresenceRows.map((p) => (
                  <div
                    key={p.userId || p.username || p.name}
                    className="flex items-start justify-between rounded-xl bg-black/10 px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="font-semibold text-emerald-50">{p.name}</div>
                      <div className="text-xs text-emerald-200/65">
                        Last login: {p.lastLoginAt ? new Date(p.lastLoginAt).toLocaleString() : "-"}
                      </div>
                    </div>
                    <span className={p.online ? "text-emerald-300" : "text-emerald-200/65"}>
                      {p.online ? "Online" : "Away"}
                    </span>
                  </div>
                ))
              )}
              {presenceRows.length > visiblePresenceRows.length ? (
                <div className="text-xs text-emerald-200/60">
                  Showing {visiblePresenceRows.length} of {presenceRows.length} users.
                </div>
              ) : null}
            </SimpleListCard>
          </section>
        )}

        {tab === "settings" && (
          <>
            <section className="panel settings-grid">
              <label>
                1 Buy-in (Cash)
                <input
                  type="number"
                  min="1"
                  value={db.live.buyInCashAmount}
                  onChange={(e) => setCashBuyIn(e.target.value)}
                />
              </label>
              <label>
                1 Buy-in (Chip Stack)
                <input
                  type="number"
                  min="1"
                  value={db.live.buyInChipStack}
                  onChange={(e) => setChipStack(e.target.value)}
                />
              </label>
              <label>
                Prize per player (AUD)
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={db.live.prizePerPlayer}
                  onChange={(e) => setPrizePerPlayer(e.target.value)}
                />
              </label>
              <label className="prize-toggle">
                <span>Prize mechanic enabled</span>
                <input
                  type="checkbox"
                  checked={!!db.live.prizeEnabled}
                  onChange={(e) => setPrizeEnabled(e.target.checked)}
                />
              </label>
              <div className="chip-map">
                <div className="muted">Current mapping</div>
                <strong>
                  {money(computed.cashPerBuyIn)} = {computed.chipsPerBuyIn.toLocaleString()} chips
                </strong>
                <div className="muted small">1 AUD = {computed.chipsPerDollar.toFixed(2)} chips</div>
              </div>
            </section>

            <section className="panel admin-settings-panel">
              <div className="session-summary-head">
                <h3>Database</h3>
                <span className="muted small">
                  {hasDatabase() ? "Supabase configured" : "Local mode"}
                </span>
              </div>
              <div className="muted small">
                Status:{" "}
                <span className={syncState === "error" ? "neg" : "pos"}>
                  {syncState === "local-only"
                    ? "Local only (set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)"
                    : syncState}
                </span>
              </div>
              {syncError ? (
                <div className="muted small neg" style={{ marginTop: 6 }}>
                  {syncError}
                </div>
              ) : null}
              {syncState === "error" && String(syncError || "").toLowerCase().includes("row-level security") ? (
                <div style={{ marginTop: 8 }}>
                  <button className="btn" onClick={() => setShowRlsHelp((v) => !v)}>
                    {showRlsHelp ? "Hide DB Fix SQL" : "Show DB Fix SQL"}
                  </button>
                  {showRlsHelp ? (
                    <pre className="muted small" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
{`alter table public.classmates_state enable row level security;

drop policy if exists "Allow read for anon" on public.classmates_state;
create policy "Allow read for anon" on public.classmates_state
for select to anon using (true);

drop policy if exists "Allow insert for anon" on public.classmates_state;
create policy "Allow insert for anon" on public.classmates_state
for insert to anon with check (true);

drop policy if exists "Allow update for anon" on public.classmates_state;
create policy "Allow update for anon" on public.classmates_state
for update to anon using (true) with check (true);`}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="panel admin-settings-panel">
              <div className="session-summary-head">
                <h3>Admin Settings</h3>
                <span className="muted small">Applies to all users</span>
              </div>
              <div className="admin-settings-row">
                <div>
                  <strong>Clear All Session Data</strong>
                  <div className="muted small">
                    Removes all saved session history and resets live session to empty defaults.
                  </div>
                  <div className="muted small">
                    Last clear: {lastClear ? `${new Date(lastClear.at).toLocaleString()} by ${lastClear.by}` : "never"}
                  </div>
                </div>
                <button className="btn btn-danger" onClick={clearAllSessionData}>
                  Clear Data
                </button>
              </div>
            </section>

            <section className="panel admin-settings-panel">
              <div className="session-summary-head">
                <h3>Backup</h3>
                <span className="muted small">Export or restore app data</span>
              </div>
              <div className="actions-row">
                <button className="btn btn-primary" onClick={downloadSessionReportCsv}>
                  Download Session Report (.csv)
                </button>
                <button className="btn" onClick={downloadBackup}>Download Raw Backup (.csv)</button>
                <button className="btn" onClick={() => backupInputRef.current?.click()}>
                  Restore CSV Backup
                </button>
                <input
                  ref={backupInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={(e) => restoreBackupFile(e.target.files?.[0] || null)}
                />
              </div>
              <div className="muted small">
                Restore replaces current data. Keep a fresh CSV backup before restoring another file.
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                Session Report CSV is for reading in Sheets/Excel. Raw Backup CSV is for app restore.
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>
                Auto backup is saved after every "End & Save Session" (keeps latest 20).
              </div>
              {(db.autoBackups || []).length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  {(db.autoBackups || []).slice(0, 5).map((b) => (
                    <div key={b.id} className="home-row">
                      <span>
                        {new Date(b.at).toLocaleString()} by {b.by}
                      </span>
                      <div className="actions-row">
                        <button
                          className="btn btn-primary"
                          onClick={() => downloadSessionReportFromBackupCsv(b.csv, "classmates-auto-session-report")}
                        >
                          Session Report CSV
                        </button>
                        <button
                          className="btn"
                          onClick={() => downloadBackupCsv(b.csv, "classmates-auto-backup")}
                        >
                          Raw Backup CSV
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted small" style={{ marginTop: 8 }}>
                  No auto backups yet.
                </div>
              )}
              {(db.autoBackups || []).length > 5 ? (
                <div className="muted small" style={{ marginTop: 4 }}>
                  Showing latest 5 of {(db.autoBackups || []).length} auto backups.
                </div>
              ) : null}
            </section>

          </>
        )}

        {tab === "live" && (
          <>
            <PrizeSummary computed={computed} money={money} />

            <section className="rounded-2xl bg-emerald-950/50 p-3 ring-1 ring-white/10">
              <BalanceStatus difference={computed.diff} money={money} />
              <button
                className="mt-3 rounded-xl bg-red-500/20 px-3 py-2 text-sm font-semibold text-red-200 ring-1 ring-red-200/30"
                onClick={resetLive}
              >
                Reset live board
              </button>
            </section>

            <section className="panel session-summary-panel">
              <div className="session-summary-head">
                <h3>Game Summary</h3>
                <span className="muted small">
                  Buy-ins vs cash-outs reference
                </span>
              </div>
              <div className="summary-table-wrap">
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Buy-ins</th>
                      <th>Cash-out</th>
                      <th>Net (No Prize)</th>
                      <th>Prize Adj</th>
                      <th>Net (With Prize)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computed.players.map((p) => (
                      <tr key={`sum-${p.id}`}>
                        <td>{p.label}</td>
                        <td>{p.buyIns}</td>
                        <td>{money(p.cashOut)}</td>
                        <td className={p.baseNetCash >= 0 ? "pos" : "neg"}>
                          {money(p.baseNetCash)}
                        </td>
                        <td className={p.prizeAdj >= 0 ? "pos" : "neg"}>
                          {p.prizeAdj >= 0 ? "+" : ""}{money(p.prizeAdj)}
                        </td>
                        <td className={p.netCash >= 0 ? "pos" : "neg"}>{money(p.netCash)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel table-panel">
              <div className="desktop-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Buy-ins</th>
                      <th>Buy-in Value</th>
                      <th>Cash-out</th>
                      <th>Net</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computed.players.map((p) => (
                      <tr key={p.id} className={activeEditPlayerId === p.id ? "player-edit-row editing" : "player-edit-row"}>
                        <td>
                          <input
                            className={flashMap[`${p.id}-name`] ? "field-flash-neutral" : ""}
                            value={p.name}
                            onChange={(e) => updatePlayer(p.id, { name: e.target.value })}
                            onFocus={() => setActiveEditPlayerId(p.id)}
                            placeholder="Player name"
                          />
                        </td>
                        <td>
                          <div className={`buyin-tap ${flashMap[`${p.id}-buyins`] === "up" ? "field-flash-up" : flashMap[`${p.id}-buyins`] ? "field-flash-neutral" : ""}`}>
                            <button
                              className="tap-btn"
                              onClick={() => updatePlayer(p.id, { buyIns: Math.max(0, p.buyIns - 1) })}
                            >
                              -
                            </button>
                            <span>{p.buyIns}</span>
                            <button
                              className="tap-btn"
                              onClick={() => updatePlayer(p.id, { buyIns: p.buyIns + 1 })}
                            >
                              +
                            </button>
                          </div>
                        </td>
                      <td>
                        <div>{money(p.buyInCash)}</div>
                        <div className="muted small">{p.buyInChips.toLocaleString()} chips</div>
                        {computed.prizeEnabled && (
                          <div className="prize-chip">Prize adj: {p.prizeAdj >= 0 ? "+" : ""}{money(p.prizeAdj)}</div>
                        )}
                      </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className={flashMap[`${p.id}-cashout`] === "up" ? "field-flash-up" : flashMap[`${p.id}-cashout`] ? "field-flash-neutral" : ""}
                            value={Number(p.cashOut || 0) === 0 ? "" : p.cashOut}
                            onChange={(e) => updatePlayer(p.id, { cashOut: Number(e.target.value || 0) })}
                            onFocus={() => setActiveEditPlayerId(p.id)}
                          />
                        </td>
                        <td>
                          <div className={p.baseNetCash >= 0 ? "pos" : "neg"}>
                            No prize: {money(p.baseNetCash)}
                          </div>
                          <div className={p.netCash >= 0 ? "pos" : "neg"}>
                            With prize: {money(p.netCash)}
                          </div>
                          <div className="muted small">{p.netChips.toLocaleString()} chips</div>
                        </td>
                        <td>
                          <button className="btn btn-danger" onClick={() => removePlayer(p.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mobile-player-list">
                {computed.players.map((p) => (
                  <div
                    key={`m-${p.id}`}
                    className={`mobile-player-card ${activeEditPlayerId === p.id ? "editing" : ""}`}
                  >
                    <input
                      className={flashMap[`${p.id}-name`] ? "field-flash-neutral" : ""}
                      value={p.name}
                      onChange={(e) => updatePlayer(p.id, { name: e.target.value })}
                      onFocus={() => setActiveEditPlayerId(p.id)}
                      placeholder="Player name"
                    />
                    <div className="mobile-player-row">
                      <span className="muted">Buy-ins</span>
                      <div className={`buyin-tap ${flashMap[`${p.id}-buyins`] === "up" ? "field-flash-up" : flashMap[`${p.id}-buyins`] ? "field-flash-neutral" : ""}`}>
                        <button
                          className="tap-btn"
                          onClick={() => updatePlayer(p.id, { buyIns: Math.max(0, p.buyIns - 1) })}
                        >
                          -
                        </button>
                        <span>{p.buyIns}</span>
                        <button className="tap-btn" onClick={() => updatePlayer(p.id, { buyIns: p.buyIns + 1 })}>
                          +
                        </button>
                      </div>
                    </div>
                    <div className="mobile-player-row">
                      <span className="muted">Buy-in value</span>
                      <span>{money(p.buyInCash)} · {p.buyInChips.toLocaleString()} chips</span>
                    </div>
                    <div className="mobile-player-row">
                      <span className="muted">Cash-out</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className={flashMap[`${p.id}-cashout`] === "up" ? "field-flash-up" : flashMap[`${p.id}-cashout`] ? "field-flash-neutral" : ""}
                        value={Number(p.cashOut || 0) === 0 ? "" : p.cashOut}
                        onChange={(e) => updatePlayer(p.id, { cashOut: Number(e.target.value || 0) })}
                        onFocus={() => setActiveEditPlayerId(p.id)}
                      />
                    </div>
                    <button className="btn btn-danger" onClick={() => removePlayer(p.id)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <h3>Live Settlement Preview</h3>
              {computed.txnsWithPrize.length === 0 ? (
                <div className="muted">No transfers required right now.</div>
              ) : (
                <div className="tx-grid">
                  {computed.txnsWithPrize.map((t) => (
                    <div key={t.id} className="tx-item">
                      <strong>{t.from}</strong>
                      <span> pays </span>
                      <strong>{t.to}</strong>
                      <span> {money(t.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <BottomStickyAction
              onSave={endAndSaveSession}
              disabled={Math.abs(computed.diff) > 0.01}
            />
          </>
        )}

        {tab === "debts" && (
          <section className="panel">
            <h3>Outstanding Debts</h3>
            <div className="muted small" style={{ marginBottom: 10 }}>
              Debts are based on Net No Prize only. Grouped by session and tracked by player.
            </div>
            {outstandingNoPrize.length === 0 ? (
              <div className="muted">No outstanding debts.</div>
            ) : (
              <></>
            )}
            {playerDebtTrackers.length > 0 && (
              <div className="player-tracker-wrap">
                <div className="history-group-title">Player Debt Tracker</div>
                <div className="player-tracker-list">
                  {playerDebtTrackers.map((p) => {
                    const isOpen = !!playerDebtOpen[p.player];
                    return (
                      <article key={`tracker-${p.player}`} className="player-tracker-card">
                        <button
                          className="player-tracker-head"
                          onClick={() =>
                            setPlayerDebtOpen((s) => ({ ...s, [p.player]: !s[p.player] }))
                          }
                        >
                          <div>
                            <strong>{p.player}</strong>
                            <div className="muted small">
                              Owes {money(p.totalOwes)} · Owed {money(p.totalOwed)}
                            </div>
                          </div>
                          <div className="debt-group-right">
                            <span className={p.net >= 0 ? "pos" : "neg"}>
                              Net {p.net >= 0 ? "+" : ""}{money(p.net)}
                            </span>
                            <span className="muted">{isOpen ? "Hide" : "View"}</span>
                          </div>
                        </button>
                        {isOpen && (
                          <div className="player-tracker-body">
                            <div className="history-table-wrap">
                              <table className="history-subtable history-summary-table">
                                <thead>
                                  <tr>
                                    <th>Session</th>
                                    <th>They Owe</th>
                                    <th>Owed By</th>
                                    <th>Session Owes</th>
                                    <th>Session Owed</th>
                                    <th>Session Net</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {p.sessions.map((s) => {
                                    const sessionNet = round2(s.owedTotal - s.owesTotal);
                                    return (
                                      <tr key={`${p.player}-${s.sessionId}`}>
                                        <td>{new Date(s.stamp).toLocaleString()}</td>
                                        <td>
                                          {s.owesTo.length
                                            ? s.owesTo.map((x) => `${x.name} ${money(x.amount)}`).join(", ")
                                            : "-"}
                                        </td>
                                        <td>
                                          {s.owedBy.length
                                            ? s.owedBy.map((x) => `${x.name} ${money(x.amount)}`).join(", ")
                                            : "-"}
                                        </td>
                                        <td>{money(s.owesTotal)}</td>
                                        <td>{money(s.owedTotal)}</td>
                                        <td className={sessionNet >= 0 ? "pos" : "neg"}>
                                          {sessionNet >= 0 ? "+" : ""}{money(sessionNet)}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "history" && (
          <section className="panel history-list">
            <h3>Session History</h3>
            {db.history.length === 0 ? (
              <div className="muted">No sessions saved yet.</div>
            ) : (
              db.history.map((h) => (
                <article
                  key={h.id}
                  className={"history-card " + ((historyOpen[h.id] !== false) ? "open" : "closed")}
                  onClick={() => {
                    const isOpen = historyOpen[h.id] !== false;
                    if (!isOpen) setHistoryOpen((s) => ({ ...s, [h.id]: true }));
                  }}
                >
                  {(() => {
                    const settings = h.settings || {};
                    const totals = h.totals || {};
                    const isOpen = historyOpen[h.id] !== false;
                    return (
                      <>
                  <button
                    className="history-head history-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHistoryOpen((s) => ({ ...s, [h.id]: !isOpen }));
                    }}
                  >
                    <strong>{new Date(h.stamp).toLocaleString()}</strong>
                    <span className="muted">
                      Saved by {h.savedBy} · {isOpen ? "Hide" : "View"}
                    </span>
                  </button>
                  <div className="history-meta compact">
                    <span>
                      {money(settings.buyInCashAmount || 0)} ={" "}
                      {Number(settings.buyInChipStack || 0).toLocaleString()} chips
                    </span>
                    <span>Pot: {money(totals.potCash || 0)}</span>
                  </div>
                  {settings?.prizeEnabled && isOpen && (
                    <div className="history-prize-line">
                      Prize: -{money(settings.prizePerPlayer || 0)} each · Pool{" "}
                      {money(settings.prizePool || 0)} · Winner{" "}
                      {Array.isArray(settings.winnerNames) ? settings.winnerNames.join(", ") : "-"}
                    </div>
                  )}
                  {isOpen && (
                  <>
                  <div className="history-group" onClick={(e) => e.stopPropagation()}>
                    <div className="history-group-title">Players Summary</div>
                    <div className="history-table-wrap">
                      <table className="history-subtable">
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th>Buy-ins</th>
                            <th>Cash-out</th>
                            <th>Net (No Prize)</th>
                            <th>Prize Adj</th>
                            <th>Net (With Prize)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(h.players || []).map((p) => (
                            <tr
                              key={`${h.id}-summary-${p.name}`}
                              className={
                                Array.isArray(settings.winnerNames) && settings.winnerNames.includes(p.name)
                                  ? "winner-highlight-row"
                                  : ""
                              }
                            >
                              {(() => {
                                const baseNet =
                                  typeof p.baseNetCash === "number"
                                    ? p.baseNetCash
                                    : round2((p.netCash || 0) - (p.prizeAdj || 0));
                                return (
                                  <>
                              <td>{p.name}</td>
                              <td>{p.buyIns}</td>
                              <td>{money(p.cashOut)}</td>
                              <td className={baseNet >= 0 ? "pos" : "neg"}>
                                {money(baseNet)}
                              </td>
                              <td className={(p.prizeAdj || 0) >= 0 ? "pos" : "neg"}>
                                {(p.prizeAdj || 0) >= 0 ? "+" : ""}{money(p.prizeAdj || 0)}
                              </td>
                              <td className={p.netCash >= 0 ? "pos" : "neg"}>{money(p.netCash)}</td>
                                  </>
                                );
                              })()}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="history-group" onClick={(e) => e.stopPropagation()}>
                    <div className="history-group-title">Transfers</div>
                    {(() => {
                      const txnsNoPrize = getSessionTransfers(h, "noPrize");
                      const prizePayments = getPrizePaymentsForSession(h);
                      return (
                        <>
                          <div className="history-transfer-mode">
                            <div className="muted small" style={{ marginBottom: 6 }}>Net No Prize</div>
                            {txnsNoPrize.length === 0 ? (
                            <div className="muted small">No transfers.</div>
                          ) : (
                            <div className="history-table-wrap">
                              <table className="history-subtable history-transfer-table">
                                <thead>
                                  <tr>
                                    <th>From</th>
                                    <th>To</th>
                                    <th>Amount</th>
                                    <th>Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {txnsNoPrize.map((t) => (
                                    <tr key={`noPrize-${t.id}`}>
                                      <td>{t.from}</td>
                                      <td>{t.to}</td>
                                      <td>{money(t.amount)}</td>
                                      <td className={t.paid ? "pos" : "neg"}>
                                        {t.paid ? "Paid" : "Unpaid"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          </div>
                          <div className="history-transfer-mode">
                            <div className="muted small" style={{ marginBottom: 6 }}>
                              Net With Prize (who sends {money(settings?.prizePerPlayer || 0)} to winner)
                            </div>
                            {prizePayments.length === 0 ? (
                              <div className="muted small">No prize payments.</div>
                            ) : (
                              <div className="history-table-wrap">
                                <table className="history-subtable history-prize-transfer-table">
                                  <thead>
                                    <tr>
                                      <th>From</th>
                                      <th>To</th>
                                      <th>Amount</th>
                                      <th>Paid</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {prizePayments.map((p) => (
                                      <tr key={`prize-${p.id}`}>
                                        <td>{p.from}</td>
                                        <td>{p.to}</td>
                                        <td>{money(p.amount)}</td>
                                        <td>
                                          <select
                                            value={p.paid ? "paid" : "unpaid"}
                                            onChange={(e) =>
                                              setPrizePaymentStatus(
                                                h.id,
                                                p.id,
                                                e.target.value === "paid"
                                              )
                                            }
                                          >
                                            <option value="unpaid">Unpaid</option>
                                            <option value="paid">Paid</option>
                                          </select>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  </>
                  )}
                      </>
                    );
                  })()}
                </article>
              ))
            )}
          </section>
        )}
        </div>
        <div className="toast-stack" aria-live="polite" aria-atomic="true">
          {toasts.map((t) => (
            <div key={t.id} className="toast-item">
              {t.message}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
