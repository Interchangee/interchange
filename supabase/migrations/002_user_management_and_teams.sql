-- ============================================================
-- 002_user_management_and_teams.sql
-- Adds teams, hierarchical RLS, and custom JWT claims
-- ============================================================

-- 1. Teams table
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  gamemaster_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now()
);

-- Teams are unique per gamemaster
create unique index teams_gamemaster_name_idx
  on public.teams (lower(name), gamemaster_id);

-- 2. Link players to a team
alter table public.profiles
  add column team_id uuid references public.teams(id) on delete set null;

-- 3. Custom access token hook to embed role & gamemaster_id in JWT
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  user_role text;
  gm_id uuid;
begin
  -- Fetch role and gamemaster_id for the user
  select role, gamemaster_id
    into user_role, gm_id
    from public.profiles
   where id = (event->>'user_id')::uuid;

  claims := event->'claims';

  if user_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
  else
    claims := jsonb_set(claims, '{user_role}', 'null');
  end if;

  if gm_id is not null then
    claims := jsonb_set(claims, '{gamemaster_id}', to_jsonb(gm_id));
  else
    claims := jsonb_set(claims, '{gamemaster_id}', 'null');
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;

-- 4. Helper functions for RLS
create or replace function public.current_user_role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'user_role', '');
$$;

create or replace function public.current_user_gamemaster_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'gamemaster_id', '')::uuid;
$$;

-- 5. Enable RLS on profiles and teams
alter table public.profiles enable row level security;
alter table public.teams enable row level security;

-- 6. Policies for profiles -------------------------------------------------

-- SELECT: hierarchical visibility
drop policy if exists "Profiles are viewable by everyone" on public.profiles;

create policy "Admins can view all profiles"
  on public.profiles for select
  using (public.current_user_role() = 'admin');

create policy "Managers can view all profiles"
  on public.profiles for select
  using (public.current_user_role() = 'manager');

create policy "Gamemasters can view players in their game and themselves"
  on public.profiles for select
  using (
    public.current_user_role() = 'gamemaster'
    and (
      id = auth.uid()  -- can see own profile
      or gamemaster_id = auth.uid()  -- players under this gamemaster
    )
  );

create policy "Players can view players in their game"
  on public.profiles for select
  using (
    public.current_user_role() = 'player'
    and gamemaster_id = public.current_user_gamemaster_id()
  );

-- INSERT / UPDATE / DELETE: hierarchical manipulation

-- Admin: full access
create policy "Admins can insert profiles"
  on public.profiles for insert
  with check (public.current_user_role() = 'admin');

create policy "Admins can update profiles"
  on public.profiles for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create policy "Admins can delete profiles"
  on public.profiles for delete
  using (public.current_user_role() = 'admin');

-- Manager: can manage gamemasters and players (not other admins/managers)
create policy "Managers can insert gamemasters and players"
  on public.profiles for insert
  with check (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  );

create policy "Managers can update gamemasters and players"
  on public.profiles for update
  using (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  )
  with check (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  );

create policy "Managers can delete gamemasters and players"
  on public.profiles for delete
  using (
    public.current_user_role() = 'manager'
    and role in ('gamemaster', 'player')
  );

-- Gamemaster: can only manage players in their own game
create policy "Gamemasters can insert players in their game"
  on public.profiles for insert
  with check (
    public.current_user_role() = 'gamemaster'
    and role = 'player'
    and gamemaster_id = auth.uid()
  );

create policy "Gamemasters can update players in their game"
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

create policy "Gamemasters can delete players in their game"
  on public.profiles for delete
  using (
    public.current_user_role() = 'gamemaster'
    and role = 'player'
    and gamemaster_id = auth.uid()
  );

-- Players have no insert/update/delete rights on profiles (read-only)

-- 7. Policies for teams ----------------------------------------------------

-- SELECT: same visibility as players (admins/managers see all, gamemasters see their teams, players see teams in their game)
create policy "Admins can view all teams"
  on public.teams for select
  using (public.current_user_role() = 'admin');

create policy "Managers can view all teams"
  on public.teams for select
  using (public.current_user_role() = 'manager');

create policy "Gamemasters can view their own teams"
  on public.teams for select
  using (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

create policy "Players can view teams in their game"
  on public.teams for select
  using (
    public.current_user_role() = 'player'
    and gamemaster_id = public.current_user_gamemaster_id()
  );

-- INSERT / UPDATE / DELETE: anyone who can manipulate players can manipulate teams

create policy "Admins can insert teams"
  on public.teams for insert
  with check (public.current_user_role() = 'admin');

create policy "Admins can update teams"
  on public.teams for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create policy "Admins can delete teams"
  on public.teams for delete
  using (public.current_user_role() = 'admin');

create policy "Managers can insert teams"
  on public.teams for insert
  with check (public.current_user_role() = 'manager');

create policy "Managers can update teams"
  on public.teams for update
  using (public.current_user_role() = 'manager')
  with check (public.current_user_role() = 'manager');

create policy "Managers can delete teams"
  on public.teams for delete
  using (public.current_user_role() = 'manager');

create policy "Gamemasters can insert teams in their game"
  on public.teams for insert
  with check (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

create policy "Gamemasters can update teams in their game"
  on public.teams for update
  using (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  )
  with check (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

create policy "Gamemasters can delete teams in their game"
  on public.teams for delete
  using (
    public.current_user_role() = 'gamemaster'
    and gamemaster_id = auth.uid()
  );

-- Players cannot modify teams