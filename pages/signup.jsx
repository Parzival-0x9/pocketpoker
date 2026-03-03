import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function SignupPage({ onSwitchToLogin }) {
  const { signUp, hasSupabase } = useAuth();
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signUp({ email: email.trim(), password, nickname: nickname.trim() });
      onSwitchToLogin();
    } catch (err) {
      setError(String(err?.message || err || "Signup failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app auth-bg">
      <div className="auth-shell">
        <div className="panel auth-panel">
          <div className="brand-kicker">CLASSMATES</div>
          <h3>Create Account</h3>
          <form className="auth-panel" onSubmit={onSubmit}>
            <label>
              Nickname
              <input type="text" value={nickname} onChange={(e) => setNickname(e.target.value)} required />
            </label>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
            </label>
            {error ? <div className="neg small">{error}</div> : null}
            <button className="btn btn-primary" type="submit" disabled={busy || !hasSupabase}>
              {busy ? "Creating..." : "Sign Up"}
            </button>
          </form>
          <button className="btn" type="button" onClick={onSwitchToLogin}>
            Back to sign in
          </button>
          {!hasSupabase ? (
            <div className="muted small">Supabase env vars missing. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
