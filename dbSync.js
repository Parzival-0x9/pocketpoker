import { hasSupabase, supabase, supabaseRuntimeInfo } from "./supabase";

const TABLE = "classmates_state";
const ROW_ID = "global";
const isDev = import.meta.env.DEV;

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

export async function fetchDatabaseState() {
  if (!supabase) {
    devLog("read.skip", { reason: "client missing" });
    return null;
  }
  devLog("read.start", { table: TABLE, id: ROW_ID, host: supabaseRuntimeInfo.sanitizedHost || "(invalid-url)" });
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("payload")
      .eq("id", ROW_ID)
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

export async function pushDatabaseState(payload) {
  if (!supabase) {
    devLog("write.skip", { reason: "client missing" });
    return null;
  }
  devLog("write.start", { table: TABLE, id: ROW_ID });
  try {
    const { error } = await supabase.from(TABLE).upsert(
      {
        id: ROW_ID,
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

export function subscribeDatabaseState(onState, onStatus) {
  if (!supabase) {
    devLog("realtime.skip", { reason: "client missing" });
    return () => {};
  }

  devLog("realtime.start", { table: TABLE, id: ROW_ID });

  const channel = supabase
    .channel("classmates-state-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: TABLE,
        filter: `id=eq.${ROW_ID}`,
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
