import React, { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function AuthSettingsPage() {
  const { user, profile, updateNickname, updatePassword } = useAuth();
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [busyNick, setBusyNick] = useState(false);
  const [busyPass, setBusyPass] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setNickname(profile?.nickname || "");
  }, [profile?.nickname]);

  async function onSaveNickname(e) {
    e.preventDefault();
    setBusyNick(true);
    setMessage("");
    setError("");
    try {
      await updateNickname(nickname);
      setMessage("Nickname updated.");
    } catch (err) {
      setError(String(err?.message || err || "Failed to update nickname"));
    } finally {
      setBusyNick(false);
    }
  }

  async function onSavePassword(e) {
    e.preventDefault();
    setBusyPass(true);
    setMessage("");
    setError("");
    try {
      await updatePassword(password);
      setPassword("");
      setMessage("Password updated.");
    } catch (err) {
      setError(String(err?.message || err || "Failed to update password"));
    } finally {
      setBusyPass(false);
    }
  }

  return (
    <section className="rounded-2xl bg-emerald-900/40 p-5 ring-1 ring-white/10 transition-all duration-150 hover:bg-white/10">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-emerald-50">Account</h3>
        <div>
          <div className="text-xs uppercase tracking-wide text-emerald-300/60">Email</div>
          <div className="text-sm text-emerald-100/80">{user?.email || "-"}</div>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <form className="space-y-3" onSubmit={onSaveNickname}>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-emerald-300/60">Nickname</span>
            <input
              className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              required
            />
          </label>
          <button
            className="w-full rounded-xl bg-emerald-800/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 ring-1 ring-white/10 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
            type="submit"
            disabled={busyNick}
          >
            {busyNick ? "Saving..." : "Update nickname"}
          </button>
        </form>

        <form className="space-y-3" onSubmit={onSavePassword}>
          <label className="space-y-2">
            <span className="text-xs uppercase tracking-wide text-emerald-300/60">New password</span>
            <input
              className="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-emerald-50"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </label>
          <button
            className="w-full rounded-xl bg-emerald-800/60 px-4 py-2.5 text-sm font-semibold text-emerald-100 ring-1 ring-white/10 transition-all duration-150 hover:scale-[1.02] active:scale-[0.98]"
            type="submit"
            disabled={busyPass}
          >
            {busyPass ? "Saving..." : "Update password"}
          </button>
        </form>
      </div>

      {message ? <div className="mt-3 text-xs text-emerald-300">{message}</div> : null}
      {error ? <div className="mt-3 text-xs text-red-300">{error}</div> : null}
    </section>
  );
}
