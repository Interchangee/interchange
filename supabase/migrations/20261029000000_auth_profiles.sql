-- Create profiles table
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  username text not null,
  role text not null check (role in ('admin', 'manager', 'gamemaster', 'player')),
  gamemaster_id uuid references public.profiles(id) on delete cascade,
  game_id uuid references public.games(id) on delete cascade,
  created_at timestamptz default now()
);

-- Uniqueness: Global for Admins, Managers, Gamemasters
create unique index profiles_global_username_idx 
  on public.profiles (lower(username)) 
  where role in ('admin', 'manager', 'gamemaster');

-- Uniqueness: Per-game for Players
create unique index profiles_player_username_idx 
  on public.profiles (lower(username), gamemaster_id) 
  where role = 'player';

-- RLS
alter table public.profiles enable row level security;

-- Everyone can read profiles
create policy "Profiles are viewable by everyone" 
  on public.profiles for select using (true);

-- Users can update their own non-role fields
create policy "Users can update own profile" 
  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- RPC to safely fetch a player's fake email for login
create or replace function get_player_email(p_gamemaster_name text, p_player_name text)
returns text as $$
declare
  v_gm_id uuid;
  v_email text;
begin
  select id into v_gm_id from public.profiles 
  where lower(username) = lower(p_gamemaster_name) and role = 'gamemaster';
  
  if v_gm_id is null then return null; end if;
  
  select email into v_email from public.profiles 
  where lower(username) = lower(p_player_name) and role = 'player' and gamemaster_id = v_gm_id;
  
  return v_email;
end;
$$ language plpgsql security definer;
