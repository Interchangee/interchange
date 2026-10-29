/*
 * FILE: supabase/functions/_shared/supabase.ts
 * 
 * FILE TREE:
 * interchange/
 * ├── supabase/
 * │   ├── migrations/
 * │   └── functions/
 * │       ├── _shared/
 * │       │   └── supabase.ts  <-- YOU ARE HERE
 * │       └── poll-gtfs-rt/
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const admin = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );