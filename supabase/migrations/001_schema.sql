/*
 * FILE: supabase/migrations/001_schema.sql
 * 
 * FILE TREE:
 * interchange/
 * ├── supabase/
 * │   ├── migrations/
 * │   │   └── 001_schema.sql  <-- YOU ARE HERE
 * │   └── functions/
 * │       ├── _shared/
 * │       └── poll-gtfs-rt/
 */

-- Enable PostGIS
create extension if not exists postgis with schema extensions;

-- Core Tables
create table public.games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rules_json jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table public.players (
  id text primary key, -- For prototype, we use text. In prod, reference auth.users
  game_id uuid references public.games(id) on delete cascade,
  display_name text,
  created_at timestamptz default now()
);

-- Realtime State
create table public.trip_realtime_state (
  trip_id text primary key,
  delay_seconds int,
  cancelled boolean default false,
  skipped_stop_ids text[] default '{}',
  next_stop_id text,
  observed_at timestamptz default now()
);

-- Insert Mock Data for Prototype
insert into public.games (id, name) values ('test-game-123', 'Swiss Transit Challenge');
insert into public.players (id, game_id, display_name) values ('test-player-123', 'test-game-123', 'Prototype Player');