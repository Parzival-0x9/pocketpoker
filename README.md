# PocketPoker v7.5 — Phase 2 Verified

This bundle adds the sidebar/hamburger navigation and separates **History** and **Ledgers** into dedicated tabs.
We also changed the page title to **"PocketPoker • Phase 2"** and show a small "Phase 2" badge as a canary to confirm you're on the new build (remove later if you want).

## Apply
1. Unzip and copy everything into your working dir (replace files).
2. `npm install`
3. `npm run dev` (local test) or push to Vercel:
   ```bash
   git add -A
   git commit -m "Phase 2 verified: sidebar + tabs"
   git push origin main
   ```
4. On Vercel, Redeploy → Clear build cache.

## Remove the canary once confirmed
- Delete `<span className="badge phase">Phase 2</span>` in `App.jsx` (header)
- Remove `.phase-badge` and `.badge.phase` styles from `styles.css`
- Optionally set `<title>PocketPoker</title>` in `index.html`
