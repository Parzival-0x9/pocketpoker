import { createClient } from "@supabase/supabase-js";

function sanitizeEnvValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const hasWrappingDouble = value.startsWith('"') && value.endsWith('"');
  const hasWrappingSingle = value.startsWith("'") && value.endsWith("'");
  if (hasWrappingDouble || hasWrappingSingle) {
    return value.slice(1, -1).trim();
  }
  return value;
}

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseUrl = sanitizeEnvValue(rawSupabaseUrl);
export const supabaseAnonKey = sanitizeEnvValue(rawSupabaseAnonKey);

export const hasSupabase = Boolean(supabaseUrl && supabaseAnonKey);
const isDev = import.meta.env.DEV;
let supabaseHost = "";
try {
  supabaseHost = supabaseUrl ? new URL(supabaseUrl).host : "";
} catch {
  supabaseHost = "";
}

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

export const supabaseRuntimeInfo = {
  rawEnvNames: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"],
  hasUrl: Boolean(supabaseUrl),
  hasAnonKey: Boolean(supabaseAnonKey),
  sanitizedHost: supabaseHost,
  anonKeyLength: String(supabaseAnonKey || "").length,
  urlSanitized: String(rawSupabaseUrl ?? "") !== supabaseUrl,
  keySanitized: String(rawSupabaseAnonKey ?? "") !== supabaseAnonKey,
  clientInitialized: Boolean(supabase),
};

if (isDev) {
  // Dev-only diagnostics for runtime env wiring.
  // Avoid logging full secrets.
  console.info("[Supabase Debug]", {
    hasUrl: supabaseRuntimeInfo.hasUrl,
    hasAnonKey: supabaseRuntimeInfo.hasAnonKey,
    anonKeyMasked: maskKey(supabaseAnonKey),
    anonKeyLength: supabaseRuntimeInfo.anonKeyLength,
    sanitizedHost: supabaseRuntimeInfo.sanitizedHost || "(invalid-url)",
    urlSanitized: supabaseRuntimeInfo.urlSanitized,
    keySanitized: supabaseRuntimeInfo.keySanitized,
    clientInitialized: supabaseRuntimeInfo.clientInitialized,
  });
}
