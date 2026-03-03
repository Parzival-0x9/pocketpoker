import { hasSupabase, supabase } from "./supabase";

const TABLE = "classmates_state";
const ROW_ID = "global";

export function hasDatabase() {
  return hasSupabase;
}

export async function fetchDatabaseState() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select("payload")
    .eq("id", ROW_ID)
    .maybeSingle();

  if (error) throw error;
  return data?.payload || null;
}

export async function pushDatabaseState(payload) {
  if (!supabase) return null;
  const { error } = await supabase.from(TABLE).upsert(
    {
      id: ROW_ID,
      payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
  if (error) throw error;
  return payload;
}

export function subscribeDatabaseState(onState) {
  if (!supabase) return () => {};

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
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
