create table if not exists public.classmates_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.classmates_state enable row level security;

drop policy if exists "Allow read for anon" on public.classmates_state;
create policy "Allow read for anon"
on public.classmates_state
for select
to anon
using (true);

drop policy if exists "Allow insert for anon" on public.classmates_state;
create policy "Allow insert for anon"
on public.classmates_state
for insert
to anon
with check (true);

drop policy if exists "Allow update for anon" on public.classmates_state;
create policy "Allow update for anon"
on public.classmates_state
for update
to anon
using (true)
with check (true);

drop policy if exists "Allow read for authenticated" on public.classmates_state;
create policy "Allow read for authenticated"
on public.classmates_state
for select
to authenticated
using (true);

drop policy if exists "Allow insert for authenticated" on public.classmates_state;
create policy "Allow insert for authenticated"
on public.classmates_state
for insert
to authenticated
with check (true);

drop policy if exists "Allow update for authenticated" on public.classmates_state;
create policy "Allow update for authenticated"
on public.classmates_state
for update
to authenticated
using (true)
with check (true);
