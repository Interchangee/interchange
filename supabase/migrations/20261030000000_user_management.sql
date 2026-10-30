-- supabase/migrations/20261030000000_user_management.sql

BEGIN;

-- 1. Create the Role Enum first
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE public.user_role AS ENUM ('admin', 'manager', 'gamemaster', 'player');
    END IF;
END$$;

-- 2. Create the profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    role public.user_role NOT NULL DEFAULT 'player',
    gamemaster_id UUID,
    team_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create the teams table
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    gamemaster_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (gamemaster_id, name)
);

-- 4. Add Foreign Keys to profiles safely
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_profiles_gamemaster') THEN
        ALTER TABLE public.profiles 
            ADD CONSTRAINT fk_profiles_gamemaster 
            FOREIGN KEY (gamemaster_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_profiles_team') THEN
        ALTER TABLE public.profiles 
            ADD CONSTRAINT fk_profiles_team 
            FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;
    END IF;
END$$;

-- 5. Trigger for auto-creating profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO public.profiles (id, email, name)
    VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.email))
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 6. Unique Constraints
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_staff_name_unique
    ON public.profiles (name) WHERE role IN ('admin', 'manager', 'gamemaster');

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_player_name_gm_unique
    ON public.profiles (name, gamemaster_id) WHERE role = 'player';

-- 7. RPC Functions for Login
CREATE OR REPLACE FUNCTION public.get_staff_email(p_name text)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
    SELECT email FROM public.profiles 
    WHERE name = p_name AND role IN ('admin', 'manager', 'gamemaster') LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_player_email(p_gamemaster_name text, p_player_name text)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
    SELECT p.email FROM public.profiles p
    JOIN public.profiles gm ON p.gamemaster_id = gm.id
    WHERE gm.name = p_gamemaster_name AND p.name = p_player_name AND p.role = 'player' AND gm.role = 'gamemaster' LIMIT 1;
$$;

-- 8. Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS public.user_role LANGUAGE sql STABLE AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

-- Drop policies if they exist (so the migration can be safely re-run)
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete_policy" ON public.profiles;
DROP POLICY IF EXISTS "teams_select_policy" ON public.teams;
DROP POLICY IF EXISTS "teams_insert_policy" ON public.teams;
DROP POLICY IF EXISTS "teams_update_policy" ON public.teams;
DROP POLICY IF EXISTS "teams_delete_policy" ON public.teams;

-- 9. Create Policies
CREATE POLICY "profiles_select_policy" ON public.profiles FOR SELECT USING (
    current_user_role() IN ('admin', 'manager')
    OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
    OR (current_user_role() = 'player' AND gamemaster_id = (SELECT gamemaster_id FROM public.profiles WHERE id = auth.uid()))
);

CREATE POLICY "profiles_insert_policy" ON public.profiles FOR INSERT WITH CHECK (
    current_user_role() = 'admin'
    OR (current_user_role() = 'manager' AND role IN ('gamemaster', 'player'))
    OR (current_user_role() = 'gamemaster' AND role = 'player' AND gamemaster_id = auth.uid())
);

CREATE POLICY "profiles_update_policy" ON public.profiles FOR UPDATE USING (
    current_user_role() = 'admin'
    OR (current_user_role() = 'manager' AND role IN ('gamemaster', 'player'))
    OR (current_user_role() = 'gamemaster' AND role = 'player' AND gamemaster_id = auth.uid())
);

CREATE POLICY "profiles_delete_policy" ON public.profiles FOR DELETE USING (
    current_user_role() = 'admin'
    OR (current_user_role() = 'manager' AND role IN ('gamemaster', 'player'))
    OR (current_user_role() = 'gamemaster' AND role = 'player' AND gamemaster_id = auth.uid())
);

CREATE POLICY "teams_select_policy" ON public.teams FOR SELECT USING (
    current_user_role() IN ('admin', 'manager')
    OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
    OR (current_user_role() = 'player' AND gamemaster_id = (SELECT gamemaster_id FROM public.profiles WHERE id = auth.uid()))
);

CREATE POLICY "teams_insert_policy" ON public.teams FOR INSERT WITH CHECK (
    current_user_role() = 'admin'
    OR (current_user_role() = 'manager')
    OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
);

CREATE POLICY "teams_update_policy" ON public.teams FOR UPDATE USING (
    current_user_role() = 'admin'
    OR (current_user_role() = 'manager')
    OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
);

CREATE POLICY "teams_delete_policy" ON public.teams FOR DELETE USING (
    current_user_role() = 'admin'
    OR (current_user_role() = 'manager')
    OR (current_user_role() = 'gamemaster' AND gamemaster_id = auth.uid())
);

COMMIT;