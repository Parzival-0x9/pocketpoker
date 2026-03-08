import { hasSupabase, supabase, supabaseRuntimeInfo } from "./supabase";

const TABLE = "classmates_state";
const isDev = import.meta.env.DEV;

export const SYNC_STATE_KEYS = {
  LIVE: "live",
  SETTINGS: "settings",
  HISTORY: "history",
  DEBTS: "debts",
  GLOBAL: "global",
};

function classifySyncError(err, stage) {
  const msg = String(err?.message || err || "").trim();
  const lower = msg.toLowerCase();
  if (!supabaseRuntimeInfo.hasUrl) return "Supabase URL missing";
  if (!supabaseRuntimeInfo.hasAnonKey) return "Anon key missing";
  if (!supabaseRuntimeInfo.sanitizedHost) return "Supabase URL invalid";
  if (lower.includes("timeout")) return "Network request timed out";
  if (lower.includes("invalid api key") || lower.includes("jwt")) return "Anon key invalid";
  if (lower.includes("row-level security") || lower.includes("permission denied")) return "Auth/RLS failure";
  if (lower.includes("load failed") || lower.includes("failed to fetch") || err?.name === "TypeError") {
    return "Read failed before response";
  }
  if (lower.includes("channel") || lower.includes("realtime") || lower.includes("closed")) {
    return "Realtime subscription failed";
  }
  if (err?.code || err?.status) return "Supabase error response";
  return `${stage} failed`;
}

function toDiagnosticError(err, stage) {
  const reason = classifySyncError(err, stage);
  const detail = String(err?.message || err || "Unknown error");
  const wrapped = new Error(`${reason} (${stage}): ${detail}`);
  wrapped.cause = err;
  wrapped.reason = reason;
  wrapped.stage = stage;
  return wrapped;
}

function devLog(tag, payload) {
  if (!isDev) return;
  console.info(`[DB Sync] ${tag}`, payload);
}

export function hasDatabase() {
  return hasSupabase;
}

export async function fetchStateByKey(key) {
  if (!supabase) {
    devLog("read.skip", { reason: "client missing" });
    return null;
  }
  const rowId = String(key || SYNC_STATE_KEYS.GLOBAL);
  devLog("read.start", { table: TABLE, id: rowId, host: supabaseRuntimeInfo.sanitizedHost || "(invalid-url)" });
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("payload")
      .eq("id", rowId)
      .maybeSingle();
    if (error) throw error;
    devLog("read.success", { hasPayload: Boolean(data?.payload) });
    return data?.payload || null;
  } catch (err) {
    const wrapped = toDiagnosticError(err, "read");
    devLog("read.error", { reason: wrapped.reason, detail: String(err?.message || err || "") });
    throw wrapped;
  }
}

export async function pushStateByKey(key, payload) {
  if (!supabase) {
    devLog("write.skip", { reason: "client missing" });
    return null;
  }
  const rowId = String(key || SYNC_STATE_KEYS.GLOBAL);
  devLog("write.start", { table: TABLE, id: rowId });
  try {
    const { error } = await supabase.from(TABLE).upsert(
      {
        id: rowId,
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
    if (error) throw error;
    devLog("write.success", { ok: true });
    return payload;
  } catch (err) {
    const wrapped = toDiagnosticError(err, "write");
    devLog("write.error", { reason: wrapped.reason, detail: String(err?.message || err || "") });
    throw wrapped;
  }
}

export function subscribeStateByKey(key, onState, onStatus) {
  if (!supabase) {
    devLog("realtime.skip", { reason: "client missing" });
    return () => {};
  }
  const rowId = String(key || SYNC_STATE_KEYS.GLOBAL);

  devLog("realtime.start", { table: TABLE, id: rowId });

  const channel = supabase
    .channel(`classmates-state-sync-${rowId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: TABLE,
        filter: `id=eq.${rowId}`,
      },
      (event) => {
        const payload = event?.new?.payload;
        if (payload && typeof payload === "object") onState(payload);
      }
    )
    .subscribe((status) => {
      devLog("realtime.status", { status });
      if (typeof onStatus === "function") onStatus(status);
    });

  return () => {
    devLog("realtime.stop", { removed: true });
    supabase.removeChannel(channel);
  };
}

export async function fetchDatabaseState() {
  return await fetchStateByKey(SYNC_STATE_KEYS.GLOBAL);
}

export async function pushDatabaseState(payload) {
  return await pushStateByKey(SYNC_STATE_KEYS.GLOBAL, payload);
}

export function subscribeDatabaseState(onState, onStatus) {
  return subscribeStateByKey(SYNC_STATE_KEYS.GLOBAL, onState, onStatus);
}
