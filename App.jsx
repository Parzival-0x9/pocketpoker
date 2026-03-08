import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStateByKey,
  fetchDatabaseState,
  hasDatabase,
  pushDatabaseState,
  pushStateByKey,
  subscribeStateByKey,
  SYNC_STATE_KEYS,
} from "./dbSync";
import {
  BalanceStatus,
  BottomStickyAction,
  HighlightCard,
  PrimaryNavTabs,
  PrizeSummary,
  SessionHeader,
  SimpleListCard,
  StatsHero,
  SyncStatusInline,
} from "./components/DashboardHeader";
import { AuthProvider, useAuth } from "./context/AuthContext";
import LoginPage from "./pages/login";
import SignupPage from "./pages/signup";
import AuthSettingsPage from "./pages/settings";

const DB_KEY = "classmates_db_v1";
const ONLINE_WINDOW_MS = 120000;
const SYNC_STALE_MS = 45000;
const CLOUD_FETCH_TIMEOUT_MS = 7000;
const CLOUD_WRITE_DEBOUNCE_MS = 250;
const SYNC_FAILURE_THRESHOLD = 3;

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
  const rowId = uid();
  return {
    id: rowId,
    playerId: `unlinked:${rowId}`,
    linkedProfileId: null,
    name: "",
    buyIns: 0,
    buyInEntries: [],
    cashOut: 0,
  };
}

function normalizeBuyInEntries(entries, fallbackCount = 0, defaultAmount = 0) {
  const amountDefault = round2(Math.max(0, Number(defaultAmount) || 0));
  const source = Array.isArray(entries)
    ? entries.map((e) => ({
        amount: round2(Math.max(0, Number(e?.amount ?? amountDefault) || 0)),
        paid: !!e?.paid,
      }))
    : [];
  const count = Math.max(0, parseInt(fallbackCount || 0, 10) || 0);
  if (source.length >= count) return source.slice(0, count);
  return [
    ...source,
    ...Array.from({ length: count - source.length }, () => ({
      amount: amountDefault,
      paid: false,
    })),
  ];
}

function syncBuyInEntries(player, nextBuyInCount, buyInAmount) {
  const count = Math.max(0, parseInt(nextBuyInCount || 0, 10) || 0);
  const entries = normalizeBuyInEntries(player?.buyInEntries, player?.buyIns, buyInAmount);
  if (entries.length === count) return entries;
  if (entries.length > count) return entries.slice(0, count);
  return [
    ...entries,
    ...Array.from({ length: count - entries.length }, () => ({
      amount: round2(Math.max(0, Number(buyInAmount) || 0)),
      paid: false,
    })),
  ];
}

function normalizeLivePlayer(p, buyInAmount = 0) {
  const rowId = String(p?.id || uid());
  const linkedProfileId = p?.linkedProfileId ? String(p.linkedProfileId) : null;
  const playerId = String(p?.playerId || linkedProfileId || rowId);
  const buyIns = Math.max(
    0,
    parseInt(
      p?.buyIns ??
      (Array.isArray(p?.buyInEntries) ? p.buyInEntries.length : 0),
      10
    ) || 0
  );
  const defaultBuyInAmount = Math.max(0, Number(buyInAmount || 0) || 0);
  return {
    id: rowId,
    playerId,
    linkedProfileId: linkedProfileId || (playerId.includes("unlinked:") ? null : playerId),
    name: safeName(p?.name || ""),
    buyIns,
    buyInEntries: normalizeBuyInEntries(p?.buyInEntries, buyIns, defaultBuyInAmount),
    cashOut: Number(p?.cashOut || 0),
  };
}

function playerRefLabel(ref) {
  return safeName(ref?.name || ref?.displayName || ref?.nickname || "Player");
}

function playerRefId(ref, fallback = "") {
  return String(ref?.playerId || ref?.id || fallback || "");
}

function playerIdentityKey(ref) {
  const id = playerRefId(ref, "");
  if (id) return `id:${id}`;
  return `name:${playerRefLabel(ref).toLowerCase()}`;
}

function legacyNamePlayerId(name) {
  return `legacy-name:${encodeURIComponent(safeName(name).toLowerCase())}`;
}

function isLegacyNamePlayerId(id) {
  return String(id || "").startsWith("legacy-name:");
}

function decodeLegacyNamePlayerId(id) {
  if (!isLegacyNamePlayerId(id)) return "";
  return decodeURIComponent(String(id).slice("legacy-name:".length));
}

function playerMatchesSource(ref, sourceId) {
  if (isLegacyNamePlayerId(sourceId)) {
    return safeName(ref?.name).toLowerCase() === decodeLegacyNamePlayerId(sourceId);
  }
  return playerRefId(ref, "") === sourceId;
}

function isLinkedPlayer(ref) {
  const id = playerRefId(ref, "");
  if (!id) return false;
  if (String(id).startsWith("unlinked:")) return false;
  if (isLegacyNamePlayerId(id)) return false;
  return true;
}

function resolvePotHolderPlayerId(players, potHolderPlayerId) {
  const rows = Array.isArray(players) ? players : [];
  if (!rows.length) return "";
  const candidate = String(potHolderPlayerId || "");
  if (candidate && rows.some((p) => playerRefId(p, p?.id || "") === candidate)) return candidate;
  return playerRefId(rows[0], rows[0]?.id || "");
}

function defaultDB() {
  const players = [blankPlayer(), blankPlayer()];
  return {
    rev: 0,
    users: [],
    presence: {},
    autoBackups: [],
    adminEvents: [],
    live: {
      id: "live",
      title: "Classmates Live Session",
      mode: "tournament",
      buyInCashAmount: 50,
      buyInChipStack: 50,
      prizeEnabled: true,
      prizePerPlayer: 20,
      players,
      potHolderPlayerId: resolvePotHolderPlayerId(players, ""),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    },
    history: [],
    debts: [],
    updatedAt: new Date().toISOString(),
  };
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return defaultDB();
    const parsed = JSON.parse(raw);
    const localLive = parsed?.live && typeof parsed.live === "object" ? parsed.live : {};
    const players =
      Array.isArray(localLive?.players) && localLive.players.length
        ? localLive.players.map((p) => normalizeLivePlayer(p, Number(localLive?.buyInCashAmount || 0)))
        : [blankPlayer(), blankPlayer()];
    return {
      ...defaultDB(),
      live: {
        ...defaultDB().live,
        ...localLive,
        mode: localLive?.mode === "cash" ? "cash" : "tournament",
        prizeEnabled: typeof localLive?.prizeEnabled === "boolean" ? localLive.prizeEnabled : true,
        prizePerPlayer: Math.max(0, Number(localLive?.prizePerPlayer || 20)),
        players,
        potHolderPlayerId: resolvePotHolderPlayerId(players, localLive?.potHolderPlayerId),
      },
      settings:
        parsed?.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
          ? parsed.settings
          : {},
      debts: Array.isArray(parsed?.debts) ? parsed.debts : [],
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
    ["debts", JSON.stringify(db.debts || [])],
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
    debts: Array.isArray(parts.debts) ? parts.debts : [],
    live: (() => {
      const players =
        Array.isArray(parts?.live?.players) && parts.live.players.length
          ? parts.live.players.map((p) => normalizeLivePlayer(p, Number(parts?.live?.buyInCashAmount || 0)))
          : [blankPlayer(), blankPlayer()];
      return {
        ...defaultDB().live,
        ...(parts.live || {}),
        mode: parts?.live?.mode === "cash" ? "cash" : "tournament",
        players,
        potHolderPlayerId: resolvePotHolderPlayerId(players, parts?.live?.potHolderPlayerId),
      };
    })(),
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
    const id = String(u?.id || uid());
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawUsername =
      safeName(u?.username || u?.name || String(u?.email || "").split("@")[0] || "").replace(/\s+/g, "_");
    const username = rawUsername.toLowerCase();
    const password = String(u?.password || u?.pass || "");
    if (!username) return;
    out.push({
      id,
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
      .sort((a, b) => b.frac - a.frac || b.amount - a.amount || safeName(a.name).localeCompare(safeName(b.name)))
      .forEach((x) => {
        x[keyOut] = x.floor + (rem > 0 ? 1 : 0);
        if (rem > 0) rem -= 1;
      });

    return base.map((x) => ({ name: x.name, playerId: x.playerId || "", [keyOut]: x[keyOut] }));
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
    safeName(a.name).localeCompare(safeName(b.name))
  );
  const losersSorted = [...losersBase].sort(
    (a, b) => b.loss - a.loss || safeName(a.name).localeCompare(safeName(b.name))
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
            fromId: loser.playerId || "",
            to: winner.name,
            toId: winner.playerId || "",
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
    id: t.id || `${t.fromId || t.from}|${t.toId || t.to}|${t.amount}|${i}`,
  }));
}

function settleCashOptimized(rows) {
  const creditors = rows
    .map((p) => ({
      name: safeName(p.name),
      playerId: playerRefId(p, p?.id || ""),
      amount: round2(Number(p.net) || 0),
    }))
    .filter((p) => p.amount > 0.0001);

  const debtors = rows
    .map((p) => ({
      name: safeName(p.name),
      playerId: playerRefId(p, p?.id || ""),
      amount: round2(Math.abs(Math.min(0, Number(p.net) || 0))),
    }))
    .filter((p) => p.amount > 0.0001);

  const txns = [];
  const sortDesc = (a, b) => b.amount - a.amount;

  creditors.sort(sortDesc);
  debtors.sort(sortDesc);

  while (creditors.length && debtors.length) {
    const creditor = creditors[0];
    const debtor = debtors[0];
    const payment = round2(Math.min(creditor.amount, debtor.amount));
    if (payment <= 0.0001) break;

    txns.push({
      id: null,
      from: debtor.name,
      fromId: debtor.playerId || "",
      to: creditor.name,
      toId: creditor.playerId || "",
      amount: payment,
      paid: false,
      paidAt: null,
      method: null,
    });

    creditor.amount = round2(creditor.amount - payment);
    debtor.amount = round2(debtor.amount - payment);

    if (creditor.amount <= 0.0001) creditors.shift();
    if (debtor.amount <= 0.0001) debtors.shift();

    creditors.sort(sortDesc);
    debtors.sort(sortDesc);
  }

  return txns.map((t, i) => ({
    ...t,
    id: `${t.fromId || t.from}|${t.toId || t.to}|${t.amount}|cash|${i}`,
  }));
}

function calculateOutstandingBuyIns(live) {
  const cashPerBuyIn = round2(Math.max(0, Number(live?.buyInCashAmount) || 0));
  const rows = Array.isArray(live?.players) ? live.players : [];
  const potHolderId = resolvePotHolderPlayerId(rows, live?.potHolderPlayerId);
  const potHolderRow = rows.find((p) => playerRefId(p, p?.id || "") === potHolderId) || null;
  let total = 0;
  let collected = 0;
  const debts = [];

  rows.forEach((p) => {
    const pid = playerRefId(p, p?.id || "");
    const entries = normalizeBuyInEntries(p?.buyInEntries, p?.buyIns, cashPerBuyIn);
    const playerTotal = round2(entries.reduce((sum, e) => sum + round2(e.amount), 0));
    const playerCollected = round2(entries.filter((e) => e.paid).reduce((sum, e) => sum + round2(e.amount), 0));
    const unpaid = round2(playerTotal - playerCollected);
    total = round2(total + playerTotal);
    collected = round2(collected + playerCollected);
    if (unpaid > 0.0001 && pid && pid !== potHolderId) {
      debts.push({
        playerId: pid,
        potHolderId,
        amount: unpaid,
        playerName: safeName(p?.name),
        potHolderName: safeName(potHolderRow?.name || "Pot Holder"),
      });
    }
  });

  debts.sort((a, b) => b.amount - a.amount || a.playerName.localeCompare(b.playerName));
  return {
    debts,
    collected,
    total,
    potHolderId,
    potHolderName: safeName(potHolderRow?.name || "Pot Holder"),
  };
}

function buildUnpaidBuyInDebtRecords(live, sessionMeta = {}) {
  const rows = Array.isArray(live?.players) ? live.players : [];
  const cashPerBuyIn = round2(Math.max(0, Number(live?.buyInCashAmount) || 0));
  const potHolderId = resolvePotHolderPlayerId(rows, live?.potHolderPlayerId);
  const potHolder = rows.find((p) => playerRefId(p, p?.id || "") === potHolderId) || null;
  const sessionId = String(sessionMeta?.sessionId || "");
  const sessionDate = String(sessionMeta?.sessionDate || new Date().toISOString());
  const mode = sessionMeta?.mode === "cash" ? "cash" : "tournament";

  return rows
    .map((p) => {
      const fromPlayerId = playerRefId(p, p?.id || "");
      const entries = normalizeBuyInEntries(p?.buyInEntries, p?.buyIns, cashPerBuyIn);
      const unpaid = round2(
        entries
          .filter((e) => !e.paid)
          .reduce((sum, e) => sum + round2(e.amount), 0)
      );
      if (!sessionId || unpaid <= 0.0001 || !fromPlayerId || fromPlayerId === potHolderId || !potHolderId) return null;
      return {
        id: `debt:${sessionId}:${fromPlayerId}:${potHolderId}:unpaid_buyin`,
        fromPlayerId,
        toPlayerId: potHolderId,
        fromPlayerName: safeName(p?.name || "Player"),
        toPlayerName: safeName(potHolder?.name || "Pot Holder"),
        amount: unpaid,
        sessionId,
        sessionDate,
        mode,
        type: "unpaid_buyin",
        settled: false,
        settledAt: null,
        settledBy: null,
      };
    })
    .filter(Boolean);
}

function formatModeLabel(mode) {
  return mode === "cash" ? "Cash Game" : "Tournament";
}

function formatDebtTypeLabel(type) {
  if (type === "unpaid_buyin") return "Unpaid Buy-in";
  return safeName(String(type || "Debt").replace(/_/g, " "));
}

const LIVE_SETTINGS_KEYS = [
  "mode",
  "buyInCashAmount",
  "buyInChipStack",
  "prizeEnabled",
  "prizePerPlayer",
];

function extractLiveSettings(live) {
  const base = defaultDB().live;
  const src = live && typeof live === "object" ? live : {};
  return {
    mode: src.mode === "cash" ? "cash" : "tournament",
    buyInCashAmount: Math.max(1, Number(src.buyInCashAmount ?? base.buyInCashAmount) || base.buyInCashAmount),
    buyInChipStack: Math.max(1, Number(src.buyInChipStack ?? base.buyInChipStack) || base.buyInChipStack),
    prizeEnabled: typeof src.prizeEnabled === "boolean" ? src.prizeEnabled : base.prizeEnabled,
    prizePerPlayer: Math.max(0, Number(src.prizePerPlayer ?? base.prizePerPlayer) || base.prizePerPlayer),
  };
}

function normalizeIncomingSettingsPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.live && typeof payload.live === "object") return extractLiveSettings(payload.live);
  const keys = Object.keys(payload);
  if (!keys.some((k) => LIVE_SETTINGS_KEYS.includes(k))) return null;
  return extractLiveSettings(payload);
}

function computeSession(live) {
  const cashPerBuyIn = Math.max(1, Number(live.buyInCashAmount) || 50);
  const chipsPerBuyIn = Math.max(1, Number(live.buyInChipStack) || 50);
  const chipsPerDollar = chipsPerBuyIn / cashPerBuyIn;
  const mode = live?.mode === "cash" ? "cash" : "tournament";
  const isCashMode = mode === "cash";
  const prizeEnabled = isCashMode ? false : !!live.prizeEnabled;
  const prizePerPlayer = Math.max(0, Number(live.prizePerPlayer) || 0);

  let players = (live.players || []).map((p) => {
    const buyIns = Math.max(0, parseInt(p.buyIns || 0, 10) || 0);
    const rawCashOut = Number(p.cashOut || 0);
    const buyInCash = round2(buyIns * cashPerBuyIn);
    const buyInChips = Math.round(buyIns * chipsPerBuyIn);
    const finalChips = isCashMode ? Math.max(0, rawCashOut) : null;
    const cashOut = isCashMode
      ? round2((Math.max(0, rawCashOut) / chipsPerBuyIn) * cashPerBuyIn)
      : rawCashOut;
    const baseNetCash = round2(cashOut - buyInCash);
    const pid = playerRefId(p, p?.id || uid());
    return {
      ...p,
      playerId: pid,
      buyIns,
      cashOutInput: isCashMode ? Math.max(0, rawCashOut) : rawCashOut,
      finalChips,
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
  let winnerIds = [];
  let winnerPayoutEach = 0;
  if (prizeEnabled && prizePerPlayer > 0 && playerCount >= 2) {
    const topNet = Math.max(...players.map((p) => p.baseNetCash));
    const winners = players.filter((p) => Math.abs(p.baseNetCash - topNet) < 0.0001);
    winnerNames = winners.map((w) => w.label);
    winnerIds = winners.map((w) => playerRefId(w, w.id || ""));
    prizePool = round2(prizePerPlayer * playerCount);
    winnerPayoutEach = winners.length > 0 ? round2(prizePool / winners.length) : 0;

    players = players.map((p) => {
      const isWinner = winnerIds.includes(playerRefId(p, p.id || ""));
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
    players.map((p) => ({ name: p.label, playerId: playerRefId(p, p.id || ""), net: p.baseNetCash }))
  );
  const txnsWithPrize = settleEqualSplitCapped(
    players.map((p) => ({ name: p.label, playerId: playerRefId(p, p.id || ""), net: p.netCash }))
  );
  const potHolderPlayerId = resolvePotHolderPlayerId(players, live?.potHolderPlayerId);
  const potHolderPlayer = players.find((p) => playerRefId(p, p.id || "") === potHolderPlayerId) || null;
  const txnsCashPotHolder = settleCashOptimized(
    players.map((p) => ({ name: p.label, playerId: playerRefId(p, p.id || ""), net: p.baseNetCash }))
  );
  const liveSettlementTxns = isCashMode ? txnsCashPotHolder : txnsWithPrize;

  return {
    players,
    txnsNoPrize,
    txnsWithPrize,
    txnsCashPotHolder,
    liveSettlementTxns,
    potCash,
    potChips,
    cashOutTotal,
    diff,
    chipsPerDollar,
    leader,
    cashPerBuyIn,
    chipsPerBuyIn,
    mode,
    isCashMode,
    prizeEnabled,
    prizePerPlayer,
    prizePool,
    winnerNames,
    winnerIds,
    winnerPayoutEach,
    potHolderPlayerId,
    potHolderName: safeName(potHolderPlayer?.label || potHolderPlayer?.name || ""),
  };
}

function normalizeTransferList(txns) {
  return (Array.isArray(txns) ? txns : []).map((t) => ({
    ...t,
    fromId: t?.fromId ? String(t.fromId) : "",
    toId: t?.toId ? String(t.toId) : "",
    from: safeName(t?.from || t?.fromName || "Player"),
    to: safeName(t?.to || t?.toName || "Player"),
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
        playerId: playerRefId(p, p?.id || ""),
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
      players.map((p) => ({ name: safeName(p.name), playerId: playerRefId(p, p?.id || ""), net: p.netCash || 0 }))
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
          fromId: t.fromId || "",
          to: t.to,
          toId: t.toId || "",
          amount: t.amount,
          txId: t.id,
        });
      }
    });
  });
  return rows.sort((a, b) => b.sessionStamp.localeCompare(a.sessionStamp));
}

function aggregatePrizePaymentRows(history) {
  const rows = [];
  (Array.isArray(history) ? history : []).forEach((h) => {
    getPrizePaymentsForSession(h).forEach((p) => {
      rows.push({
        sessionId: h.id,
        sessionStamp: h.stamp,
        from: p.from,
        fromId: p.fromId || "",
        to: p.to,
        toId: p.toId || "",
        amount: p.amount,
        paymentId: p.id,
        paid: !!p.paid,
      });
    });
  });
  return rows.sort((a, b) => b.sessionStamp.localeCompare(a.sessionStamp));
}

function groupOutstandingByPlayer(rows) {
  const byPlayer = new Map();

  const ensure = (ref) => {
    const key = playerIdentityKey(ref);
    if (!byPlayer.has(key)) {
      byPlayer.set(key, {
        id: playerRefId(ref, ""),
        name: playerRefLabel(ref),
        key,
        owes: [],
        owedBy: [],
        totalOwes: 0,
        totalOwedBy: 0,
      });
    }
    return byPlayer.get(key);
  };

  rows.forEach((row) => {
    const from = ensure({ playerId: row.fromId, name: row.from });
    const to = ensure({ playerId: row.toId, name: row.to });

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
    const involved = new Map();

    txns.forEach((t) => {
      involved.set(playerIdentityKey({ playerId: t.fromId, name: t.from }), {
        playerId: t.fromId || "",
        name: t.from,
      });
      involved.set(playerIdentityKey({ playerId: t.toId, name: t.to }), {
        playerId: t.toId || "",
        name: t.to,
      });
    });

    involved.forEach((ref) => {
      const key = playerIdentityKey(ref);
      if (!map.has(key)) {
        map.set(key, {
          playerId: ref.playerId || "",
          player: safeName(ref.name),
          key,
          totalOwes: 0,
          totalOwed: 0,
          sessions: [],
        });
      }
      const row = map.get(key);
      const owes = txns.filter((t) => playerIdentityKey({ playerId: t.fromId, name: t.from }) === key);
      const owed = txns.filter((t) => playerIdentityKey({ playerId: t.toId, name: t.to }) === key);
      const owesTotal = round2(owes.reduce((a, t) => a + t.amount, 0));
      const owedTotal = round2(owed.reduce((a, t) => a + t.amount, 0));
      row.totalOwes = round2(row.totalOwes + owesTotal);
      row.totalOwed = round2(row.totalOwed + owedTotal);
      row.sessions.push({
        sessionId: h.id,
        stamp: h.stamp,
        owesTo: owes
          .reduce((m, t) => {
            const toKey = playerIdentityKey({ playerId: t.toId, name: t.to });
            const curr = m.get(toKey) || { id: t.toId || "", name: t.to, amount: 0 };
            curr.amount = round2(curr.amount + t.amount);
            m.set(toKey, curr);
            return m;
          }, new Map()),
        owedBy: owed
          .reduce((m, t) => {
            const fromKey = playerIdentityKey({ playerId: t.fromId, name: t.from });
            const curr = m.get(fromKey) || { id: t.fromId || "", name: t.from, amount: 0 };
            curr.amount = round2(curr.amount + t.amount);
            m.set(fromKey, curr);
            return m;
          }, new Map()),
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
        owesTo: Array.from(s.owesTo.values()),
        owedBy: Array.from(s.owedBy.values()),
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
      fromId: p?.fromId ? String(p.fromId) : "",
      toId: p?.toId ? String(p.toId) : "",
      from: safeName(p?.from || p?.fromName || "Player"),
      to: safeName(p?.to || p?.toName || "Player"),
      paid: !!p.paid,
      paidAt: p.paid ? p.paidAt || null : null,
    }));
  }

  const players = (session?.players || []).map((p, idx) => {
    const name = safeName(p?.name);
    const playerId = playerRefId(p, p?.id || `legacy:${idx}:${name.toLowerCase()}`);
    const baseNet =
      typeof p?.baseNetCash === "number"
        ? p.baseNetCash
        : round2((p?.netCash || 0) - (p?.prizeAdj || 0));
    return { idx, playerId, name, baseNet };
  });
  if (!players.length) return [];

  const top = Math.max(...players.map((p) => p.baseNet));
  const winnerIds = session?.settings?.winnerPlayerIds;
  const winnerIdx = Array.isArray(winnerIds) && winnerIds.length
    ? players.filter((p) => winnerIds.includes(p.playerId)).map((p) => p.idx)
    : players.filter((p) => Math.abs(p.baseNet - top) < 0.0001).map((p) => p.idx);
  if (!winnerIdx.length) return [];

  const contributors = players.filter((p) => !winnerIdx.includes(p.idx));
  const winners = players.filter((p) => winnerIdx.includes(p.idx));
  if (!contributors.length || !winners.length) return [];

  // If there are multiple winners, assign payers to winners in round-robin.
  return contributors.map((fromPlayer, i) => ({
    id: `prize:${fromPlayer.playerId || fromPlayer.idx}:${winners[i % winners.length].playerId || winners[i % winners.length].idx}:${prizePerPlayer}:${i}`,
    from: fromPlayer.name,
    fromId: fromPlayer.playerId || "",
    to: winners[i % winners.length].name,
    toId: winners[i % winners.length].playerId || "",
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
  const { user, profile, profiles, refreshProfiles, signOut, authLoading } = useAuth();
  const [db, setDB] = useState(() => loadDB());
  const [syncState, setSyncState] = useState(() => (hasDatabase() ? "connecting" : "local-only"));
  const [syncError, setSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [pendingCloudWrite, setPendingCloudWrite] = useState(false);
  const [manualSyncBusy, setManualSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [syncBootstrapped, setSyncBootstrapped] = useState(() => !hasDatabase());
  const [remoteLoaded, setRemoteLoaded] = useState(() => !hasDatabase());
  const [showRlsHelp, setShowRlsHelp] = useState(false);
  const [tab, setTab] = useState("home");
  const [authView, setAuthView] = useState("login");
  const [playerDebtOpen, setPlayerDebtOpen] = useState({});
  const [historyOpen, setHistoryOpen] = useState({});
  const [statsCompact, setStatsCompact] = useState(false);
  const [flashMap, setFlashMap] = useState({});
  const [activeEditPlayerId, setActiveEditPlayerId] = useState("");
  const [addPlayerOpen, setAddPlayerOpen] = useState(false);
  const [guestPlayerName, setGuestPlayerName] = useState("");
  const [selectedLinkedPlayerId, setSelectedLinkedPlayerId] = useState("");
  const [mergeSourcePlayerId, setMergeSourcePlayerId] = useState("");
  const [mergeTargetPlayerId, setMergeTargetPlayerId] = useState("");
  const [toasts, setToasts] = useState([]);
  const backupInputRef = useRef(null);
  const addPlayerSelectRef = useRef(null);
  const dbRef = useRef(db);
  const syncStateRef = useRef(syncState);
  const lastSyncAtRef = useRef(lastSyncAt);
  const pendingCloudWriteRef = useRef(pendingCloudWrite);
  const remoteLoadedRef = useRef(remoteLoaded);
  const cloudWriteInFlightRef = useRef(false);
  const queuedCloudWritesRef = useRef(new Map());
  const cloudWriteTimerRef = useRef(null);
  const consecutiveSyncFailuresRef = useRef(0);
  const toastSeqRef = useRef(0);
  const LOCAL_CACHE_LIMIT_MSG = "Local cache limit reached. Session saved to cloud.";

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
    remoteLoadedRef.current = remoteLoaded;
  }, [remoteLoaded]);

  useEffect(
    () => () => {
      if (cloudWriteTimerRef.current) {
        window.clearTimeout(cloudWriteTimerRef.current);
        cloudWriteTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    const onScroll = () => {
      setStatsCompact(window.scrollY > 14);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    refreshProfiles().catch(() => {});
  }, [refreshProfiles, user?.id]);

  useEffect(() => {
    if (!addPlayerOpen) return;
    window.setTimeout(() => {
      addPlayerSelectRef.current?.focus();
    }, 10);
  }, [addPlayerOpen]);

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

  async function fetchDatabaseStateWithTimeout(ms = CLOUD_FETCH_TIMEOUT_MS) {
    return await Promise.race([
      fetchDatabaseState(),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Network request timed out")), ms)
      ),
    ]);
  }

  async function fetchLiveStateWithTimeout(ms = CLOUD_FETCH_TIMEOUT_MS, options = {}) {
    const allowGlobalFallback = !!options.allowGlobalFallback;
    const live = await Promise.race([
      fetchStateByKey(SYNC_STATE_KEYS.LIVE),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Network request timed out")), ms)
      ),
    ]);
    if (live && typeof live === "object") return live;
    if (live != null) return null;
    if (!allowGlobalFallback) return null;

    const legacy = await fetchDatabaseStateWithTimeout(ms);
    if (legacy && typeof legacy === "object" && legacy.live && typeof legacy.live === "object") {
      return legacy.live;
    }
    return null;
  }

  async function fetchHistoryStateWithTimeout(ms = CLOUD_FETCH_TIMEOUT_MS, options = {}) {
    const allowGlobalFallback = !!options.allowGlobalFallback;
    const history = await Promise.race([
      fetchStateByKey(SYNC_STATE_KEYS.HISTORY),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Network request timed out")), ms)
      ),
    ]);
    if (Array.isArray(history)) return history;
    if (history != null) return null;
    if (!allowGlobalFallback) return null;

    const legacy = await fetchDatabaseStateWithTimeout(ms);
    if (legacy && typeof legacy === "object" && Array.isArray(legacy.history)) {
      return legacy.history;
    }
    return null;
  }

  async function fetchDebtsStateWithTimeout(ms = CLOUD_FETCH_TIMEOUT_MS, options = {}) {
    const allowGlobalFallback = !!options.allowGlobalFallback;
    const debts = await Promise.race([
      fetchStateByKey(SYNC_STATE_KEYS.DEBTS),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Network request timed out")), ms)
      ),
    ]);
    if (Array.isArray(debts)) return debts;
    if (debts != null) return null;
    if (!allowGlobalFallback) return null;

    const legacy = await fetchDatabaseStateWithTimeout(ms);
    if (legacy && typeof legacy === "object" && Array.isArray(legacy.debts)) {
      return legacy.debts;
    }
    return null;
  }

  async function fetchSettingsStateWithTimeout(ms = CLOUD_FETCH_TIMEOUT_MS, options = {}) {
    const allowGlobalFallback = !!options.allowGlobalFallback;
    const settings = await Promise.race([
      fetchStateByKey(SYNC_STATE_KEYS.SETTINGS),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Network request timed out")), ms)
      ),
    ]);
    const normalized = normalizeIncomingSettingsPayload(settings);
    if (normalized) return normalized;
    if (settings != null) return null;
    if (!allowGlobalFallback) return null;

    const legacy = await fetchDatabaseStateWithTimeout(ms);
    return normalizeIncomingSettingsPayload(legacy);
  }

  function refreshPendingCloudWriteFlag() {
    const pending = Boolean(
      cloudWriteInFlightRef.current ||
      queuedCloudWritesRef.current.size > 0 ||
      cloudWriteTimerRef.current
    );
    pendingCloudWriteRef.current = pending;
    setPendingCloudWrite(pending);
  }

  function resetSyncFailures() {
    consecutiveSyncFailuresRef.current = 0;
  }

  function handleSyncFailure(message) {
    const nextCount = consecutiveSyncFailuresRef.current + 1;
    consecutiveSyncFailuresRef.current = nextCount;
    if (nextCount >= SYNC_FAILURE_THRESHOLD) {
      setSyncState("error");
      setSyncError(String(message || "Cloud sync unavailable"));
      setSyncNote("Using local session only");
      return;
    }
    setSyncError("");
    setSyncNote("Sync reconnecting...");
  }

  async function flushCloudWriteQueue() {
    if (!hasDatabase()) {
      queuedCloudWritesRef.current.clear();
      if (cloudWriteTimerRef.current) {
        window.clearTimeout(cloudWriteTimerRef.current);
        cloudWriteTimerRef.current = null;
      }
      cloudWriteInFlightRef.current = false;
      refreshPendingCloudWriteFlag();
      return;
    }
    if (cloudWriteInFlightRef.current) return;

    while (queuedCloudWritesRef.current.size > 0) {
      const [bucket, payload] = queuedCloudWritesRef.current.entries().next().value;
      queuedCloudWritesRef.current.delete(bucket);
      cloudWriteInFlightRef.current = true;
      refreshPendingCloudWriteFlag();
      try {
        if (bucket === SYNC_STATE_KEYS.GLOBAL) {
          await pushDatabaseState(payload);
        } else {
          await pushStateByKey(bucket, payload);
        }
        resetSyncFailures();
        setSyncState("connected");
        setSyncError("");
        setSyncNote("");
        setLastSyncAt(new Date().toISOString());
      } catch (err) {
        handleSyncFailure(String(err?.message || err || "Database write failed"));
      } finally {
        cloudWriteInFlightRef.current = false;
        refreshPendingCloudWriteFlag();
      }
    }
  }

  function enqueueCloudWrite(writeRequest, debounceMs = CLOUD_WRITE_DEBOUNCE_MS) {
    const bucket = String(writeRequest?.bucket || SYNC_STATE_KEYS.GLOBAL);
    queuedCloudWritesRef.current.set(bucket, writeRequest?.payload);
    setSyncState("connecting");
    refreshPendingCloudWriteFlag();
    if (cloudWriteTimerRef.current) {
      window.clearTimeout(cloudWriteTimerRef.current);
      cloudWriteTimerRef.current = null;
    }
    if (debounceMs <= 0) {
      flushCloudWriteQueue();
      return;
    }
    cloudWriteTimerRef.current = window.setTimeout(() => {
      cloudWriteTimerRef.current = null;
      refreshPendingCloudWriteFlag();
      flushCloudWriteQueue();
    }, debounceMs);
  }

  async function enqueueCloudWriteAndFlush(snapshot) {
    enqueueCloudWrite({ bucket: SYNC_STATE_KEYS.GLOBAL, payload: snapshot }, 0);
    const startedAt = Date.now();
    while (
      cloudWriteInFlightRef.current ||
      queuedCloudWritesRef.current.size > 0 ||
      cloudWriteTimerRef.current
    ) {
      if (Date.now() - startedAt > 15000) {
        throw new Error("Network request timed out");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  function formatSyncError(err, fallback = "Cloud sync unavailable") {
    const msg = String(err?.message || err || "").trim();
    if (!msg) return fallback;
    return msg;
  }

  function toLocalCachePayload(state) {
    return {
      live: state?.live || defaultDB().live,
      settings:
        state?.settings && typeof state.settings === "object" && !Array.isArray(state.settings)
          ? state.settings
          : {},
    };
  }

  function writeLocalCache(state) {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(toLocalCachePayload(state)));
      return true;
    } catch (err) {
      const quotaHit = /quota/i.test(String(err?.name || "")) || /quota/i.test(String(err?.message || ""));
      if (quotaHit) {
        setSyncNote(LOCAL_CACHE_LIMIT_MSG);
        pushToast(LOCAL_CACHE_LIMIT_MSG);
      }
      return false;
    }
  }

  function applyLocalState(nextState, broadcast = true) {
    setDB(nextState);
    writeLocalCache(nextState);
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
      writeLocalCache(next);
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
        const incomingIsFull = Array.isArray(incoming?.history) || Array.isArray(incoming?.users);
        const mergedIncoming = incomingIsFull
          ? incoming
          : {
              ...prev,
              live: {
                ...(prev?.live || defaultDB().live),
                ...(incoming?.live || {}),
              },
              settings: {
                ...(prev?.settings || {}),
                ...((incoming?.settings && typeof incoming.settings === "object" && !Array.isArray(incoming.settings))
                  ? incoming.settings
                  : {}),
              },
            };
        const next = preferIncoming ? mergedIncoming : pickNewestState(prev, mergedIncoming);
        writeLocalCache(next);
        return next;
      });
    };

    const applyIncomingLive = (incomingLive, options = {}) => {
      if (!incomingLive || typeof incomingLive !== "object") return;
      const preferIncoming = !!options.preferIncoming;
      setDB((prev) => {
        const prevLive = prev?.live || defaultDB().live;
        const incomingLiveWithoutSettings = { ...incomingLive };
        LIVE_SETTINGS_KEYS.forEach((key) => {
          delete incomingLiveWithoutSettings[key];
        });
        const mergedIncoming = {
          ...prev,
          live: {
            ...prevLive,
            ...incomingLiveWithoutSettings,
            ...extractLiveSettings(prevLive),
          },
        };
        const next = preferIncoming ? mergedIncoming : pickNewestState(prev, mergedIncoming);
        writeLocalCache(next);
        return next;
      });
    };

    const applyIncomingHistory = (incomingHistory) => {
      if (!Array.isArray(incomingHistory)) return;
      setDB((prev) => {
        const next = {
          ...prev,
          history: incomingHistory,
        };
        writeLocalCache(next);
        return next;
      });
    };

    const applyIncomingDebts = (incomingDebts) => {
      if (!Array.isArray(incomingDebts)) return;
      setDB((prev) => {
        const next = {
          ...prev,
          debts: incomingDebts,
        };
        writeLocalCache(next);
        return next;
      });
    };

    const applyIncomingSettings = (incomingSettings) => {
      const normalized = normalizeIncomingSettingsPayload(incomingSettings);
      if (!normalized) return;
      setDB((prev) => {
        const next = {
          ...prev,
          live: {
            ...(prev?.live || defaultDB().live),
            ...normalized,
          },
        };
        writeLocalCache(next);
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
    let unsubscribeHistory = () => {};
    let unsubscribeDebts = () => {};
    let unsubscribeSettings = () => {};
    let isRefreshing = false;
    if (hasDatabase()) {
      const refreshRemoteNow = async () => {
        if (cancelled || isRefreshing) return;
        isRefreshing = true;
        try {
          if (pendingCloudWriteRef.current) {
            setSyncState("connecting");
            return;
          }
          const remoteLive = await fetchLiveStateWithTimeout();
          if (cancelled) return;
          if (remoteLive && typeof remoteLive === "object") {
            applyIncomingLive(remoteLive);
            resetSyncFailures();
            setRemoteLoaded(true);
          } else {
            handleSyncFailure("Cloud sync unavailable. Using local session only.");
            setPendingCloudWrite(false);
            return;
          }
          setSyncState("connected");
          setSyncError("");
          setPendingCloudWrite(false);
          setSyncNote("");
          setLastSyncAt(new Date().toISOString());
        } catch (err) {
          if (cancelled) return;
          handleSyncFailure(formatSyncError(err, "Cloud sync unavailable"));
          setPendingCloudWrite(false);
        } finally {
          isRefreshing = false;
        }
      };

      setSyncState("connecting");
      setSyncError("");
      unsubscribeDb = subscribeStateByKey(
        SYNC_STATE_KEYS.LIVE,
        (incoming) => {
          if (cancelled) return;
          applyIncomingLive(incoming);
          resetSyncFailures();
          setRemoteLoaded(true);
          setSyncState("connected");
          setSyncError("");
          setPendingCloudWrite(false);
          setSyncNote("");
          setLastSyncAt(new Date().toISOString());
        },
        (status) => {
          if (cancelled) return;
          const s = String(status || "").toUpperCase();
          if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
            handleSyncFailure("Realtime subscription failed");
            setPendingCloudWrite(false);
          } else if (s === "SUBSCRIBED") {
            resetSyncFailures();
            setSyncState("connected");
            setSyncError("");
            setSyncNote("");
          }
        }
      );
      unsubscribeHistory = subscribeStateByKey(
        SYNC_STATE_KEYS.HISTORY,
        (incoming) => {
          if (cancelled) return;
          if (Array.isArray(incoming)) {
            applyIncomingHistory(incoming);
            return;
          }
          if (!Array.isArray(incoming?.history)) return;
          applyIncomingHistory(incoming.history);
        }
      );
      unsubscribeDebts = subscribeStateByKey(
        SYNC_STATE_KEYS.DEBTS,
        (incoming) => {
          if (cancelled) return;
          if (Array.isArray(incoming)) {
            applyIncomingDebts(incoming);
            return;
          }
          if (!Array.isArray(incoming?.debts)) return;
          applyIncomingDebts(incoming.debts);
        }
      );
      unsubscribeSettings = subscribeStateByKey(
        SYNC_STATE_KEYS.SETTINGS,
        (incoming) => {
          if (cancelled) return;
          applyIncomingSettings(incoming);
        }
      );
      (async () => {
        try {
          const remoteLive = await fetchLiveStateWithTimeout(CLOUD_FETCH_TIMEOUT_MS, {
            allowGlobalFallback: true,
          });
          if (cancelled) return;
          if (remoteLive && typeof remoteLive === "object") {
            applyIncomingLive(remoteLive, { preferIncoming: true });
            resetSyncFailures();
            setRemoteLoaded(true);
          } else {
            handleSyncFailure("Cloud sync unavailable. Using local session only.");
            setPendingCloudWrite(false);
            return;
          }
          setSyncState("connected");
          setPendingCloudWrite(false);
          setSyncError("");
          setSyncNote("");
          setLastSyncAt(new Date().toISOString());
        } catch (err) {
          if (cancelled) return;
          handleSyncFailure(formatSyncError(err, "Cloud sync unavailable"));
          setPendingCloudWrite(false);
        } finally {
          if (!cancelled) setSyncBootstrapped(true);
        }
      })();
      (async () => {
        try {
          const remoteHistory = await fetchHistoryStateWithTimeout(CLOUD_FETCH_TIMEOUT_MS, {
            allowGlobalFallback: true,
          });
          if (cancelled) return;
          if (!Array.isArray(remoteHistory)) return;
          applyIncomingHistory(remoteHistory);
        } catch {}
      })();
      (async () => {
        try {
          const remoteDebts = await fetchDebtsStateWithTimeout(CLOUD_FETCH_TIMEOUT_MS, {
            allowGlobalFallback: true,
          });
          if (cancelled) return;
          if (!Array.isArray(remoteDebts)) return;
          applyIncomingDebts(remoteDebts);
        } catch {}
      })();
      (async () => {
        try {
          const remoteSettings = await fetchSettingsStateWithTimeout(CLOUD_FETCH_TIMEOUT_MS, {
            allowGlobalFallback: true,
          });
          if (cancelled || !remoteSettings) return;
          applyIncomingSettings(remoteSettings);
        } catch {}
      })();

      const pollId = window.setInterval(async () => {
        try {
          if (pendingCloudWriteRef.current) return;
          const remoteLive = await fetchLiveStateWithTimeout();
          if (cancelled) return;
          if (!remoteLive || typeof remoteLive !== "object") {
            handleSyncFailure("Cloud sync unavailable. Using local session only.");
            setPendingCloudWrite(false);
            return;
          }
          applyIncomingLive(remoteLive);
          resetSyncFailures();
          setRemoteLoaded(true);
          setSyncState("connected");
          setSyncError("");
          setPendingCloudWrite(false);
          setSyncNote("");
          setLastSyncAt(new Date().toISOString());
        } catch (err) {
          if (cancelled) return;
          handleSyncFailure(formatSyncError(err, "Cloud sync unavailable"));
          setPendingCloudWrite(false);
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
        unsubscribeHistory();
        unsubscribeDebts();
        unsubscribeSettings();
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
      unsubscribeHistory();
      unsubscribeDebts();
      unsubscribeSettings();
      channel.close();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  function commit(next, options = {}) {
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
      if (!remoteLoadedRef.current) {
        setSyncState("error");
        setSyncError("Cloud not safely loaded yet");
        refreshPendingCloudWriteFlag();
        setSyncNote("Using local session only");
        return;
      }
      const targetBucket = String(options?.cloudBucket || SYNC_STATE_KEYS.GLOBAL);
      const payload =
        options?.cloudPayload !== undefined
          ? options.cloudPayload
          : targetBucket === SYNC_STATE_KEYS.LIVE
            ? stamped.live
            : stamped;
      enqueueCloudWrite({ bucket: targetBucket, payload });
      if (Array.isArray(options?.additionalCloudWrites)) {
        options.additionalCloudWrites.forEach((entry) => {
          const bucket = String(entry?.bucket || "");
          if (!bucket) return;
          enqueueCloudWrite({
            bucket,
            payload: entry?.payload,
          });
        });
      }
    }
  }

  async function manualSyncNow() {
    if (!hasDatabase() || manualSyncBusy) return;
    setManualSyncBusy(true);
    setSyncState("connecting");
    setSyncError("");
    setSyncNote("");
    try {
      const remote = await fetchDatabaseStateWithTimeout();
      const local = dbRef.current;
      let message = "Already up to date.";

      if (remote && typeof remote === "object") {
        setRemoteLoaded(true);
        const freshness = compareStateFreshness(local, remote);
        if (freshness > 0) {
          await enqueueCloudWriteAndFlush(local);
          message = "Synced local changes to cloud.";
        } else if (freshness < 0) {
          setDB(() => {
            writeLocalCache(remote);
            return remote;
          });
          message = "Pulled latest data from cloud.";
        }
      } else {
        throw new Error("Cloud sync unavailable. Using local session only.");
      }

      setSyncState("connected");
      setPendingCloudWrite(false);
      setLastSyncAt(new Date().toISOString());
      setSyncNote(message);
    } catch (err) {
      setSyncState("error");
      setSyncError(formatSyncError(err, "Cloud sync unavailable"));
      setPendingCloudWrite(false);
      setSyncNote("Using local session only");
    } finally {
      setManualSyncBusy(false);
    }
  }

  const currentUser = useMemo(() => {
    if (!user?.id) return null;
    const fallbackName = safeName(profile?.nickname || user.email?.split("@")[0] || "player");
    return {
      id: user.id,
      username: fallbackName.toLowerCase().replace(/\s+/g, "_"),
      name: fallbackName,
      lastLoginAt: new Date().toISOString(),
      email: user.email || "",
    };
  }, [profile?.nickname, user?.email, user?.id]);

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
    const nextLiveRaw = fn({ ...(db.live || defaultDB().live) });
    const normalizedPlayers = Array.isArray(nextLiveRaw?.players) ? nextLiveRaw.players : [];
    const nextLive = {
      ...nextLiveRaw,
      potHolderPlayerId: resolvePotHolderPlayerId(normalizedPlayers, nextLiveRaw?.potHolderPlayerId),
    };
    commit(
      {
        ...db,
        live: {
          ...nextLive,
          updatedBy: currentUser?.name || "Unknown",
          updatedAt: new Date().toISOString(),
        },
      },
      {
        cloudBucket: SYNC_STATE_KEYS.LIVE,
      }
    );
  }

  function updateLiveSettings(fn) {
    const baseLive = db.live || defaultDB().live;
    const nextLiveRaw = fn({ ...baseLive });
    const normalizedPlayers = Array.isArray(nextLiveRaw?.players) ? nextLiveRaw.players : [];
    const nextLive = {
      ...nextLiveRaw,
      potHolderPlayerId: resolvePotHolderPlayerId(
        normalizedPlayers.length ? normalizedPlayers : baseLive.players,
        nextLiveRaw?.potHolderPlayerId ?? baseLive.potHolderPlayerId
      ),
    };
    const settingsPayload = extractLiveSettings(nextLive);
    commit(
      {
        ...db,
        live: {
          ...nextLive,
          updatedBy: currentUser?.name || "Unknown",
          updatedAt: new Date().toISOString(),
        },
      },
      {
        cloudBucket: SYNC_STATE_KEYS.SETTINGS,
        cloudPayload: settingsPayload,
      }
    );
  }
  const computed = useMemo(() => computeSession(db.live), [db.live]);
  const buyInDebtSummary = useMemo(
    () => (db.live?.mode === "cash" ? calculateOutstandingBuyIns(db.live) : { debts: [], collected: 0, total: 0, potHolderId: "", potHolderName: "" }),
    [db.live]
  );
  const persistedOutstandingDebts = useMemo(
    () =>
      (Array.isArray(db.debts) ? db.debts : [])
        .filter((d) => d?.type === "unpaid_buyin" && !d?.settled && Number(d?.amount || 0) > 0.0001)
        .sort(
          (a, b) =>
            String(b?.sessionDate || "").localeCompare(String(a?.sessionDate || "")) ||
            Number(b?.amount || 0) - Number(a?.amount || 0)
        ),
    [db.debts]
  );
  const debtSummaryBySessionId = useMemo(() => {
    const out = new Map();
    (Array.isArray(db.debts) ? db.debts : []).forEach((d) => {
      if (!d || d.type !== "unpaid_buyin") return;
      const sid = String(d.sessionId || "");
      if (!sid) return;
      const current = out.get(sid) || { total: 0, outstanding: 0, settled: 0 };
      const amount = round2(Number(d.amount) || 0);
      current.total = round2(current.total + amount);
      if (d.settled) {
        current.settled = round2(current.settled + amount);
      } else {
        current.outstanding = round2(current.outstanding + amount);
      }
      out.set(sid, current);
    });
    return out;
  }, [db.debts]);
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
  const prizePaymentRows = useMemo(
    () => aggregatePrizePaymentRows(db.history),
    [db.history]
  );
  const unpaidPrizeRows = useMemo(
    () => prizePaymentRows.filter((r) => !r.paid),
    [prizePaymentRows]
  );
  const prizeDebtByPlayer = useMemo(
    () => groupOutstandingByPlayer(unpaidPrizeRows),
    [unpaidPrizeRows]
  );
  const playerDebtTrackers = useMemo(
    () => buildPlayerDebtTrackers(db.history),
    [db.history]
  );
  const knownPlayerOptions = useMemo(() => {
    const map = new Map();
    const push = (id, name, linked = false, email = "") => {
      const pid = String(id || "");
      if (!pid) return;
      if (!map.has(pid)) {
        map.set(pid, {
          id: pid,
          name: safeName(name || "Player"),
          linked,
          email: String(email || ""),
        });
      }
    };

    (Array.isArray(profiles) ? profiles : []).forEach((p) => {
      push(p.id, p.nickname || p.email?.split("@")[0] || "Player", true, p.email || "");
    });

    (db.live?.players || []).forEach((p) => {
      const pid = playerRefId(p, "");
      if (pid) push(pid, p.name || "Player", !!p.linkedProfileId, "");
    });

    (Array.isArray(db.history) ? db.history : []).forEach((h) => {
      (h.players || []).forEach((p) => {
        const pid = playerRefId(p, "");
        if (pid) push(pid, p.name || "Player", false, "");
        else push(legacyNamePlayerId(p.name || "Player"), p.name || "Player", false, "");
      });
    });

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [db.history, db.live?.players, profiles]);
  const availableLinkedProfiles = useMemo(
    () =>
      (profiles || []).filter(
        (p) => !(db.live?.players || []).some((lp) => playerRefId(lp, "") === p.id)
      ),
    [db.live?.players, profiles]
  );
  const similarGuestName = useMemo(() => {
    const q = safeName(guestPlayerName).toLowerCase();
    if (!q || q === "player") return "";
    const names = Array.from(
      new Set(
        [
          ...(db.live?.players || []).map((p) => safeName(p.name)),
          ...knownPlayerOptions.map((p) => safeName(p.name)),
        ].filter(Boolean)
      )
    );
    return names.find((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase())) || "";
  }, [db.live?.players, guestPlayerName, knownPlayerOptions]);
  const presenceRows = useMemo(() => {
    const now = Date.now();
    const users = Array.isArray(profiles) && profiles.length
      ? profiles.map((p) => ({
          id: p.id,
          username: safeName(p.nickname || p.email?.split("@")[0] || "player").toLowerCase(),
          email: p.email || "",
          createdAt: null,
          lastLoginAt: null,
        }))
      : Array.isArray(db.users)
        ? db.users
        : [];
    const presence = db.presence || {};
    return users
      .map((u) => {
        const p = presence[u.id] || {};
        const seenTs = Date.parse(p.lastSeenAt || "") || 0;
        return {
          userId: u.id || "",
          username: safeName(u.username || p.username || p.name || "player").toLowerCase(),
          name: safeName(u.username || p.username || p.name || "Player"),
          email: String(u.email || ""),
          lastSeenAt: p.lastSeenAt || null,
          lastLoginAt: u.lastLoginAt || p.lastLoginAt || u.createdAt || null,
          online: seenTs > 0 && now - seenTs <= ONLINE_WINDOW_MS,
        };
      })
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.username.localeCompare(b.username);
      });
  }, [db.presence, db.users, profiles]);

  function setCashBuyIn(v) {
    updateLiveSettings((live) => ({
      ...live,
      buyInCashAmount: Math.max(1, Number(v) || 1),
    }));
  }

  function setChipStack(v) {
    updateLiveSettings((live) => ({
      ...live,
      buyInChipStack: Math.max(1, Number(v) || 1),
    }));
  }

  function setPrizeEnabled(v) {
    updateLiveSettings((live) => ({ ...live, prizeEnabled: !!v }));
  }

  function setPrizePerPlayer(v) {
    updateLiveSettings((live) => ({
      ...live,
      prizePerPlayer: Math.max(0, Number(v) || 0),
    }));
  }

  function setGameMode(v) {
    updateLiveSettings((live) => ({
      ...live,
      mode: v === "cash" ? "cash" : "tournament",
    }));
  }

  function setPotHolderPlayerId(v) {
    updateLive((live) => ({
      ...live,
      potHolderPlayerId: String(v || ""),
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
    updateLive((live) => {
      const cashPerBuyIn = Math.max(1, Number(live?.buyInCashAmount) || 1);
      return {
        ...live,
        players: live.players.map((p) => {
          if (p.id !== playerId) return p;
          const next = { ...p, ...patch };
          if (Object.prototype.hasOwnProperty.call(patch, "buyIns")) {
            const nextBuyIns = Math.max(0, parseInt(patch.buyIns || 0, 10) || 0);
            next.buyIns = nextBuyIns;
            next.buyInEntries = syncBuyInEntries(next, nextBuyIns, cashPerBuyIn);
          }
          return next;
        }),
      };
    });
  }

  function setPlayerBuyInPaidStatus(playerId, paid) {
    updateLive((live) => {
      const cashPerBuyIn = Math.max(1, Number(live?.buyInCashAmount) || 1);
      return {
        ...live,
        players: live.players.map((p) => {
          if (p.id !== playerId) return p;
          const entries = syncBuyInEntries(p, p.buyIns, cashPerBuyIn).map((e) => ({
            amount: round2(Math.max(0, Number(e.amount) || cashPerBuyIn)),
            paid: !!paid,
          }));
          return { ...p, buyInEntries: entries };
        }),
      };
    });
  }

  function addPlayer() {
    updateLive((live) => ({ ...live, players: [...live.players, blankPlayer()] }));
    pushToast("Player added");
    setGuestPlayerName("");
    setSelectedLinkedPlayerId("");
  }

  function addLinkedPlayer() {
    const profileRow = (profiles || []).find((p) => p.id === selectedLinkedPlayerId);
    if (!profileRow) {
      alert("Select an existing user first.");
      return;
    }
    const exists = (db.live?.players || []).some((p) => playerRefId(p, "") === profileRow.id);
    if (exists) {
      alert("That user is already in the live player list.");
      return;
    }
    const rowId = uid();
    updateLive((live) => ({
      ...live,
      players: [
        ...live.players,
        {
          id: rowId,
          playerId: profileRow.id,
          linkedProfileId: profileRow.id,
          name: safeName(profileRow.nickname || profileRow.email?.split("@")[0] || "Player"),
          buyIns: 0,
          buyInEntries: [],
          cashOut: 0,
        },
      ],
    }));
    pushToast("Player added");
    setSelectedLinkedPlayerId("");
    setGuestPlayerName("");
  }

  function addGuestPlayer() {
    const name = String(guestPlayerName || "").trim();
    if (!name) {
      alert("Enter guest player name.");
      return;
    }
    const rowId = uid();
    updateLive((live) => ({
      ...live,
      players: [
        ...live.players,
        {
          id: rowId,
          playerId: `unlinked:${rowId}`,
          linkedProfileId: null,
          name: safeName(name),
          buyIns: 0,
          buyInEntries: [],
          cashOut: 0,
        },
      ],
    }));
    pushToast("Player added");
    setGuestPlayerName("");
    setSelectedLinkedPlayerId("");
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
      players: last.players.map((p) => {
        const rowId = uid();
        return {
          id: rowId,
          playerId: playerRefId(p, rowId),
          linkedProfileId: playerRefId(p, "").includes("unlinked:") ? null : playerRefId(p, ""),
          name: safeName(p.name || ""),
          buyIns: 0,
          buyInEntries: [],
          cashOut: 0,
        };
      }),
    }));
  }

  function mergePlayers() {
    const sourceId = String(mergeSourcePlayerId || "");
    const targetId = String(mergeTargetPlayerId || "");
    if (!sourceId || !targetId) {
      alert("Select both source and target players.");
      return;
    }
    if (sourceId === targetId) {
      alert("Source and target must be different.");
      return;
    }
    const source = knownPlayerOptions.find((p) => p.id === sourceId);
    const target = knownPlayerOptions.find((p) => p.id === targetId);
    const ok = window.confirm(
      `Merge player records?\n\nFrom: ${source?.name || sourceId}\nInto: ${target?.name || targetId}\n\nThis updates live + history references.`
    );
    if (!ok) return;

    const nextHistory = (db.history || []).map((h) => {
      const players = (h.players || []).map((p) => {
        if (!playerMatchesSource(p, sourceId)) return p;
        return {
          ...p,
          playerId: targetId,
          name: target?.name || p.name,
        };
      });

      const remapTx = (t) => {
        const sourceName = decodeLegacyNamePlayerId(sourceId);
        const fromMatches = t?.fromId === sourceId || (isLegacyNamePlayerId(sourceId) && safeName(t?.from).toLowerCase() === sourceName);
        const toMatches = t?.toId === sourceId || (isLegacyNamePlayerId(sourceId) && safeName(t?.to).toLowerCase() === sourceName);
        const nextFromId = fromMatches ? targetId : (t?.fromId || "");
        const nextToId = toMatches ? targetId : (t?.toId || "");
        if (nextFromId && nextToId && nextFromId === nextToId) return null;
        return {
          ...t,
          fromId: nextFromId,
          toId: nextToId,
          from: fromMatches ? (target?.name || t.from) : t.from,
          to: toMatches ? (target?.name || t.to) : t.to,
        };
      };

      const txnsNoPrize = normalizeTransferList((h.txnsNoPrize || []).map(remapTx).filter(Boolean));
      const txnsWithPrize = normalizeTransferList((h.txnsWithPrize || []).map(remapTx).filter(Boolean));
      const txns = normalizeTransferList((h.txns || []).map(remapTx).filter(Boolean));
      const prizePayments = (Array.isArray(h.prizePayments) ? h.prizePayments : [])
        .map((p) => {
          const sourceName = decodeLegacyNamePlayerId(sourceId);
          const fromMatches = p?.fromId === sourceId || (isLegacyNamePlayerId(sourceId) && safeName(p?.from).toLowerCase() === sourceName);
          const toMatches = p?.toId === sourceId || (isLegacyNamePlayerId(sourceId) && safeName(p?.to).toLowerCase() === sourceName);
          const nextFromId = fromMatches ? targetId : (p?.fromId || "");
          const nextToId = toMatches ? targetId : (p?.toId || "");
          if (nextFromId && nextToId && nextFromId === nextToId) return null;
          return {
            ...p,
            fromId: nextFromId,
            toId: nextToId,
            from: fromMatches ? (target?.name || p.from) : p.from,
            to: toMatches ? (target?.name || p.to) : p.to,
          };
        })
        .filter(Boolean);
      const winnerPlayerIds = Array.isArray(h?.settings?.winnerPlayerIds)
        ? Array.from(new Set(h.settings.winnerPlayerIds.map((id) => (id === sourceId ? targetId : id))))
        : h?.settings?.winnerPlayerIds;

      return {
        ...h,
        settings: {
          ...(h.settings || {}),
          winnerPlayerIds,
        },
        players,
        txns,
        txnsNoPrize,
        txnsWithPrize,
        prizePayments,
      };
    });

    const nextLive = {
      ...(db.live || defaultDB().live),
      players: (db.live?.players || []).map((p) => {
        if (!playerMatchesSource(p, sourceId)) return p;
        const nextName = target?.name || p.name;
        return {
          ...p,
          playerId: targetId,
          linkedProfileId: targetId.startsWith("unlinked:") ? null : targetId,
          name: nextName,
        };
      }),
      potHolderPlayerId:
        String(db.live?.potHolderPlayerId || "") === sourceId
          ? targetId
          : db.live?.potHolderPlayerId || "",
    };

    commit(
      {
        ...db,
        live: nextLive,
        history: nextHistory,
      },
      {
        cloudBucket: SYNC_STATE_KEYS.LIVE,
        additionalCloudWrites: [{ bucket: SYNC_STATE_KEYS.HISTORY, payload: nextHistory }],
      }
    );
    pushToast(`Merged ${source?.name || "player"} -> ${target?.name || "player"}`);
    setMergeSourcePlayerId("");
    setMergeTargetPlayerId("");
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
        winnerPlayerIds: computed.winnerIds,
      },
      players: computed.players.map((p) => ({
        id: p.id,
        playerId: playerRefId(p, p.id || ""),
        linkedProfileId: p.linkedProfileId || null,
        name: p.label,
        buyIns: p.buyIns,
        buyInEntries: normalizeBuyInEntries(p.buyInEntries, p.buyIns, computed.cashPerBuyIn),
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
      players: db.live.players.map((p) => ({ ...p, buyIns: 0, buyInEntries: [], cashOut: 0 })),
    };

    const nextHistory = [snapshot, ...db.history];
    const newDebts = computed.isCashMode
      ? buildUnpaidBuyInDebtRecords(db.live, {
          sessionId: snapshot.id,
          sessionDate: snapshot.stamp,
          mode: computed.mode,
        })
      : [];
    const prevDebts = Array.isArray(db.debts) ? db.debts : [];
    const existingIds = new Set(prevDebts.map((d) => String(d?.id || "")));
    const mergedDebts = [
      ...prevDebts,
      ...newDebts.filter((d) => d?.id && !existingIds.has(String(d.id))),
    ];
    const autoBackupCsv = dbToCsvPayload({
      ...db,
      history: nextHistory,
      debts: mergedDebts,
      live: nextLive,
      autoBackups: db.autoBackups || [],
    });

    commit(
      {
        ...db,
        history: nextHistory,
        debts: mergedDebts,
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
      },
      {
        cloudBucket: SYNC_STATE_KEYS.LIVE,
        additionalCloudWrites: [
          { bucket: SYNC_STATE_KEYS.HISTORY, payload: nextHistory },
          { bucket: SYNC_STATE_KEYS.DEBTS, payload: mergedDebts },
        ],
      }
    );

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
    commit(
      { ...db, history: nextHistory },
      { cloudBucket: SYNC_STATE_KEYS.HISTORY, cloudPayload: nextHistory }
    );
  }

  function setDebtSettled(debtId, settled) {
    const nextDebts = (Array.isArray(db.debts) ? db.debts : []).map((d) =>
      d?.id === debtId
        ? {
            ...d,
            settled: !!settled,
            settledAt: settled ? new Date().toISOString() : null,
            settledBy: settled ? currentUser?.name || currentUser?.username || null : null,
          }
        : d
    );
    commit(
      { ...db, debts: nextDebts },
      { cloudBucket: SYNC_STATE_KEYS.DEBTS, cloudPayload: nextDebts }
    );
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
    commit(
      { ...db, history: nextHistory },
      { cloudBucket: SYNC_STATE_KEYS.HISTORY, cloudPayload: nextHistory }
    );
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
    commit(
      {
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
        debts: [],
      },
      {
        cloudBucket: SYNC_STATE_KEYS.LIVE,
        additionalCloudWrites: [
          { bucket: SYNC_STATE_KEYS.HISTORY, payload: [] },
          { bucket: SYNC_STATE_KEYS.DEBTS, payload: [] },
        ],
      }
    );
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
            ? "Cloud sync unavailable"
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

  if (authLoading) {
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

  if (!currentUser) {
    return authView === "signup" ? (
      <SignupPage onSwitchToLogin={() => setAuthView("login")} />
    ) : (
      <LoginPage onSwitchToSignup={() => setAuthView("signup")} />
    );
  }

  return (
    <div className="app">
      <main className="content">
        <section className="space-y-4">
          <SessionHeader
            user={profile?.nickname || currentUser.name}
            onLogout={signOut}
          />
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
            modeLabel={db.live?.mode === "cash" ? "CASH GAME MODE" : "TOURNAMENT MODE"}
          />
        </div>
        {tab === "live" && db.live?.mode === "cash" && (
          <section className="pot-holder-strip">
            <label className="pot-holder-label" htmlFor="pot-holder-select">Pot Holder</label>
            <select
              id="pot-holder-select"
              className="pot-holder-select"
              value={computed.potHolderPlayerId || ""}
              onChange={(e) => setPotHolderPlayerId(e.target.value)}
            >
              {computed.players.map((p) => {
                const pid = playerRefId(p, p.id || "");
                return (
                  <option key={`holder-${pid}`} value={pid}>
                    {p.label}
                  </option>
                );
              })}
            </select>
          </section>
        )}

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
                      <div className="text-xs text-emerald-200/65">{p.email || "-"}</div>
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
          <section className="mx-auto max-w-2xl space-y-6">
            <AuthSettingsPage />

            <section className="rounded-2xl bg-emerald-900/40 p-5 ring-1 ring-white/10 transition-all duration-150 hover:bg-white/10">
              <h3 className="text-lg font-semibold text-emerald-50">Session Mapping</h3>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-wide text-emerald-300/60">1 Buy-in (Cash)</span>
                  <input
                    className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
                    type="number"
                    min="1"
                    value={db.live.buyInCashAmount}
                    onChange={(e) => setCashBuyIn(e.target.value)}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-wide text-emerald-300/60">1 Buy-in (Chip Stack)</span>
                  <input
                    className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
                    type="number"
                    min="1"
                    value={db.live.buyInChipStack}
                    onChange={(e) => setChipStack(e.target.value)}
                  />
                </label>
                {db.live?.mode === "tournament" && (
                  <>
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-wide text-emerald-300/60">Prize per player (AUD)</span>
                      <input
                        className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
                        type="number"
                        min="0"
                        step="1"
                        value={db.live.prizePerPlayer}
                        onChange={(e) => setPrizePerPlayer(e.target.value)}
                      />
                    </label>
                    <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                      <span className="text-xs uppercase tracking-wide text-emerald-300/60">Prize mechanic enabled</span>
                      <input
                        type="checkbox"
                        checked={!!db.live.prizeEnabled}
                        onChange={(e) => setPrizeEnabled(e.target.checked)}
                      />
                    </label>
                  </>
                )}
                <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 sm:col-span-2">
                  <div className="text-xs uppercase tracking-wide text-emerald-300/60">Game Mode</div>
                  <div className="game-mode-toggle">
                    <button
                      type="button"
                      className={(db.live?.mode || "tournament") === "tournament" ? "mode-btn active" : "mode-btn"}
                      onClick={() => setGameMode("tournament")}
                    >
                      Tournament
                    </button>
                    <button
                      type="button"
                      className={db.live?.mode === "cash" ? "mode-btn active" : "mode-btn"}
                      onClick={() => setGameMode("cash")}
                    >
                      Cash Game
                    </button>
                  </div>
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-wide text-emerald-300/60">Current mapping</div>
                <strong className="text-emerald-50">
                  {money(computed.cashPerBuyIn)} = {computed.chipsPerBuyIn.toLocaleString()} chips
                </strong>
                <div className="text-xs text-emerald-200/50">1 AUD = {computed.chipsPerDollar.toFixed(2)} chips</div>
              </div>
            </section>

            <section className="rounded-2xl bg-emerald-900/40 p-5 ring-1 ring-white/10 transition-all duration-150 hover:bg-white/10">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold text-emerald-50">Database Status</h3>
                <span className="text-xs text-emerald-200/60">{hasDatabase() ? "Supabase configured" : "Local mode"}</span>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${syncState === "connected" ? "bg-emerald-400" : syncState === "error" ? "bg-red-400" : "bg-emerald-200/60"}`}
                />
                <span className={syncState === "error" ? "text-red-300" : "text-emerald-200"}>
                  {syncState === "local-only"
                    ? "Local only (set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)"
                    : syncState}
                </span>
              </div>
              {syncState === "error" ? (
                <div className="mt-2 text-xs text-amber-200/90">
                  <div>Cloud sync unavailable</div>
                  <div>Using local session only</div>
                </div>
              ) : null}
              {syncError ? <div className="mt-2 text-xs text-red-300">{syncError}</div> : null}
              {syncState === "error" && String(syncError || "").toLowerCase().includes("row-level security") ? (
                <div className="mt-3 space-y-2">
                  <button
                    className="rounded-xl border border-white/10 bg-emerald-800/60 px-3 py-2 text-sm font-semibold text-emerald-100 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                    onClick={() => setShowRlsHelp((v) => !v)}
                  >
                    {showRlsHelp ? "Hide DB Fix SQL" : "Show DB Fix SQL"}
                  </button>
                  {showRlsHelp ? (
                    <pre className="whitespace-pre-wrap rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-emerald-200/70">
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

            <section className="rounded-2xl bg-emerald-900/40 p-5 ring-1 ring-white/10 transition-all duration-150 hover:bg-white/10">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold text-emerald-50">Admin Actions</h3>
                <div className="text-xs text-emerald-200/50">Applies to all users</div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="text-xs text-emerald-200/50">
                  Removes all saved session history and resets live session to empty defaults.
                </div>
                <div className="text-xs text-emerald-200/50">
                  Last clear: {lastClear ? `${new Date(lastClear.at).toLocaleString()} by ${lastClear.by}` : "never"}
                </div>
                <button
                  className="w-full rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={clearAllSessionData}
                >
                  Clear Data
                </button>
              </div>
              <div className="mt-5 space-y-3">
                <div className="text-xs uppercase tracking-wide text-emerald-300/60">Merge Players</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <select
                    className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
                    value={mergeSourcePlayerId}
                    onChange={(e) => setMergeSourcePlayerId(e.target.value)}
                  >
                    <option value="">Source player...</option>
                    {knownPlayerOptions.map((p) => (
                      <option key={`src-${p.id}`} value={p.id}>
                        {p.name}{p.linked ? " (linked)" : " (unlinked)"}
                      </option>
                    ))}
                  </select>
                  <select
                    className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
                    value={mergeTargetPlayerId}
                    onChange={(e) => setMergeTargetPlayerId(e.target.value)}
                  >
                    <option value="">Target player...</option>
                    {knownPlayerOptions
                      .filter((p) => p.id !== mergeSourcePlayerId)
                      .map((p) => (
                        <option key={`dst-${p.id}`} value={p.id}>
                          {p.name}{p.linked ? " (linked)" : " (unlinked)"}
                        </option>
                      ))}
                  </select>
                </div>
                <button
                  className="w-full rounded-xl border border-white/10 bg-emerald-800/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={mergePlayers}
                >
                  Merge Players
                </button>
              </div>
            </section>

            <section className="rounded-2xl bg-emerald-900/40 p-5 ring-1 ring-white/10 transition-all duration-150 hover:bg-white/10">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold text-emerald-50">Backup</h3>
                <div className="text-xs text-emerald-200/50">Export or restore app data</div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  className="rounded-xl bg-gradient-to-b from-amber-400/80 to-amber-600/80 px-4 py-2.5 text-sm font-bold text-amber-950 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={downloadSessionReportCsv}
                >
                  Download Session Report (.csv)
                </button>
                <button
                  className="rounded-xl border border-white/10 bg-emerald-800/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={downloadBackup}
                >
                  Download Raw Backup (.csv)
                </button>
                <button
                  className="rounded-xl border border-white/10 bg-emerald-800/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={() => backupInputRef.current?.click()}
                >
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
              <div className="mt-4 space-y-1 text-xs text-emerald-200/50">
                <div>Restore replaces current data. Keep a fresh CSV backup before restoring another file.</div>
                <div>Session Report CSV is for Sheets/Excel. Raw Backup CSV is for app restore.</div>
                <div>Auto backup is saved after every "End & Save Session" (keeps latest 20).</div>
              </div>
              {(db.autoBackups || []).length > 0 ? (
                <div className="mt-4 space-y-3">
                  {(db.autoBackups || []).slice(0, 5).map((b) => (
                    <div key={b.id} className="rounded-xl border border-white/10 bg-white/5 p-3">
                      <div className="text-xs text-emerald-200/60">
                        {new Date(b.at).toLocaleString()} by {b.by}
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          className="rounded-xl bg-gradient-to-b from-amber-400/80 to-amber-600/80 px-3 py-2 text-sm font-bold text-amber-950 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                          onClick={() => downloadSessionReportFromBackupCsv(b.csv, "classmates-auto-session-report")}
                        >
                          Session Report CSV
                        </button>
                        <button
                          className="rounded-xl border border-white/10 bg-emerald-800/60 px-3 py-2 text-sm font-semibold text-emerald-100 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                          onClick={() => downloadBackupCsv(b.csv, "classmates-auto-backup")}
                        >
                          Raw Backup CSV
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-4 text-xs text-emerald-200/50">No auto backups yet.</div>
              )}
              {(db.autoBackups || []).length > 5 ? (
                <div className="mt-2 text-xs text-emerald-200/50">
                  Showing latest 5 of {(db.autoBackups || []).length} auto backups.
                </div>
              ) : null}
            </section>
          </section>
        )}

        {tab === "live" && (
          <div className="space-y-4 mt-3">
            <section className="rounded-2xl bg-emerald-950/40 p-4 ring-1 ring-white/10 space-y-4 mt-3">
              <button
                type="button"
                onClick={() => setAddPlayerOpen((v) => !v)}
                className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left transition-all duration-150 hover:bg-white/5 hover:scale-[1.01] active:scale-[0.98]"
              >
                <span className="text-sm font-semibold text-emerald-100">Add Player</span>
                <span className="text-emerald-200/70">{addPlayerOpen ? "Hide" : "Show"}</span>
              </button>
              <div
                className={`grid overflow-hidden transition-all duration-200 ${addPlayerOpen ? "max-h-[420px] opacity-100 translate-y-0" : "max-h-0 opacity-0 -translate-y-1"}`}
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="text-xs text-emerald-300/60 font-medium">Select existing user</div>
                    <select
                      ref={addPlayerSelectRef}
                      className="h-12 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-emerald-50 outline-none transition-all focus:ring-2 focus:ring-emerald-400/40"
                      value={selectedLinkedPlayerId}
                      onChange={(e) => setSelectedLinkedPlayerId(e.target.value)}
                    >
                      <option value="">Select registered user...</option>
                      {availableLinkedProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {safeName(p.nickname || p.email?.split("@")[0] || "Player")} {p.email ? `(${p.email})` : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      className="w-full rounded-xl bg-emerald-700/70 shadow-[0_0_18px_rgba(52,211,153,0.14)] px-4 py-2.5 text-sm font-semibold text-emerald-50 ring-1 ring-emerald-300/20 transition-all duration-150 hover:scale-[1.02] active:scale-[0.97]"
                      onClick={addLinkedPlayer}
                    >
                      Add player
                    </button>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-white/30 my-2">
                    <div className="h-px bg-white/10 flex-1" />
                    <span>or</span>
                    <div className="h-px bg-white/10 flex-1" />
                  </div>

                  <div className="space-y-2 pt-3 border-t border-white/5">
                    <div className="text-xs text-emerald-300/60 font-medium">Add guest player</div>
                    <input
                      type="text"
                      value={guestPlayerName}
                      onChange={(e) => setGuestPlayerName(e.target.value)}
                      placeholder="Guest player name"
                      className="h-12 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-emerald-50 outline-none transition-all focus:ring-2 focus:ring-emerald-400/40"
                    />
                    {similarGuestName ? (
                      <div className="text-xs text-amber-200/90">
                        ⚠️ Similar player exists. Consider selecting instead.
                      </div>
                    ) : null}
                    <button
                      className="w-full rounded-xl bg-emerald-900/40 border border-white/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-all duration-150 hover:scale-[1.02] active:scale-[0.97]"
                      onClick={addGuestPlayer}
                    >
                      Add guest
                    </button>
                  </div>

                  <button
                    className="w-full rounded-xl bg-emerald-900/40 border border-white/10 px-4 py-2.5 text-sm font-semibold text-emerald-200/90 transition-all duration-150 hover:scale-[1.02] active:scale-[0.97] pt-3 border-t border-white/5"
                    onClick={applyLastLineup}
                  >
                    Load last lineup
                  </button>
                </div>
              </div>
            </section>

            {computed.isCashMode ? null : <PrizeSummary computed={computed} money={money} />}

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
              <div className={`session-summary-head ${computed.isCashMode ? "cash-mode" : "tournament-mode"}`}>
                <h3>Game Summary</h3>
                <span className="muted small">
                  {computed.isCashMode ? "Buy-ins vs final payouts reference" : "Buy-ins vs cash-outs reference"}
                </span>
              </div>
              <div className={computed.isCashMode ? "" : "summary-table-scroll"}>
                <div className="summary-table-wrap">
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th className="player-column">Player</th>
                        <th>Buy-ins</th>
                        <th>Cash-out</th>
                        <th>{computed.isCashMode ? "Profit/Loss" : "Net (No Prize)"}</th>
                        {computed.isCashMode ? null : <th>Prize Adj</th>}
                        {computed.isCashMode ? null : <th>Net (With Prize)</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {computed.players.map((p) => (
                        <tr key={`sum-${p.id}`}>
                          <td className="player-column">
                            <div
                              className="player-cell summary-player-cell"
                              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0 }}
                            >
                              <span
                                className="player-name summary-player-name"
                                title={p.label}
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  flex: 1,
                                  minWidth: 0,
                                }}
                              >
                                {p.label}
                              </span>
                            </div>
                          </td>
                          <td>{p.buyIns}</td>
                          <td>{money(p.cashOut)}</td>
                          <td className={p.baseNetCash >= 0 ? "pos" : "neg"}>
                            {money(p.baseNetCash)}
                          </td>
                          {computed.isCashMode ? null : (
                            <td className={p.prizeAdj >= 0 ? "pos" : "neg"}>
                              {p.prizeAdj >= 0 ? "+" : ""}{money(p.prizeAdj)}
                            </td>
                          )}
                          {computed.isCashMode ? null : <td className={p.netCash >= 0 ? "pos" : "neg"}>{money(p.netCash)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {computed.isCashMode && (
              <section className="panel buyin-progress-panel">
                <div className="buyin-progress-head">
                  <span className="muted">Pot Collected</span>
                  <strong>{money(buyInDebtSummary.collected)} / {money(buyInDebtSummary.total)}</strong>
                </div>
              </section>
            )}

            <section className="panel table-panel">
              <div className="desktop-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Buy-ins</th>
                      <th>Buy-in Value</th>
                      <th>{computed.isCashMode ? "Final Chips" : "Cash-out"}</th>
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
                        {computed.isCashMode ? (
                          <div className="buyin-status-row">
                            <span className="muted small">Payment:</span>
                            {(() => {
                              const entries = normalizeBuyInEntries(p.buyInEntries, p.buyIns, computed.cashPerBuyIn);
                              const hasEntries = entries.length > 0;
                              const allPaid = hasEntries && entries.every((e) => !!e.paid);
                              return (
                                <button
                                  type="button"
                                  className={`buyin-status-toggle ${allPaid ? "is-paid" : "is-unpaid"}`}
                                  disabled={!hasEntries}
                                  onClick={() => setPlayerBuyInPaidStatus(p.id, !allPaid)}
                                >
                                  {allPaid ? "Paid ✓" : "Unpaid"}
                                </button>
                              );
                            })()}
                          </div>
                        ) : null}
                        {computed.prizeEnabled && (
                          <div className="prize-chip">Prize adj: {p.prizeAdj >= 0 ? "+" : ""}{money(p.prizeAdj)}</div>
                        )}
                      </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step={computed.isCashMode ? "1" : "0.01"}
                            className={flashMap[`${p.id}-cashout`] === "up" ? "field-flash-up" : flashMap[`${p.id}-cashout`] ? "field-flash-neutral" : ""}
                            value={Number(p.cashOutInput || 0) === 0 ? "" : p.cashOutInput}
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
                          <button
                            className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-300 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                            onClick={() => removePlayer(p.id)}
                          >
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
                    {computed.isCashMode && (
                      <div className="mobile-player-row">
                        <span className="muted">Payment status</span>
                        {(() => {
                          const entries = normalizeBuyInEntries(p.buyInEntries, p.buyIns, computed.cashPerBuyIn);
                          const hasEntries = entries.length > 0;
                          const allPaid = hasEntries && entries.every((e) => !!e.paid);
                          return (
                            <button
                              type="button"
                              className={`buyin-status-toggle ${allPaid ? "is-paid" : "is-unpaid"}`}
                              disabled={!hasEntries}
                              onClick={() => setPlayerBuyInPaidStatus(p.id, !allPaid)}
                            >
                              {allPaid ? "Paid ✓" : "Unpaid"}
                            </button>
                          );
                        })()}
                      </div>
                    )}
                    <div className="mobile-player-row">
                      <span className="muted">{computed.isCashMode ? "Final chips" : "Cash-out"}</span>
                      <input
                        type="number"
                        min="0"
                        step={computed.isCashMode ? "1" : "0.01"}
                        className={flashMap[`${p.id}-cashout`] === "up" ? "field-flash-up" : flashMap[`${p.id}-cashout`] ? "field-flash-neutral" : ""}
                        value={Number(p.cashOutInput || 0) === 0 ? "" : p.cashOutInput}
                        onChange={(e) => updatePlayer(p.id, { cashOut: Number(e.target.value || 0) })}
                        onFocus={() => setActiveEditPlayerId(p.id)}
                      />
                    </div>
                    <button
                      className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-300 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
                      onClick={() => removePlayer(p.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <h3>Live Settlement Preview</h3>
              {computed.liveSettlementTxns.length === 0 ? (
                <div className="muted">No transfers required right now.</div>
              ) : (
                <div className="tx-grid">
                  {computed.liveSettlementTxns.map((t) => (
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
            <div className="mb-20" />
            <BottomStickyAction
              onSave={endAndSaveSession}
              disabled={Math.abs(computed.diff) > 0.01}
            />
          </div>
        )}

        {tab === "debts" && (
          <section className="panel">
            <h3>Outstanding Debts</h3>
            {persistedOutstandingDebts.length === 0 ? (
              <div className="muted">No unpaid buy-ins.</div>
            ) : (
              <div className="debt-live-list">
                {persistedOutstandingDebts.map((d) => (
                  <div key={d.id} className="debt-card">
                    <div className="debt-card-main">
                      <div className="debt-card-title">
                        {safeName(d.fromPlayerName || d.fromPlayerId || "Player")} owes {safeName(d.toPlayerName || d.toPlayerId || "Pot Holder")}
                      </div>
                      <div className="debt-card-amount">{money(d.amount)}</div>
                      <div className="debt-card-meta muted">
                        {d.sessionDate ? new Date(d.sessionDate).toLocaleDateString() : "-"} • {formatModeLabel(d.mode)} • {formatDebtTypeLabel(d.type)}
                      </div>
                    </div>
                    <div className="debt-card-actions">
                      <button
                        type="button"
                        className="tiny-btn"
                        onClick={() => setDebtSettled(d.id, true)}
                      >
                        Mark paid
                      </button>
                    </div>
                  </div>
                ))}
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
                    const debtSummary = debtSummaryBySessionId.get(String(h.id || "")) || null;
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
                  {isOpen && debtSummary && debtSummary.total > 0 ? (
                    <div className={`history-debt-line ${debtSummary.outstanding > 0 ? "is-open" : "is-settled"}`}>
                      <span>Outstanding debt: {money(debtSummary.outstanding)}</span>
                      {debtSummary.outstanding > 0 ? (
                        <span className="muted"> · Settled so far {money(debtSummary.settled)}</span>
                      ) : (
                        <span> · Debt settled later ✓</span>
                      )}
                    </div>
                  ) : null}
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
                                const buyInEntries = normalizeBuyInEntries(
                                  p.buyInEntries,
                                  p.buyIns,
                                  Number(settings.buyInCashAmount || 0)
                                );
                                const unpaidBuyIn = round2(
                                  buyInEntries
                                    .filter((e) => !e.paid)
                                    .reduce((sum, e) => sum + round2(Number(e.amount) || 0), 0)
                                );
                                return (
                                  <>
                              <td>
                                <div className="flex items-center gap-2">
                                  <span>{p.name}</span>
                                  <span
                                    className={
                                      isLinkedPlayer(p)
                                        ? "inline-flex rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30"
                                        : "inline-flex rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-200 ring-1 ring-white/20"
                                    }
                                  >
                                    {isLinkedPlayer(p) ? "Linked" : "Guest"}
                                  </span>
                                </div>
                                {Array.isArray(p.buyInEntries) && buyInEntries.length > 0 ? (
                                  <div className="muted small">
                                    Buy-ins paid: {buyInEntries.filter((e) => e.paid).length}/{buyInEntries.length}
                                    {unpaidBuyIn > 0 ? ` · Unpaid ${money(unpaidBuyIn)}` : ""}
                                  </div>
                                ) : null}
                              </td>
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
    <AuthProvider>
      <ErrorBoundary>
        <MainApp />
      </ErrorBoundary>
    </AuthProvider>
  );
}
