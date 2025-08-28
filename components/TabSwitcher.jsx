import React from "react";

export default function TabSwitcher({ active, onChange }) {
  return (
    <div className="pp-tabs">
      <button
        className={`pp-tab ${active === "history" ? "is-active" : ""}`}
        onClick={() => onChange("history")}
      >
        History
      </button>
      <button
        className={`pp-tab ${active === "ledgers" ? "is-active" : ""}`}
        onClick={() => onChange("ledgers")}
      >
        Ledgers
      </button>
    </div>
  );
}
