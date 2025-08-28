import React from "react";

export default function Sidebar({ open, onClose, onNavigate, activeRoute }) {
  return (
    <div>
      {/* Backdrop */}
      <div
        className={`pp-backdrop ${open ? "pp-backdrop--show" : ""}`}
        onClick={onClose}
      />
      {/* Drawer */}
      <aside className={`pp-drawer ${open ? "pp-drawer--open" : ""}`}>
        <div className="pp-drawer__header">
          <div className="pp-logo">PocketPoker</div>
          <button className="pp-icon-btn" onClick={onClose} aria-label="Close sidebar">
            ✕
          </button>
        </div>
        <nav className="pp-drawer__nav">
          <button
            className={`pp-navlink ${activeRoute === "game" ? "is-active" : ""}`}
            onClick={() => { onNavigate("game"); onClose(); }}
          >
            🃏 Current Game
          </button>
          <button
            className={`pp-navlink ${activeRoute === "history" ? "is-active" : ""}`}
            onClick={() => { onNavigate("history"); onClose(); }}
          >
            📜 History
          </button>
          <button
            className={`pp-navlink ${activeRoute === "ledgers" ? "is-active" : ""}`}
            onClick={() => { onNavigate("ledgers"); onClose(); }}
          >
            📒 Ledgers
          </button>
          <button
            className={`pp-navlink ${activeRoute === "profiles" ? "is-active" : ""}`}
            onClick={() => { onNavigate("profiles"); onClose(); }}
          >
            👤 Profiles
          </button>
        </nav>
        <div className="pp-drawer__footer">
          <small>v7.5 • Phase 2</small>
        </div>
      </aside>
    </div>
  );
}
