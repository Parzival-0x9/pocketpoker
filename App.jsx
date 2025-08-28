import React, { useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import TabSwitcher from "./components/TabSwitcher.jsx";
import "./styles/phase2.css";

export default function App() {
  // Route controls what the main page is conceptually showing.
  // We keep 'game' as default so current flows remain intact.
  const [route, setRoute] = useState("game"); // "game" | "history" | "ledgers" | "profiles"
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Tabs for the combined History/Ledgers screen
  const [activeTab, setActiveTab] = useState("history"); // "history" | "ledgers"

  const openDrawer = () => setDrawerOpen(true);
  const closeDrawer = () => setDrawerOpen(false);

  const TopBar = () => (
    <div className="pp-topbar">
      <button className="pp-hamburger" onClick={openDrawer} aria-label="Open menu">☰</button>
      <div className="pp-title">PocketPoker</div>
      <div className="pp-spacer" />
      {/* If you have existing right-side actions from your previous topbar, paste them here */}
    </div>
  );

  // ——————————————————————————————————————————————————————————
  // PLACEHOLDERS: Paste your existing History and Ledgers JSX
  // Keep your state & logic elsewhere; this only wraps the rendering.
  // ——————————————————————————————————————————————————————————
  const HistoryBlock = () => (
    <div className="pp-section">
      {/* TODO: PASTE your existing "Game Overview (History)" JSX here */}
      <div style={{opacity:.7}}>History content placeholder — replace with your existing JSX.</div>
    </div>
  );

  const LedgersBlock = () => (
    <div className="pp-section">
      {/* TODO: PASTE your existing "Player Ledgers (Cumulative)" JSX here */}
      <div style={{opacity:.7}}>Ledgers content placeholder — replace with your existing JSX.</div>
    </div>
  );

  // If your current game / profiles are separate components, render them here.
  const CurrentGameBlock = () => (
    <div className="pp-section">
      {/* TODO: Your existing "Current Game" main UI remains here unchanged. */}
      <div style={{opacity:.7}}>Current Game placeholder — your existing UI continues to work.</div>
    </div>
  );

  const ProfilesBlock = () => (
    <div className="pp-section">
      {/* TODO: Your existing profiles UI */}
      <div style={{opacity:.7}}>Profiles placeholder.</div>
    </div>
  );

  // Page switcher
  const Page = () => {
    if (route === "history" || route === "ledgers") {
      return (
        <div className="pp-container">
          <TabSwitcher active={activeTab} onChange={setActiveTab} />
          <div className="pp-section">
            <div className={activeTab === "history" ? "" : "pp-hide"}>
              <HistoryBlock />
            </div>
            <div className={activeTab === "ledgers" ? "" : "pp-hide"}>
              <LedgersBlock />
            </div>
          </div>
        </div>
      );
    }
    if (route === "profiles") {
      return <div className="pp-container"><ProfilesBlock /></div>;
    }
    // default: current game
    return <div className="pp-container"><CurrentGameBlock /></div>;
  };

  return (
    <div style={{background:"#0f1115", minHeight:"100vh", color:"#e8ebf1"}}>
      <TopBar />
      <Sidebar
        open={drawerOpen}
        onClose={closeDrawer}
        activeRoute={route}
        onNavigate={(r) => {
          setRoute(r);
          if (r === "history") setActiveTab("history");
          if (r === "ledgers") setActiveTab("ledgers");
        }}
      />
      <Page />
    </div>
  );
}
