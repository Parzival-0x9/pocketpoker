import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const hasSupabase = Boolean(supabaseUrl && supabaseAnonKey);
const isDev = import.meta.env.DEV;

function maskKey(v) {
  const key = String(v || "");
  if (!key) return "(missing)";
  if (key.length <= 10) return `${key[0] || ""}***${key[key.length - 1] || ""}`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export const supabase = hasSupabase
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

if (isDev) {
  // Dev-only diagnostics for runtime env wiring.
  // Avoid logging full secrets.
  console.info("[Supabase Debug]", {
    hasUrl: Boolean(supabaseUrl),
    hasAnonKey: Boolean(supabaseAnonKey),
    anonKeyMasked: maskKey(supabaseAnonKey),
    clientInitialized: Boolean(supabase),
  });
}
