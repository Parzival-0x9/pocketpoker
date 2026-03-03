import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function LoginPage({ onSwitchToSignup }) {
  const { signIn, hasSupabase, requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [error, setError] = useState("");
  const [resetMsg, setResetMsg] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn({ email: email.trim(), password });
    } catch (err) {
      setError(String(err?.message || err || "Login failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onForgotPassword() {
    const nextEmail = String(email || "").trim();
    if (!nextEmail) {
      setError("Enter your email first, then tap Forgot password.");
      return;
    }
    setResetBusy(true);
    setError("");
    setResetMsg("");
    try {
      await requestPasswordReset(nextEmail);
      setResetMsg("Password reset email sent. Check your inbox.");
    } catch (err) {
      setError(String(err?.message || err || "Failed to send reset email"));
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="app auth-bg">
      <div className="auth-shell">
        <div className="panel auth-panel">
          <div className="brand-kicker">CLASSMATES</div>
          <h3>Sign In</h3>
          <form className="auth-panel" onSubmit={onSubmit}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {error ? <div className="neg small">{error}</div> : null}
            {resetMsg ? <div className="pos small">{resetMsg}</div> : null}
            <button className="btn btn-primary" type="submit" disabled={busy || !hasSupabase}>
              {busy ? "Signing in..." : "Sign In"}
            </button>
          </form>
          <button className="btn" type="button" onClick={onForgotPassword} disabled={resetBusy || !hasSupabase}>
            {resetBusy ? "Sending reset..." : "Forgot password?"}
          </button>
          <button className="btn" type="button" onClick={onSwitchToSignup}>
            Create account
          </button>
          {!hasSupabase ? (
            <div className="muted small">Supabase env vars missing. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
