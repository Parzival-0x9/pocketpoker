// App.jsx (shortened demo)
import React from "react";

export default function App(){
  return (
    <div>
      <div className="topbar">
        <button className="hamburger">☰</button>
        <div className="brand"><h1>PocketPoker</h1><span className="badge">Local</span></div>
      </div>
      <div className="spacer" />
      <div className="container">
        <div className="surface">
          <h2>Game</h2>
          <p>Game section here…</p>
        </div>
      </div>
    </div>
  );
}
