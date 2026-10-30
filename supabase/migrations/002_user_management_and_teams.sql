-- ============================================================
-- 002_user_management_and_teams.sql
-- ============================================================
-- Requires: 001 migration already created public.profiles with
--   id uuid pk, username text, email text, role text,
--   gamemaster_id uuid null references profiles(id)
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Teams table
-- ------------------------------------------------------------------
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  gamemaster_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists teams_gamemaster_name_idx
  on public.teams (lower(name), gamemaster_id);

-- ------------------------------------------------------------------
-- 2. Add team_id to profiles
-- ------------------------------------------------------------------
alter table public.profiles
  add column if not exists team_id uuid references public.teams(id) on delete set null;

create index if not exists profiles_team_id_idx on public.profiles (team_id);
create index if not exists profiles_gamemaster_id_idx on public.profiles (gamemaster_id);

-- ------------------------------------------------------------------
-- 3. Rework username uniqueness:
--    staff -> globally unique (case-insensitive)
--    players -> unique per gamemaster (case-insensitive)
-- ------------------------------------------------------------------
-- Drop any pre-existing global unique constraint/index on (username)
do $$
declare
  r record;
begin
  for r in (
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%(username)%'
  ) loop
    execute format('alter table public.profiles drop constraint %I', r.conname);
  end loop;

  for r in (
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename  = 'profiles'
      and indexdef ilike '%unique%'
      and indexdef ilike '%(username)%'
  ) loop
    execute format('drop index if exists public.%I', r.indexname);
  end loop;
end $$;

-- Global unique for staff
create unique index if not exists profiles_staff_username_unique
  on public.profiles (lower(username))
  where role in ('admin', 'manager', 'gamemaster');

-- Per-gamemaster unique for players
create unique index if not exists profiles_player_username_unique
  on public.profiles (lower(username), gamemaster_id)
  where role = 'player';

-- ------------------------------------------------------------------
-- 4. Helper functions (SECURITY DEFINER so no JWT hook is needed)
-- ------------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid() limit 1;
$$;

create or replace function public.current_user_gamemaster_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gamemaster_id from public.profiles where id = auth.uid() limit 1;
$$;

grant execute on function public.current_user_role()           to authenticated;
grant execute on function public.current_user_gamemaster_id()  to authenticated;

-- ------------------------------------------------------------------
-- 5. Enable RLS
-- ------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.teams     enable row level security;

-- ------------------------------------------------------------------
-- 6. Drop any old policies so this migration is idempotent
-- ------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in (
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
  ) loop
    execute format('drop policy if exists %I on public.profiles', r.policyname);
  end loop;
  for r in (
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'teams'
  ) loop
    execute format('drop policy if exists %I on public.teams', r.policyname);
  end loop;
end $$;

-- ------------------------------------------------------------------
-- 7. Profiles policies
-- ------------------------------------------------------------------
-- SELECT
create policy "profiles_select_admin"
  on public.profiles for select
  using (public.current_user_role() = 'admin');

create policy "profiles_select_manager"
  on public.profiles for select
  using (public.current_user_role() = 'manager');

create policy "profiles_select_gamemaster"
  on public.profiles for select
  using (
    public.current_user_role() = 'gamemaster'
    and (
      id = auth.uid()
      or gamemaster_id = auth.uid()
    )
  );

create policy "profiles_select_player"
  on public.profiles for select
  using (
    public.current_user_role() = 'player'
    and gamemaster_id = public.current_user_gamemaster_id()
  );

-- INSERT
create policy "profiles_insert_admin"
  on public.profiles for insert
  with check (public.current_user_role() = 'admin');

create policy "profiles_insert_manager"
  on public.profiles for insert
  with check (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  );

create policy "profiles_insert_gamemaster"
  on public.profiles for insert
  with check (
    public.current_user_role() = 'gamemaster'
    and role = 'player'
    and gamemaster_id = auth.uid()
  );

-- UPDATE
create policy "profiles_update_admin"
  on public.profiles for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create policy "profiles_update_manager"
  on public.profiles for update
  using (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  )
  with check (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  );

create policy "profiles_update_gamemaster"
  on public.profiles for update
  using (
    public.current_user_role() = 'gamemaster'
    and role = 'player'
    and gamemaster_id = auth.uid()
  )
  with check (
    public.current_user_role() = 'gamemaster'
    and role = 'player'
    and gamemaster_id = auth.uid()
  );

-- DELETE
create policy "profiles_delete_admin"
  on public.profiles for delete
  using (public.current_user_role() = 'admin');

create policy "profiles_delete_manager"
  on public.profiles for delete
  using (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  );

create policy "profiles_delete_gamemaster"
  on public.profiles for delete
  using (
    public.current_user_role() = 'gamemaster'
    and role = 'player'
    and gamemaster_id = auth.uid()
  );

-- ------------------------------------------------------------------
-- 8. Teams policies
-- ------------------------------------------------------------------
-- SELECT
create policy "teams_select_admin"
  on public.teams for select
  using (public.current_user_role() = 'admin');

create policy "teams_select_manager"
  on public.teams for select
  using (public.current_user_role() = 'manager');

create policy "teams_select_gamemaster"
  on public.teams for select
  using (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

create policy "teams_select_player"
  on public.teams for select
  using (
    public.current_user_role() = 'player'
    and gamemaster_id = public.current_user_gamemaster_id()
  );

-- INSERT
create policy "teams_insert_admin"
  on public.teams for insert
  with check (public.current_user_role() = 'admin');

create policy "teams_insert_manager"
  on public.teams for insert
  with check (public.current_user_role() = 'manager');

create policy "teams_insert_gamemaster"
  on public.teams for insert
  with check (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

-- UPDATE
create policy "teams_update_admin"
  on public.teams for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create policy "teams_update_manager"
  on public.teams for update
  using (public.current_user_role() = 'manager')
  with check (public.current_user_role() = 'manager');

create policy "teams_update_gamemaster"
  on public.teams for update
  using (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  )
  with check (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

-- DELETE
create policy "teams_delete_admin"
  on public.teams for delete
  using (public.current_user_role() = 'admin');

create policy "teams_delete_manager"
  on public.teams for delete
  using (public.current_user_role() = 'manager');

create policy "teams_delete_gamemaster"
  on public.teams for delete
  using (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );