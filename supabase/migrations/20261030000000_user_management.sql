-- supabase/migrations/20261030000000_user_management.sql
-- Adds role-based user management, teams, and name-based login RPCs.

-- 1. Role enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('admin', 'manager', 'gamemaster', 'player');
    END IF;
END$$;

-- 2. Extend profiles (assumes public.profiles already exists with `id` and `name`)
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'player',
    ADD COLUMN IF NOT EXISTS gamemaster_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL;

-- 3. Teams table
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    gamemaster_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (gamemaster_id, name)
);

-- 4. Unique constraints
-- Staff (admin, manager, gamemaster) must have globally unique names.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_staff_name_unique
    ON public.profiles (name)
    WHERE role IN ('admin', 'manager', 'gamemaster');

-- Players are unique only within their gamemaster.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_player_name_gm_unique
    ON public.profiles (name, gamemaster_id)
    WHERE role = 'player';

-- 5. RPC for staff login (name → email)
CREATE OR REPLACE FUNCTION public.get_staff_email(p_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT email FROM public.profiles
    WHERE name = p_name
      AND role IN ('admin', 'manager', 'gamemaster')
    LIMIT 1;
$$;

-- 6. RPC for player login (gamemaster name + player name → email)
CREATE OR REPLACE FUNCTION public.get_player_email(
    p_gamemaster_name text,
    p_player_name text
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT p.email
    FROM public.profiles p
    JOIN public.profiles gm ON p.gamemaster_id = gm.id
    WHERE gm.name = p_gamemaster_name
      AND p.name = p_player_name
      AND p.role = 'player'
      AND gm.role = 'gamemaster'
    LIMIT 1;
$$;

-- 7. Basic RLS (adjust as needed for production)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

-- Helper: current user's role
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS user_role
LANGUAGE sql
STABLE
AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

-- Profiles: admins and managers can read all; gamemasters can read their players; players can read players in their game.
CREATE POLICY "profiles_select_policy" ON public.profiles
    FOR SELECT
    USING (
        current_user_role() IN ('admin', 'manager')
        OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
        OR (current_user_role() = 'player' AND gamemaster_id = (SELECT gamemaster_id FROM public.profiles WHERE id = auth.uid()))
    );

-- Profiles: admins can insert/update/delete anything; managers can manage gamemasters and players; gamemasters can manage their own players.
CREATE POLICY "profiles_insert_policy" ON public.profiles
    FOR INSERT
    WITH CHECK (
        current_user_role() = 'admin'
        OR (current_user_role() = 'manager' AND role IN ('gamemaster', 'player'))
        OR (current_user_role() = 'gamemaster' AND role = 'player' AND gamemaster_id = auth.uid())
    );

CREATE POLICY "profiles_update_policy" ON public.profiles
    FOR UPDATE
    USING (
        current_user_role() = 'admin'
        OR (current_user_role() = 'manager' AND role IN ('gamemaster', 'player'))
        OR (current_user_role() = 'gamemaster' AND role = 'player' AND gamemaster_id = auth.uid())
    );

CREATE POLICY "profiles_delete_policy" ON public.profiles
    FOR DELETE
    USING (
        current_user_role() = 'admin'
        OR (current_user_role() = 'manager' AND role IN ('gamemaster', 'player'))
        OR (current_user_role() = 'gamemaster' AND role = 'player' AND gamemaster_id = auth.uid())
    );

-- Teams: read access follows the same rules as profiles; write access for admins, managers, and the owning gamemaster.
CREATE POLICY "teams_select_policy" ON public.teams
    FOR SELECT
    USING (
        current_user_role() IN ('admin', 'manager')
        OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
        OR (current_user_role() = 'player' AND gamemaster_id = (SELECT gamemaster_id FROM public.profiles WHERE id = auth.uid()))
    );

CREATE POLICY "teams_insert_policy" ON public.teams
    FOR INSERT
    WITH CHECK (
        current_user_role() = 'admin'
        OR (current_user_role() = 'manager')
        OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
    );

CREATE POLICY "teams_update_policy" ON public.teams
    FOR UPDATE
    USING (
        current_user_role() = 'admin'
        OR (current_user_role() = 'manager')
        OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
    );

CREATE POLICY "teams_delete_policy" ON public.teams
    FOR DELETE
    USING (
        current_user_role() = 'admin'
        OR (current_user_role() = 'manager')
        OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
    );