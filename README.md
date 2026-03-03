# Classmates

Classmates is a shared poker session tracker:

- signup/login required
- everyone is admin
- live shared session board
- +/- buy-in controls
- customizable buy-in mapping (cash to chip stack)
- debts + payment tracking
- session history

## Run locally

```bash
npm install
npm run dev
```

## Database (Supabase)

By default, the app still works in local mode (`localStorage`).

To enable shared database sync:

1. Create a Supabase project.
2. Run SQL from `supabase/schema.sql` in Supabase SQL editor.
3. Create `.env.local`:

```bash
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

4. Restart dev server: `npm run dev`

In app `Settings > Database`, status should show `connected`.

Important for multi-device sync:

- every device must use the same `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
- when database is configured, cloud state is treated as the source of truth on startup

## Accounts

Auth is currently disabled in the web app.

- app opens directly without signup/login
- a local device user is auto-created for activity logs

## Backup

- manual backup/restore uses CSV
- auto backup is stored after every saved session (latest 20 kept)

## RLS note

If Settings shows a database row-level security error, run `supabase/schema.sql` again in Supabase SQL Editor.
