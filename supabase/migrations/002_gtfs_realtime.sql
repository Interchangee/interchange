create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ── Game scaffolding (skip if you already have games/teams/sessions) ──
create table if not exists public.games (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  rules_json  jsonb not null default '{}'::jsonb,
  status      text not null default 'draft',
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now()
);

create table if not exists public.teams (
  id       uuid primary key default gen_random_uuid(),
  game_id  uuid references public.games(id) on delete cascade,
  name     text not null
);

create table if not exists public.player_sessions (
  id                   uuid primary key default gen_random_uuid(),
  player_id            uuid not null references auth.users(id) on delete cascade,
  game_id              uuid not null references public.games(id) on delete cascade,
  team_id              uuid references public.teams(id),
  joined_at            timestamptz default now(),
  last_known_location  geography(Point,4326),
  last_location_at     timestamptz
);
create index if not exists idx_sessions_game on public.player_sessions(game_id);
create index if not exists idx_sessions_player on public.player_sessions(player_id);

-- ── GTFS static ──
create table if not exists public.gtfs_agencies (
  agency_id       text primary key,
  agency_name     text,
  agency_timezone text default 'Europe/Zurich',
  snapshot_id     uuid
);

create table if not exists public.gtfs_routes (
  route_id          text primary key,
  agency_id         text references public.gtfs_agencies(agency_id) on delete cascade,
  route_short_name  text,
  route_long_name   text,
  route_type        int
);

create table if not exists public.gtfs_stops (
  stop_id        text primary key,
  stop_name      text,
  stop_location  geography(Point,4326) not null
);
create index if not exists idx_stops_geo on public.gtfs_stops using gist (stop_location);

create table if not exists public.gtfs_trips (
  trip_id       text primary key,
  route_id      text references public.gtfs_routes(route_id) on delete cascade,
  service_id    text,
  trip_headsign text
);

create table if not exists public.gtfs_stop_times (
  trip_id         text references public.gtfs_trips(trip_id) on delete cascade,
  stop_sequence   int,
  stop_id         text references public.gtfs_stops(stop_id),
  arrival_time    time,
  departure_time  time,
  primary key (trip_id, stop_sequence)
);
create index if not exists idx_stoptimes_stop on public.gtfs_stop_times(stop_id);

-- ── GTFS realtime state ──
create table if not exists public.trip_realtime_state (
  trip_id           text primary key references public.gtfs_trips(trip_id) on delete cascade,
  delay_seconds     int,
  cancelled         boolean default false,
  skipped_stop_ids  text[] default '{}',
  next_stop_id      text references public.gtfs_stops(stop_id),
  observed_at       timestamptz not null default now()
);

create table if not exists public.service_alerts (
  id            text primary key,
  route_ids     text[] default '{}',
  stop_ids      text[] default '{}',
  effect        text,
  header        text,
  description   text,
  active_period tstzrange,
  observed_at   timestamptz default now()
);

-- ── Trip events ──
create table if not exists public.trip_events (
  id                       uuid primary key default gen_random_uuid(),
  player_session_id        uuid not null references public.player_sessions(id) on delete cascade,
  trip_id                  text,
  board_stop_id            text,
  declared_alight_stop_id  text,
  inferred_alight_stop_id  text,
  board_at                 timestamptz,
  alight_at                timestamptz,
  arrival_delay_seconds    int,
  cancellation_detected    boolean default false,
  confirmed_by_player      boolean default false,
  points_awarded           int default 0,
  metadata                 jsonb default '{}'::jsonb,
  created_at               timestamptz default now()
);
create index if not exists idx_events_active on public.trip_events(trip_id) where alight_at is null;
create index if not exists idx_events_session on public.trip_events(player_session_id, alight_at);

-- ── Scoring (append-only) ──
create table if not exists public.score_ledger (
  id                 bigserial primary key,
  player_session_id  uuid not null references public.player_sessions(id) on delete cascade,
  game_id            uuid not null references public.games(id) on delete cascade,
  event_type         text not null,
  points_delta       int not null,
  metadata_json      jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);
create index if not exists idx_ledger_game on public.score_ledger(game_id, player_session_id);

-- Leaderboard as a view (not matview, so no refresh dance)
create or replace view public.leaderboard as
  select game_id, player_session_id,
         sum(points_delta)::int as score,
         count(*)::int          as events
  from public.score_ledger
  group by game_id, player_session_id;

-- ── RPC: infer alight from last GPS (50 m) ──
create or replace function public.infer_alight_stop(p_session_id uuid)
returns table (stop_id text, stop_name text, distance_m float)
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_loc geography;
begin
  select player_id, last_known_location into v_owner, v_loc
    from public.player_sessions where id = p_session_id;
  if v_owner is null then raise exception 'session not found'; end if;
  if v_owner <> auth.uid() and auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if v_loc is null then return; end if;
  return query
    select s.stop_id, s.stop_name, ST_Distance(s.stop_location, v_loc)::float
      from public.gtfs_stops s
     where ST_DWithin(s.stop_location, v_loc, 50)
     order by s.stop_location <-> v_loc limit 1;
end $$;

-- ── RLS on the new tables only ──
alter table public.games               enable row level security;
alter table public.teams               enable row level security;
alter table public.player_sessions     enable row level security;
alter table public.gtfs_agencies       enable row level security;
alter table public.gtfs_routes         enable row level security;
alter table public.gtfs_stops          enable row level security;
alter table public.gtfs_trips          enable row level security;
alter table public.gtfs_stop_times     enable row level security;
alter table public.trip_realtime_state enable row level security;
alter table public.service_alerts      enable row level security;
alter table public.trip_events         enable row level security;
alter table public.score_ledger        enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'gtfs read') then
    create policy "gtfs read" on public.gtfs_agencies       for select to authenticated using (true);
    create policy "gtfs read" on public.gtfs_routes         for select to authenticated using (true);
    create policy "gtfs read" on public.gtfs_stops          for select to authenticated using (true);
    create policy "gtfs read" on public.gtfs_trips          for select to authenticated using (true);
    create policy "gtfs read" on public.gtfs_stop_times     for select to authenticated using (true);
    create policy "gtfs read" on public.trip_realtime_state for select to authenticated using (true);
    create policy "gtfs read" on public.service_alerts      for select to authenticated using (true);
  end if;
end $$;

create policy "games read" on public.games for select to authenticated using (status <> 'draft');

create policy "sessions read self" on public.player_sessions
  for select to authenticated using (player_id = auth.uid());
create policy "sessions insert self" on public.player_sessions
  for insert to authenticated with check (player_id = auth.uid());
create policy "sessions update self" on public.player_sessions
  for update to authenticated using (player_id = auth.uid());

create policy "events read self" on public.trip_events for select to authenticated using (
  exists (select 1 from public.player_sessions s
          where s.id = player_session_id and s.player_id = auth.uid()));
create policy "events insert self" on public.trip_events for insert to authenticated with check (
  exists (select 1 from public.player_sessions s
          where s.id = player_session_id and s.player_id = auth.uid()));
create policy "events update self" on public.trip_events for update to authenticated using (
  exists (select 1 from public.player_sessions s
          where s.id = player_session_id and s.player_id = auth.uid()));

create policy "ledger read game" on public.score_ledger for select to authenticated using (
  exists (select 1 from public.player_sessions s
          where s.game_id = score_ledger.game_id and s.player_id = auth.uid()));

-- ── Realtime publications ──
do $$ begin
  begin alter publication supabase_realtime add table public.trip_realtime_state; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.service_alerts;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.score_ledger;       exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.trip_events;        exception when duplicate_object then null; end;
end $$;