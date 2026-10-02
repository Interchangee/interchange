-- ============================================================================
--  Fix: the role guard blocked the documented first-admin bootstrap.
--
--  guard_profile_role() required is_admin() for any role change, and is_admin()
--  reads auth.uid() - which is NULL in the Supabase SQL Editor. So promoting
--  the very first admin by hand (or with claim_first_admin(), which is a
--  SECURITY DEFINER function with no session of its own) raised:
--
--      ERROR: P0001: only an admin can change a role
--
--  The intent was to stop a player escalating themselves through the API. A
--  real API request always carries a JWT, so auth.uid() is never null there:
--  allowing the change only when there is no authenticated session keeps the
--  API locked down while letting migrations, the SQL Editor and the
--  service_role run the bootstrap.
--
--  Safe to run on a database that already has the old guard in place, and a
--  no-op for a project created from 20250101000000_init.sql after this change.
-- ============================================================================

create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- true when this statement came from the SQL Editor, a migration, or the
  -- service role rather than from a signed-in API client
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

-- recreate the trigger so it is bound to this function definition
drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

comment on function public.guard_profile_role() is
  'Blocks privilege escalation from API clients (which always have auth.uid()).
   Statements with no session - the SQL Editor, migrations, service_role - may
   change roles, which is what makes the first-admin bootstrap possible.';

-- ============================================================================
--  After applying this you can promote the first admin with plain SQL:
--
--    update public.profiles
--       set role = 'admin', status = 'active'
--     where id = (select id from auth.users order by created_at limit 1);
--
--  Or simply use the "Make me the admin" button in the app, which calls
--  public.claim_first_admin().
-- ============================================================================
