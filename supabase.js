import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const TABLE = "classmates_state";
const ROW_ID = "global";

const configured = Boolean(supabaseUrl && supabaseAnonKey);

const supabase = configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function hasDatabase() {
  return configured;
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

export async function signUpWithEmail({ name, email, password }) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
      },
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithEmail({ email, password }) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOutAuth() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getAuthSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session || null;
}

export function subscribeAuthState(onSession) {
  if (!supabase) return () => {};
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    onSession(session || null);
  });
  return () => {
    subscription.unsubscribe();
  };
}
