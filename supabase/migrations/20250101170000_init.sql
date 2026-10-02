-- ============================================================================
--  Interchange / Interchange - full Supabase schema
--  Paste this whole file into Supabase Studio -> SQL Editor -> Run.
--  It is idempotent-ish: safe to run once on a fresh project.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ============================================================================
-- 1. ENUMS
-- ============================================================================
do $$ begin
  create type user_role as enum ('admin','manager','gamemaster','player');
exception when duplicate_object then null; end $$;

do $$ begin
  create type membership_status as enum ('invited','active','suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type vehicle_source as enum ('realtime','schedule','manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type match_confidence as enum ('realtime','high','medium','low','manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type confidence_level as enum ('high','medium','low');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- 2. CORE TABLES
-- ============================================================================

-- One row per auth user. Holds the in-game identity + role.
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             citext,
  username          citext not null unique,
  display_name      text,
  role              user_role not null default 'player',
  status            membership_status not null default 'active',
  color             text,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_seen_at      timestamptz
);

create index if not exists profiles_role_idx on public.profiles(role);

-- Plain-text credentials so an admin can always re-hand a login to a player.
-- Locked to admin/manager only by RLS. (Passwords are ALSO hashed by GoTrue.)
create table if not exists public.auth_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references public.profiles(id) on delete cascade,
  username      citext not null unique,
  fake_email    citext not null unique,
  password      text not null,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Which gamemaster a player reports to (a player can serve several games).
create table if not exists public.gamemaster_players (
  gamemaster_id uuid not null references public.profiles(id) on delete cascade,
  player_id     uuid not null references public.profiles(id) on delete cascade,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  primary key (gamemaster_id, player_id)
);

create table if not exists public.games (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique,
  name                  text not null,
  description           text,
  gamemaster_id         uuid not null references public.profiles(id) on delete cascade,
  starts_at             timestamptz,
  ends_at               timestamptz,
  status                text not null default 'active',      -- draft|active|paused|ended
  -- game rules live here so the SAME tracker can drive many different games
  points_config         jsonb not null default '{
    "points_per_stop": 10,
    "points_per_transfer": 5,
    "points_per_km": 1,
    "points_per_new_route": 25,
    "points_per_new_station": 15,
    "points_per_minute": 0,
    "points_per_visit": 0,
    "bonus_rules": []
  }'::jsonb,
  tracking_config       jsonb not null default '{
    "sample_seconds": 20,
    "min_distance_m": 15,
    "accuracy_max_m": 120,
    "live_tracking": true,
    "keep_history_hours": 168
  }'::jsonb,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index if not exists games_gamemaster_idx on public.games(gamemaster_id);

-- Everyone (staff + players) attached to a game.
create table if not exists public.game_members (
  game_id    uuid not null references public.games(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_in_game user_role not null default 'player',
  is_player  boolean not null default false,
  joined_at  timestamptz not null default now(),
  primary key (game_id, profile_id)
);

-- Teams are always scoped to one game.
create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (game_id, name)
);

create table if not exists public.team_members (
  team_id    uuid not null references public.teams(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (team_id, profile_id)
);

-- ============================================================================
-- 3. TRANSIT REFERENCE DATA (cached from free GTFS feeds)
-- ============================================================================

create table if not exists public.transit_agencies (
  id            uuid primary key default gen_random_uuid(),
  agency_key    text not null unique,          -- e.g. 'my-city'
  name          text not null,
  timezone      text not null default 'UTC',
  -- static GTFS zip, usually https://.../google_transit.zip
  static_gtfs_url text,
  -- optional GTFS-Realtime feeds (vehicle positions etc.)
  rt_vehicle_positions_url text,
  rt_trip_updates_url      text,
  rt_trips_url             text,
  rt_headers    jsonb not null default '{}'::jsonb,
  -- which providers may use this feed (bbox or agency id); null = anyone
  country_codes text[],
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now()
);

-- Thin local cache of GTFS departures. Mostly a convenience for small games;
-- the full feed is parsed in the browser and kept in IndexedDB.
create table if not exists public.gtfs_departures (
  id            bigserial primary key,
  agency_id     uuid not null references public.transit_agencies(id) on delete cascade,
  service_date  date not null,
  stop_id       text not null,
  stop_name     text,
  route_id      text not null,
  route_short_name text,
  route_long_name  text,
  route_mode    text,
  trip_id       text not null,
  trip_headsign text,
  direction_id  smallint,
  departure_time time not null,
  lat           double precision,
  lon           double precision,
  created_at    timestamptz not null default now()
);

create index if not exists gtfs_dep_stop_idx on public.gtfs_departures(stop_id, departure_time);
create index if not exists gtfs_dep_day_idx  on public.gtfs_departures(service_date);

-- ============================================================================
-- 4. TRACKING
-- ============================================================================

-- A riding session: "player X says they are on vehicle Y from A to B".
create table if not exists public.vehicles (
  id             uuid primary key default gen_random_uuid(),
  agency_id      uuid references public.transit_agencies(id) on delete set null,
  game_id        uuid references public.games(id) on delete cascade,
  source         vehicle_source not null default 'schedule',
  route_id       text,
  route_short_name text,
  route_long_name  text,
  route_mode     text,
  route_color    text,
  headsign       text,
  direction_id   smallint,
  trip_id        text,
  vehicle_id     text,
  label          text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  created_by     uuid references public.profiles(id) on delete set null
);

create index if not exists vehicles_game_idx on public.vehicles(game_id);

create table if not exists public.boardings (
  id                 uuid primary key default gen_random_uuid(),
  game_id            uuid not null references public.games(id) on delete cascade,
  player_id          uuid not null references public.profiles(id) on delete cascade,
  vehicle_id         uuid references public.vehicles(id) on delete set null,
  team_id            uuid references public.teams(id) on delete set null,
  status             text not null default 'riding',   -- riding|completed|cancelled
  source             vehicle_source not null default 'schedule',
  confidence         match_confidence not null default 'medium',
  -- boarding end
  board_lat          double precision,
  board_lon          double precision,
  board_accuracy_m   double precision,
  board_at           timestamptz not null default now(),
  board_stop_id      text,
  board_stop_name    text,
  -- alighting end (filled on exit)
  alight_lat         double precision,
  alight_lon         double precision,
  alight_accuracy_m  double precision,
  alight_at          timestamptz,
  alight_stop_id     text,
  alight_stop_name   text,
  stops_travelled    int,
  distance_m         double precision,
  -- what the app guessed, and what the player actually confirmed
  guess_payload      jsonb,
  confirmed_payload  jsonb,
  corrected          boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists boardings_player_idx on public.boardings(player_id, board_at desc);
create index if not exists boardings_game_idx   on public.boardings(game_id, board_at desc);
create index if not exists boardings_riding_idx on public.boardings(player_id) where status = 'riding';

-- Raw GPS breadcrumbs. Kept lean: the client batches inserts.
create table if not exists public.track_points (
  id           bigserial primary key,
  game_id      uuid not null references public.games(id) on delete cascade,
  player_id    uuid not null references public.profiles(id) on delete cascade,
  boarding_id  uuid references public.boardings(id) on delete cascade,
  recorded_at  timestamptz not null default now(),
  lat          double precision not null,
  lon          double precision not null,
  accuracy_m   double precision,
  speed_mps    double precision,
  heading_deg  double precision,
  battery      double precision,
  seq          int,
  source       text not null default 'gps'          -- gps|manual|simulated
);

create index if not exists track_points_boarding_idx on public.track_points(boarding_id, recorded_at);
create index if not exists track_points_player_idx   on public.track_points(player_id, recorded_at desc);

-- ============================================================================
-- 5. FLEXIBLE POINTS
-- ============================================================================

-- Per-game definition of how points are earned. Games can define anything.
create table if not exists public.point_events (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games(id) on delete cascade,
  code        text not null,                        -- 'station_visit', 'route_first', ...
  label       text not null,
  points      numeric not null default 0,
  category    text not null default 'custom',
  unique_once boolean not null default false,       -- award at most once per player
  active      boolean not null default true,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (game_id, code)
);

create table if not exists public.points_events (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  player_id    uuid not null references public.profiles(id) on delete cascade,
  team_id      uuid references public.teams(id) on delete set null,
  boarding_id  uuid references public.boardings(id) on delete set null,
  point_event_id uuid references public.point_events(id) on delete set null,
  kind         text not null,
  reason       text,
  points       numeric not null default 0,
  lat          double precision,
  lon          double precision,
  awarded_by   uuid references public.profiles(id) on delete set null,
  auto         boolean not null default true,
  dedupe_key   text unique,
  created_at   timestamptz not null default now()
);

create index if not exists points_events_game_idx   on public.points_events(game_id, created_at desc);
create index if not exists points_events_player_idx on public.points_events(player_id, created_at desc);
create index if not exists points_events_board_idx  on public.points_events(boarding_id);

-- ============================================================================
-- 6. HELPER FUNCTIONS (security definer => no RLS recursion)
-- ============================================================================

create or replace function public.current_role_of()
returns user_role
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'player'::user_role);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role_of() = 'admin';
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role_of() = 'manager';
$$;

-- admin or manager: "staff that can see everything"
create or replace function public.is_overseer()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role_of() in ('admin','manager');
$$;

create or replace function public.is_game_staff(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_overseer()
      or exists (select 1 from public.games g where g.id = gid and g.gamemaster_id = auth.uid());
$$;

create or replace function public.is_game_member(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_game_staff(gid)
      or exists (select 1 from public.game_members m where m.game_id = gid and m.profile_id = auth.uid());
$$;

-- can the caller manage (create teams, see roster) a given team?
create or replace function public.can_manage_team(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.teams t
    where t.id = tid and public.is_game_staff(t.game_id)
  );
$$;

create or replace function public.shares_team_with(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.team_members a
    join public.team_members b on a.team_id = b.team_id
    where a.profile_id = auth.uid() and b.profile_id = other
  );
$$;

-- Role hierarchy for user creation.
--   admin      -> admin, manager, gamemaster, player
--   manager    -> gamemaster, player
--   gamemaster -> player only, and only into games they run
--   player     -> nothing
create or replace function public.can_create_role(target user_role)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.current_role_of()
    when 'admin'      then true
    when 'manager'    then target in ('gamemaster','player')
    when 'gamemaster' then target = 'player'
    else false
  end;
$$;

-- Which game may the caller put a new person into?
create or replace function public.can_assign_game(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_overseer()
      or exists (select 1 from public.games g where g.id = gid and g.gamemaster_id = auth.uid());
$$;

-- Games the caller is allowed to hand out in the "Create players" form.
create or replace function public.list_assignable_games()
returns table (id uuid, name text, gamemaster_id uuid, gamemaster_name citext)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.gamemaster_id, p.username
  from public.games g
  left join public.profiles p on p.id = g.gamemaster_id
  where public.is_overseer()
     or g.gamemaster_id = auth.uid()
     or exists (select 1 from public.game_members m where m.game_id = g.id and m.profile_id = auth.uid())
  order by g.name;
$$;

-- Games the caller belongs to (any role), with their role in that game.
create or replace function public.list_my_games()
returns table (id uuid, name text, status text, gamemaster_id uuid,
               gamemaster_name citext, my_role user_role, is_staff boolean,
               points_config jsonb, tracking_config jsonb)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.status, g.gamemaster_id, p.username,
         public.current_role_of(),
         public.is_game_staff(g.id),
         g.points_config, g.tracking_config
  from public.games g
  left join public.profiles p on p.id = g.gamemaster_id
  where public.is_game_member(g.id) or g.gamemaster_id = auth.uid()
  order by g.created_at desc;
$$;

-- Leaderboard without leaking every raw point row.
create or replace function public.game_leaderboard(gid uuid)
returns table (player_id uuid, username citext, display_name text, team text, points numeric, boardings bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name,
         (select t.name from public.team_members tm
            join public.teams t on t.id = tm.team_id
           where tm.profile_id = p.id and t.game_id = gid limit 1),
         coalesce((select sum(pe.points) from public.points_events pe
                    where pe.player_id = p.id and pe.game_id = gid), 0)::numeric,
         (select count(*) from public.boardings b
           where b.player_id = p.id and b.game_id = gid)
  from public.profiles p
  where public.is_game_member(gid)
    and (p.id = auth.uid()
         or exists (select 1 from public.game_members m2 where m2.game_id = gid and m2.profile_id = p.id))
  order by 5 desc, 2 asc;
$$;

-- Resolve a username -> the synthetic auth email, for sign-in.
create or replace function public.email_for_username(uname text)
returns text language sql stable security definer set search_path = public as $$
  select fake_email::text from public.auth_accounts where username = uname::citext limit 1;
$$;

-- Everything a staff member needs to hand a new player their login.
create or replace function public.player_credentials(player uuid)
returns table (username citext, password text, fake_email citext, role user_role, games text[])
language sql stable security definer set search_path = public as $$
  select p.username, a.password, a.fake_email, p.role,
         array(select g.name from public.game_members m join public.games g on g.id = m.game_id
                where m.profile_id = p.id)
  from public.profiles p
  left join public.auth_accounts a on a.user_id = p.id
  where p.id = player and (public.is_overseer() or p.created_by = auth.uid());
$$;

-- ============================================================================
-- 7. TRIGGERS
-- ============================================================================

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_boardings_touch on public.boardings;
create trigger trg_boardings_touch before update on public.boardings
  for each row execute function public.touch_updated_at();

-- Auto-create a profile whenever an auth user appears (signup is disabled, so
-- this only fires from the create-user edge function / service role).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname citext;
  r user_role;
begin
  uname := coalesce(
    nullif(new.raw_user_meta_data->>'username','')::citext,
    nullif(new.raw_user_meta_data->>'user_name','')::citext,
    split_part(new.email, '@', 1)::citext
  );
  r := coalesce((new.raw_user_meta_data->>'role')::user_role, 'player'::user_role);

  insert into public.profiles (id, email, username, display_name, role)
  values (new.id, new.email::citext, uname, new.raw_user_meta_data->>'display_name', r)
  on conflict (id) do update set email = excluded.email;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- 8. ROW LEVEL SECURITY
-- ============================================================================
alter table public.profiles           enable row level security;
alter table public.auth_accounts      enable row level security;
alter table public.gamemaster_players enable row level security;
alter table public.games              enable row level security;
alter table public.game_members       enable row level security;
alter table public.teams              enable row level security;
alter table public.team_members       enable row level security;
alter table public.transit_agencies   enable row level security;
alter table public.gtfs_departures    enable row level security;
alter table public.vehicles           enable row level security;
alter table public.boardings          enable row level security;
alter table public.track_points       enable row level security;
alter table public.point_events       enable row level security;
alter table public.points_events      enable row level security;

-- ---- profiles -------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
using (
  id = auth.uid()
  or public.is_overseer()
  or exists (select 1 from public.gamemaster_players gp
              where gp.gamemaster_id = auth.uid() and gp.player_id = profiles.id)
  or exists (select 1 from public.game_members m
              where m.profile_id = profiles.id and public.is_game_staff(m.game_id))
  or public.shares_team_with(profiles.id)
);

-- People may edit their own cosmetic fields; the trigger below blocks the rest.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- Staff may edit the players who belong to them.
drop policy if exists profiles_staff_update on public.profiles;
create policy profiles_staff_update on public.profiles for update to authenticated
using (
  public.is_overseer()
  or exists (select 1 from public.gamemaster_players gp
              where gp.gamemaster_id = auth.uid() and gp.player_id = profiles.id)
)
with check (
  public.is_overseer()
  or exists (select 1 from public.gamemaster_players gp
              where gp.gamemaster_id = auth.uid() and gp.player_id = profiles.id)
);

-- Nobody may escalate a role, and nobody may rewrite their own identity fields.
-- Statements with no session at all (the SQL Editor, migrations, service_role)
-- are allowed through: an API client always carries a JWT, so auth.uid() is
-- never null for one. Without that exemption the first-admin bootstrap would
-- be blocked by the guard itself. See 20250101180000_fix_role_guard_bootstrap.sql.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  via_admin_path boolean := auth.uid() is null;
begin
  if new.role is distinct from old.role
     and not via_admin_path
     and not public.is_admin() then
    raise exception 'only an admin can change a role';
  end if;

  if new.username is distinct from old.username
     and not via_admin_path
     and not public.is_overseer() then
    raise exception 'only admins and managers can rename an account';
  end if;

  if new.created_by is distinct from old.created_by
     and not via_admin_path
     and not public.is_admin() then
    raise exception 'created_by is immutable';
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---- auth_accounts --------------------------------------------------------
drop policy if exists auth_accounts_select on public.auth_accounts;
create policy auth_accounts_select on public.auth_accounts for select to authenticated
using (public.is_overseer() or user_id = auth.uid() or created_by = auth.uid());

drop policy if exists auth_accounts_write on public.auth_accounts;
create policy auth_accounts_write on public.auth_accounts for all to authenticated
using (public.is_overseer()) with check (public.is_overseer());

-- ---- gamemaster_players ---------------------------------------------------
drop policy if exists gm_players_select on public.gamemaster_players;
create policy gm_players_select on public.gamemaster_players for select to authenticated
using (gamemaster_id = auth.uid() or player_id = auth.uid() or public.is_overseer());

drop policy if exists gm_players_write on public.gamemaster_players;
create policy gm_players_write on public.gamemaster_players for all to authenticated
using (gamemaster_id = auth.uid() or public.is_overseer())
with check (gamemaster_id = auth.uid() or public.is_overseer());

-- ---- games ----------------------------------------------------------------
drop policy if exists games_select on public.games;
create policy games_select on public.games for select to authenticated
using (public.is_game_member(id) or gamemaster_id = auth.uid());

drop policy if exists games_insert on public.games;
create policy games_insert on public.games for insert to authenticated
with check (
  public.is_overseer()
  or (public.current_role_of() = 'gamemaster' and gamemaster_id = auth.uid())
);

drop policy if exists games_update on public.games;
create policy games_update on public.games for update to authenticated
using (public.is_game_staff(id)) with check (public.is_game_staff(id));

drop policy if exists games_delete on public.games;
create policy games_delete on public.games for delete to authenticated
using (public.is_overseer() or gamemaster_id = auth.uid());

-- ---- game_members ---------------------------------------------------------
drop policy if exists game_members_select on public.game_members;
create policy game_members_select on public.game_members for select to authenticated
using (profile_id = auth.uid() or public.is_game_staff(game_id));

drop policy if exists game_members_write on public.game_members;
create policy game_members_write on public.game_members for all to authenticated
using (public.is_game_staff(game_id)) with check (public.is_game_staff(game_id));

-- ---- teams ----------------------------------------------------------------
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated
using (public.is_game_member(game_id));

drop policy if exists teams_insert on public.teams;
create policy teams_insert on public.teams for insert to authenticated
with check (public.is_game_staff(game_id));

drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams for update to authenticated
using (public.is_game_staff(game_id)) with check (public.is_game_staff(game_id));

drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams for delete to authenticated
using (public.is_game_staff(game_id));

-- ---- team_members ---------------------------------------------------------
drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members for select to authenticated
using (profile_id = auth.uid() or public.can_manage_team(team_id) or public.shares_team_with(profile_id));

drop policy if exists team_members_write on public.team_members;
create policy team_members_write on public.team_members for all to authenticated
using (public.can_manage_team(team_id)) with check (public.can_manage_team(team_id));

-- ---- transit_agencies -----------------------------------------------------
drop policy if exists agencies_select on public.transit_agencies;
create policy agencies_select on public.transit_agencies for select to authenticated using (true);

drop policy if exists agencies_write on public.transit_agencies;
create policy agencies_write on public.transit_agencies for all to authenticated
using (public.is_overseer()) with check (public.is_overseer());

-- ---- gtfs_departures ------------------------------------------------------
drop policy if exists gtfs_dep_select on public.gtfs_departures;
create policy gtfs_dep_select on public.gtfs_departures for select to authenticated using (true);

drop policy if exists gtfs_dep_write on public.gtfs_departures;
create policy gtfs_dep_write on public.gtfs_departures for all to authenticated
using (public.is_overseer()) with check (public.is_overseer());

-- ---- vehicles -------------------------------------------------------------
drop policy if exists vehicles_select on public.vehicles;
create policy vehicles_select on public.vehicles for select to authenticated
using (game_id is null or public.is_game_member(game_id));

drop policy if exists vehicles_insert on public.vehicles;
create policy vehicles_insert on public.vehicles for insert to authenticated
with check (game_id is null or public.is_game_member(game_id));

drop policy if exists vehicles_update on public.vehicles;
create policy vehicles_update on public.vehicles for update to authenticated
using (game_id is null or public.is_game_member(game_id))
with check (true);

-- ---- boardings ------------------------------------------------------------
drop policy if exists boardings_select on public.boardings;
create policy boardings_select on public.boardings for select to authenticated
using (
  player_id = auth.uid()
  or public.is_game_staff(game_id)
  or (public.shares_team_with(player_id) and coalesce(
        (select (g.tracking_config->>'live_tracking')::boolean from public.games g where g.id = game_id), false))
);

drop policy if exists boardings_insert on public.boardings;
create policy boardings_insert on public.boardings for insert to authenticated
with check (player_id = auth.uid() or public.is_game_staff(game_id));

drop policy if exists boardings_update on public.boardings;
create policy boardings_update on public.boardings for update to authenticated
using (player_id = auth.uid() or public.is_game_staff(game_id))
with check (player_id = auth.uid() or public.is_game_staff(game_id));

drop policy if exists boardings_delete on public.boardings;
create policy boardings_delete on public.boardings for delete to authenticated
using (player_id = auth.uid() or public.is_game_staff(game_id));

-- ---- track_points ---------------------------------------------------------
drop policy if exists track_points_select on public.track_points;
create policy track_points_select on public.track_points for select to authenticated
using (
  player_id = auth.uid()
  or public.is_game_staff(game_id)
  or (public.shares_team_with(player_id) and coalesce(
        (select (g.tracking_config->>'live_tracking')::boolean from public.games g where g.id = game_id), false))
);

drop policy if exists track_points_insert on public.track_points;
create policy track_points_insert on public.track_points for insert to authenticated
with check (player_id = auth.uid() or public.is_game_staff(game_id));

-- ---- point_events (per-game rule definitions) -----------------------------
drop policy if exists point_events_select on public.point_events;
create policy point_events_select on public.point_events for select to authenticated
using (public.is_game_member(game_id));

drop policy if exists point_events_write on public.point_events;
create policy point_events_write on public.point_events for all to authenticated
using (public.is_game_staff(game_id)) with check (public.is_game_staff(game_id));

-- ---- points_events (the ledger) -------------------------------------------
drop policy if exists points_events_select on public.points_events;
create policy points_events_select on public.points_events for select to authenticated
using (
  player_id = auth.uid()
  or public.is_game_staff(game_id)
  or public.shares_team_with(player_id)
);

drop policy if exists points_events_insert on public.points_events;
create policy points_events_insert on public.points_events for insert to authenticated
with check (
  public.is_game_staff(game_id)
  or (player_id = auth.uid() and auto = true)
);

drop policy if exists points_events_write on public.points_events;
create policy points_events_write on public.points_events for update to authenticated
using (public.is_game_staff(game_id)) with check (public.is_game_staff(game_id));

drop policy if exists points_events_delete on public.points_events;
create policy points_events_delete on public.points_events for delete to authenticated
using (public.is_game_staff(game_id));

-- ============================================================================
-- 9. AUTOMATIC POINTS FROM A COMPLETED RIDE
-- ============================================================================
create or replace function public.award_ride_points(bid uuid)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  b record; cfg jsonb; per_stop numeric; per_km numeric;
  per_route numeric; per_station numeric; per_transfer numeric;
  km numeric; total numeric := 0; first_route boolean; first_station boolean;
begin
  select * into b from public.boardings where id = bid;
  if b is null then return 0; end if;
  if not (public.is_game_staff(b.game_id) or b.player_id = auth.uid()) then
    raise exception 'not allowed to award points for this ride';
  end if;

  select points_config into cfg from public.games where id = b.game_id;
  per_stop     := coalesce((cfg->>'points_per_stop')::numeric, 0);
  per_km       := coalesce((cfg->>'points_per_km')::numeric, 0);
  per_route    := coalesce((cfg->>'points_per_new_route')::numeric, 0);
  per_station  := coalesce((cfg->>'points_per_new_station')::numeric, 0);
  per_transfer := coalesce((cfg->>'points_per_transfer')::numeric, 0);

  km := coalesce(b.distance_m, 0) / 1000.0;

  if per_stop > 0 and coalesce(b.stops_travelled,0) > 0 then
    insert into public.points_events (game_id, player_id, boarding_id, kind, reason, points, auto, dedupe_key)
    values (b.game_id, b.player_id, b.id, 'ride_stops',
            coalesce(b.stops_travelled,0) || ' stops', per_stop * coalesce(b.stops_travelled,0), true,
            'stops:' || b.id)
    on conflict (dedupe_key) do nothing;
    total := total + per_stop * coalesce(b.stops_travelled,0);
  end if;

  if per_km > 0 and km > 0 then
    insert into public.points_events (game_id, player_id, boarding_id, kind, reason, points, auto, dedupe_key)
    values (b.game_id, b.player_id, b.id, 'ride_distance',
            round(km::numeric,2) || ' km', round(km * per_km), true, 'km:' || b.id)
    on conflict (dedupe_key) do nothing;
    total := total + round(km * per_km);
  end if;

  -- first time this player rides this route
  if per_route > 0 and b.vehicle_id is not null then
    first_route := not exists (
      select 1 from public.boardings b2
      where b2.player_id = b.player_id and b2.id <> b.id and b2.vehicle_id = b.vehicle_id
        and b2.status <> 'cancelled');
    if first_route then
      insert into public.points_events (game_id, player_id, boarding_id, kind, reason, points, auto, dedupe_key)
      values (b.game_id, b.player_id, b.id, 'new_route', 'new route', per_route, true, 'route:' || b.player_id || ':' || b.vehicle_id)
      on conflict (dedupe_key) do nothing;
      total := total + per_route;
    end if;
  end if;

  if per_station > 0 and b.alight_stop_id is not null then
    first_station := not exists (
      select 1 from public.boardings b3
      where b3.player_id = b.player_id and b3.id <> b.id and b3.alight_stop_id = b.alight_stop_id
        and b3.status <> 'cancelled');
    if first_station then
      insert into public.points_events (game_id, player_id, boarding_id, kind, reason, points, auto, dedupe_key)
      values (b.game_id, b.player_id, b.id, 'new_station', 'new station',
              per_station, true, 'station:' || b.player_id || ':' || b.alight_stop_id)
      on conflict (dedupe_key) do nothing;
      total := total + per_station;
    end if;
  end if;

  if per_transfer > 0 then
    insert into public.points_events (game_id, player_id, boarding_id, kind, reason, points, auto, dedupe_key)
    values (b.game_id, b.player_id, b.id, 'completed_ride', 'completed ride', per_transfer, true, 'ride:' || b.id)
    on conflict (dedupe_key) do nothing;
    total := total + per_transfer;
  end if;

  return total;
end $$;

-- ============================================================================
-- 10. PURGE OLD GPS BREADCRUMBS (bandwidth + storage hygiene)
-- ============================================================================
create or replace function public.purge_old_track_points()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.track_points tp
  using public.games g
  where tp.game_id = g.id
    and tp.recorded_at < now() - make_interval(hours => coalesce((g.tracking_config->>'keep_history_hours')::int, 168));
  get diagnostics n = row_count;
  return n;
end $$;

-- ============================================================================
-- 11. FIRST-RUN BOOTSTRAP
--
--   Because the schema is applied from git (Supabase GitHub integration or
--   `supabase db push`), there is no admin yet and only the project owner
--   could create one by hand. These two functions make the first account
--   claimable from inside the app, and only while the project is empty.
-- ============================================================================

-- True while nobody is an admin yet. Drives the "claim admin" prompt.
create or replace function public.admin_exists()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where role = 'admin');
$$;

-- Promote the calling account to admin - allowed exactly once, only when no
-- admin exists yet and no other profile exists either. Whoever signs in first
-- on a fresh project becomes the owner of the game.
create or replace function public.claim_first_admin()
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  admins int;
  others int;
  me record;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not signed in');
  end if;

  select count(*) into admins from public.profiles where role = 'admin';
  if admins > 0 then
    return jsonb_build_object('ok', false, 'reason', 'an admin already exists');
  end if;

  select count(*) into others from public.profiles where id <> auth.uid();
  if others > 0 then
    return jsonb_build_object('ok', false, 'reason', 'this project already has accounts');
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    insert into public.profiles (id, email, username, display_name, role, status)
    select u.id, u.email::citext,
           coalesce(nullif(u.raw_user_meta_data->>'username','')::citext, split_part(u.email, '@', 1)::citext),
           coalesce(u.raw_user_meta_data->>'display_name', 'Game Control'),
           'admin', 'active'
      from auth.users u where u.id = auth.uid();
  else
    update public.profiles set role = 'admin', status = 'active' where id = auth.uid();
  end if;

  select username into me from public.profiles where id = auth.uid();
  return jsonb_build_object('ok', true, 'username', me.username);
end $$;

-- ============================================================================
-- 12. SEED: a starter agency + starter point rules (optional, harmless)
-- ============================================================================
insert into public.transit_agencies (agency_key, name, timezone, static_gtfs_url, notes)
values ('example-city', 'Example City Transit', 'UTC', null,
        'Edit this row: paste your city free GTFS zip url and optional GTFS-Realtime urls.')
on conflict (agency_key) do nothing;

-- ============================================================================
-- Done. Next:
--   1. push this repository (the GitHub integration applies this migration and
--      deploys supabase/functions/create-user automatically), or run
--      `supabase db push && supabase functions deploy create-user`
--   2. open the web app, paste the project URL + anon key on the setup screen
--   3. sign in with the account you created in Authentication -> Users
--      and tap "Make me the admin" - that works exactly once
-- ============================================================================
