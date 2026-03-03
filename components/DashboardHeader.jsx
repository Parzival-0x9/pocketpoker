import React from "react";

function cn(...parts) {
  return parts.filter(Boolean).join(" ");
}

export function SessionHeader({
  title = "CLASSMATES",
  slogan = "From classmates to cashmates ♠",
  user = "",
  onLogout,
}) {
  return (
    <header className="px-1 text-left">
      <div className="flex items-center gap-3">
        <div className="shrink-0 opacity-85">
          <svg
            viewBox="0 0 64 64"
            className="h-8 w-8"
            role="img"
            aria-label="Classmates poker logo"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="chipBg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#123528" />
                <stop offset="100%" stopColor="#0A1E16" />
              </linearGradient>
              <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F7D879" />
                <stop offset="100%" stopColor="#C79B39" />
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="29" fill="url(#chipBg)" stroke="url(#gold)" strokeWidth="2.2" />
            <circle cx="32" cy="32" r="22.5" fill="none" stroke="rgba(236,255,244,0.2)" strokeWidth="1.5" />
            <circle cx="32" cy="32" r="17.5" fill="#0B251B" stroke="rgba(247,216,121,0.45)" strokeWidth="1.2" />
            <path
              d="M32 21c2.8 4.2 7.8 6.8 7.8 11.3 0 3.2-2.6 5.7-5.7 5.7h-4.2c-3.1 0-5.7-2.5-5.7-5.7 0-4.5 5-7.1 7.8-11.3z"
              fill="url(#gold)"
            />
            <path d="M32 35.8l-4.3 8.2h8.6L32 35.8z" fill="url(#gold)" />
          </svg>
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-3">
            <h1 className="truncate text-3xl font-bold leading-none tracking-[0.18em] text-amber-400">{title}</h1>
            <button
              type="button"
              onClick={onLogout}
              className="shrink-0 flex items-center gap-1 text-sm font-medium text-red-300 transition-all duration-150 hover:scale-[1.02] hover:text-red-200 active:scale-[0.98]"
            >
              ⎋ Logout
            </button>
          </div>
          <p className="truncate text-sm italic font-medium leading-snug text-emerald-300/80">{slogan}</p>
          <p className="truncate text-xs text-white/50">{user}</p>
        </div>
      </div>
    </header>
  );
}

export function StatsHero({ loading = false, potCash, chips, difference, compact = false }) {
  const cells = [
    { label: "POT (Cash)", value: potCash, tone: "text-emerald-50" },
    { label: "CHIPS", value: chips, tone: "text-emerald-50" },
    {
      label: "DIFFERENCE",
      value: difference,
      tone: String(difference).startsWith("-") ? "text-red-300" : "text-emerald-300",
    },
  ];

  return (
    <section
      className={cn(
        "stats-hero-inner rounded-2xl bg-emerald-950/60 px-4 py-3 ring-1 ring-white/10 backdrop-blur-sm",
        compact ? "is-compact" : ""
      )}
    >
      <div className={cn("grid grid-cols-3 gap-2", compact ? "items-center" : "")}>
        {cells.map((cell) => (
          <div key={cell.label} className={cn(compact ? "space-y-0.5" : "space-y-1")}>
            <p className={cn("font-medium tracking-[0.12em] text-emerald-200/60", compact ? "text-[9px]" : "text-[10px]")}>
              {cell.label}
            </p>
            {loading ? (
              <div className={cn("animate-pulse rounded-md bg-white/10", compact ? "h-6 w-16" : "h-7 w-20")} />
            ) : (
              <p className={cn("font-bold leading-none", compact ? "text-base" : "text-lg", cell.tone)}>{cell.value}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function SyncStatusInline({
  statusTone = "muted",
  statusText,
  role = "Admin",
  syncNote = "",
  onSyncNow,
  onLogout,
  syncBusy = false,
  syncDisabled = false,
}) {
  const isConnected = statusTone === "connected";
  const statusToneClass =
    isConnected
      ? "text-emerald-300"
      : statusTone === "error"
        ? "text-red-300"
        : "text-emerald-200/70";

  return (
    <section className="flex items-center justify-between gap-2 px-1 text-xs">
      <div className="min-w-0 space-y-0.5">
        <p className={cn("truncate flex items-center gap-1.5", statusToneClass)}>
          {isConnected ? <span className="sync-dot" aria-hidden /> : null}
          <span>{statusText}</span>
        </p>
        {syncNote ? <p className="truncate text-emerald-200/65">{syncNote}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {onLogout ? (
          <button
            type="button"
            onClick={onLogout}
            className="rounded-full px-3 py-1 font-medium text-red-100 ring-1 ring-red-300/25 transition active:scale-95"
          >
            Logout
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSyncNow}
          disabled={syncBusy || syncDisabled}
          className="rounded-full px-3 py-1 font-medium text-emerald-100 ring-1 ring-white/15 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {syncBusy ? "Syncing..." : "Sync now"}
        </button>
        <span className="rounded-full bg-amber-300/15 px-2.5 py-1 font-semibold text-amber-200 ring-1 ring-amber-200/20">
          {role}
        </span>
      </div>
    </section>
  );
}

export function QuickActionsTop({ onAddPlayer, onLoadLineup }) {
  return (
    <section className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={onAddPlayer}
        className="rounded-xl bg-emerald-900/70 px-3 py-2.5 text-sm font-semibold text-emerald-50 ring-1 ring-white/10 transition active:scale-[0.98]"
      >
        Add Player
      </button>
      <button
        type="button"
        onClick={onLoadLineup}
        className="rounded-xl bg-emerald-900/50 px-3 py-2.5 text-sm font-semibold text-emerald-100 ring-1 ring-white/10 transition active:scale-[0.98]"
      >
        Load Lineup
      </button>
    </section>
  );
}

export function PrimaryNavTabs({ tabs, activeTab, onChange }) {
  return (
    <nav className="sticky top-[calc(env(safe-area-inset-top)+58px)] z-17 rounded-2xl bg-emerald-950/75 p-1.5 ring-1 ring-white/10 backdrop-blur-md">
      <div className="grid grid-cols-5 gap-1">
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={cn(
                "rounded-xl px-2 py-2 text-[12px] font-semibold transition active:scale-[0.98]",
                active
                  ? "bg-gradient-to-b from-amber-300 to-amber-500 text-neutral-900"
                  : "text-emerald-100/85 hover:bg-white/5"
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function HighlightCard({ label, value, detail }) {
  return (
    <section className="rounded-2xl bg-emerald-950/55 p-4 ring-1 ring-emerald-200/10">
      <div className="text-[11px] uppercase tracking-[0.12em] text-amber-300/75">{label}</div>
      <div className="mt-1 text-2xl font-bold text-amber-200">{value}</div>
      <div className="mt-1 text-xs text-emerald-200/70">{detail}</div>
    </section>
  );
}

export function SimpleListCard({ title, children }) {
  return (
    <section className="rounded-2xl bg-emerald-950/50 p-4 ring-1 ring-white/10">
      <h3 className="text-lg font-semibold text-emerald-50">{title}</h3>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

export function PrizeSummary({ computed, money }) {
  return (
    <section className="rounded-2xl bg-emerald-950/55 p-4 ring-1 ring-white/10">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-emerald-50">Prize Summary</h3>
        <span className={computed.prizeEnabled ? "text-sm text-emerald-300" : "text-sm text-emerald-200/60"}>
          {computed.prizeEnabled ? "Active" : "Off"}
        </span>
      </div>
      {computed.prizeEnabled ? (
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-emerald-200/65">Deduction</div>
            <div className="text-emerald-50">-{money(computed.prizePerPlayer)} each</div>
          </div>
          <div>
            <div className="text-emerald-200/65">Prize Pool</div>
            <div className="text-emerald-50">{money(computed.prizePool)}</div>
          </div>
          <div className="col-span-2">
            <div className="text-emerald-200/65">Winner(s)</div>
            <div className="text-emerald-50">
              {computed.winnerNames.length ? computed.winnerNames.join(", ") : "-"}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-emerald-200/65">
          Enable prize to deduct from all players and reward winner(s).
        </p>
      )}
    </section>
  );
}

export function BalanceStatus({ difference, money }) {
  const unbalanced = Math.abs(difference) > 0.01;
  return (
    <section
      className={cn(
        "rounded-2xl p-3.5 text-sm ring-1",
        unbalanced
          ? "bg-red-900/25 text-red-200 ring-red-300/25"
          : "bg-emerald-900/35 text-emerald-200 ring-emerald-300/25"
      )}
    >
      <div className="font-semibold">
        {unbalanced ? "Session not balanced" : "Session balanced"}
      </div>
      <div className="mt-1">
        {unbalanced
          ? `Difference is ${money(difference)}. Adjust cash-outs before saving.`
          : "All totals match. Ready to end and save session."}
      </div>
    </section>
  );
}

export function BottomStickyAction({ onSave, disabled = false }) {
  return (
    <div className="sticky bottom-2 z-20 mt-3 rounded-2xl bg-emerald-950/85 p-2.5 ring-1 ring-white/10 backdrop-blur-md">
      <button
        type="button"
        onClick={onSave}
        disabled={disabled}
        className={cn(
          "w-full rounded-xl px-4 py-3 text-base font-bold transition duration-150 ease-out active:scale-[0.99]",
          disabled
            ? "cursor-not-allowed bg-amber-200/30 text-amber-100/70"
            : "bg-gradient-to-b from-amber-400/80 to-amber-600/80 text-amber-950 cta-ready-glow"
        )}
      >
        End & Save Session
      </button>
    </div>
  );
}

// Backward compatibility exports while App is being refactored.
export const StatsCard = StatsHero;
export const StatusBar = SyncStatusInline;
export const NavTabs = PrimaryNavTabs;
