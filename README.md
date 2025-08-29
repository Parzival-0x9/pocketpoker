# PocketPoker v7.5 — Phase 1 (Compact Mobile)

Compact phone-first tweak of Phase 1. Desktop unchanged; phones get tighter spacing and fewer columns.

## What changed (mobile only, ≤480px)
- Smaller base fonts and paddings
- Buttons/inputs reduced height
- Table **Actions** column hidden to fit small screens
- History totals **Diff** column hidden on smallest screens
- Details panels compressed

## Run locally
```bash
npm install
npm run dev
```

## Build
```bash
npm run build   # → dist/
```

## Deploy on Vercel
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
