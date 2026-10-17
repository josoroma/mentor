-- All learner data is owned by an authenticated identity, including anonymous auth users.
-- The browser uses the publishable/anon key; never expose a service-role key.
create table if not exists public.learning_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.scenario_configs (
  id text primary key,
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.learning_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  scenario_id text not null,
  started_at timestamptz not null,
  session jsonb not null check (jsonb_typeof(session) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists learning_sessions_user_started_idx
  on public.learning_sessions (user_id, started_at desc);

alter table public.learning_profiles enable row level security;
alter table public.learning_sessions enable row level security;
alter table public.scenario_configs enable row level security;

revoke all on public.learning_profiles from anon, authenticated;
revoke all on public.learning_sessions from anon, authenticated;
revoke all on public.scenario_configs from anon, authenticated;
grant select, insert, update, delete on public.learning_profiles to authenticated;
grant select, insert, update, delete on public.learning_sessions to authenticated;
grant select on public.scenario_configs to authenticated;

create policy "Learners read their own profile"
  on public.learning_profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Learners create their own profile"
  on public.learning_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Learners update their own profile"
  on public.learning_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Learners delete their own profile"
  on public.learning_profiles for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "Learners read their own sessions"
  on public.learning_sessions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Learners create their own sessions"
  on public.learning_sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Learners update their own sessions"
  on public.learning_sessions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Learners delete their own sessions"
  on public.learning_sessions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Scenario configuration is curated by a database administrator, never by a browser client.
create policy "Authenticated learners read curated scenarios"
  on public.scenario_configs for select to authenticated using (true);
