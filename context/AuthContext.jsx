import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { hasSupabase, supabase, supabaseAnonKey, supabaseUrl } from "../supabase";

const AuthContext = createContext(null);

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function signInViaRest(email, password) {
  if (!supabaseUrl || !supabaseAnonKey || !supabase) {
    throw new Error("Supabase is not configured.");
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String(payload?.error_description || payload?.msg || payload?.error || "Sign in failed"));
    }
    const accessToken = payload?.access_token;
    const refreshToken = payload?.refresh_token;
    if (!accessToken || !refreshToken) {
      throw new Error("Auth token response is incomplete.");
    }
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function normalizeProfileRow(row, user) {
  const email = row?.email || user?.email || "";
  const fallbackNick = email ? email.split("@")[0] : "player";
  return {
    id: row?.id || user?.id || "",
    email,
    nickname: row?.nickname || fallbackNick,
    role: row?.role || "user",
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [authLoading, setAuthLoading] = useState(true);

  async function loadProfile(nextUser) {
    if (!supabase || !nextUser?.id) {
      setProfile(null);
      return null;
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id,email,nickname,role")
      .eq("id", nextUser.id)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      const normalized = normalizeProfileRow(data, nextUser);
      setProfile(normalized);
      return normalized;
    }

    const insertPayload = {
      id: nextUser.id,
      email: nextUser.email || "",
      nickname: (nextUser.email || "player").split("@")[0],
      role: "user",
    };

    const { data: inserted, error: insertError } = await supabase
      .from("profiles")
      .upsert(insertPayload, { onConflict: "id" })
      .select("id,email,nickname,role")
      .single();

    if (insertError) throw insertError;
    const normalized = normalizeProfileRow(inserted, nextUser);
    setProfile(normalized);
    return normalized;
  }

  async function refreshProfiles(targetUser = user) {
    if (!supabase || !targetUser) {
      setProfiles([]);
      return [];
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id,email,nickname,role")
      .order("nickname", { ascending: true });

    if (error) throw error;
    const rows = Array.isArray(data)
      ? data.map((row) => normalizeProfileRow(row, null))
      : [];
    setProfiles(rows);
    return rows;
  }

  useEffect(() => {
    let mounted = true;
    if (!hasSupabase || !supabase) {
      setAuthLoading(false);
      return () => {};
    }

    const hydrateUser = async (nextUser) => {
      if (!nextUser || !mounted) return;
      try {
        await loadProfile(nextUser);
        await refreshProfiles(nextUser);
      } catch {
        if (mounted) setProfile(normalizeProfileRow(null, nextUser));
      }
    };

    (async () => {
      try {
        const { data, error } = await withTimeout(
          supabase.auth.getSession(),
          7000,
          "Auth session check timed out. Please retry."
        );
        if (!mounted) return;
        const nextSession = error ? null : data?.session || null;
        const nextUser = nextSession?.user || null;
        setSession(nextSession);
        setUser(nextUser);
        setAuthLoading(false);
        void hydrateUser(nextUser);
      } catch {
        if (!mounted) return;
        setSession(null);
        setUser(null);
        setProfile(null);
        setProfiles([]);
        setAuthLoading(false);
      }
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextUser = nextSession?.user || null;
      setSession(nextSession || null);
      setUser(nextUser);
      setAuthLoading(false);
      if (nextUser) {
        void hydrateUser(nextUser);
      } else {
        setProfile(null);
        setProfiles([]);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function signUp({ email, password, nickname }) {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data, error } = await withTimeout(
      supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            nickname: nickname || "",
          },
        },
      }),
      12000,
      "Signup timed out. Check connection and try again."
    );
    if (error) throw error;

    const nextUser = data?.user || null;
    if (nextUser?.id) {
      await supabase.from("profiles").upsert(
        {
          id: nextUser.id,
          email: nextUser.email || email,
          nickname: nickname || (email || "player").split("@")[0],
          role: "user",
        },
        { onConflict: "id" }
      );
    }

    return data;
  }

  async function signIn({ email, password }) {
    if (!supabase) throw new Error("Supabase is not configured.");
    try {
      const { data, error } = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        8000,
        "SDK sign-in timed out"
      );
      if (error) throw error;
      return data;
    } catch (err) {
      const msg = String(err?.message || err || "");
      const shouldFallback =
        msg.toLowerCase().includes("timed out") ||
        msg.toLowerCase().includes("network") ||
        msg.toLowerCase().includes("fetch");
      if (!shouldFallback) throw err;
      return signInViaRest(email, password);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  async function updateNickname(nickname) {
    if (!supabase || !user?.id) throw new Error("Not authenticated.");
    const value = String(nickname || "").trim();
    const { data, error } = await supabase
      .from("profiles")
      .upsert(
        {
          id: user.id,
          email: user.email || "",
          nickname: value || (user.email || "player").split("@")[0],
        },
        { onConflict: "id" }
      )
      .select("id,email,nickname,role")
      .single();
    if (error) throw error;
    setProfile(normalizeProfileRow(data, user));
    await refreshProfiles();
  }

  async function updatePassword(password) {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  }

  async function requestPasswordReset(email) {
    if (!supabase) throw new Error("Supabase is not configured.");
    const redirectTo = `${window.location.origin}`;
    const { error } = await withTimeout(
      supabase.auth.resetPasswordForEmail(email, { redirectTo }),
      12000,
      "Password reset request timed out. Please try again."
    );
    if (error) throw error;
  }

  const value = useMemo(
    () => ({
      hasSupabase,
      authLoading,
      loading: authLoading,
      session,
      user,
      profile,
      profiles,
      signUp,
      signIn,
      signOut,
      refreshProfiles,
      updateNickname,
      updatePassword,
      requestPasswordReset,
    }),
    [authLoading, session, user, profile, profiles]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
