/*
 * FILE: supabase/functions/create-user/index.ts
 * 
 * FILE TREE:
 * interchange/
 * ├── supabase/
 * │   ├── functions/
 * │   │   ├── _shared/
 * │   │   ├── poll-gtfs-rt/
 * │   │   └── create-user/
 * │   │       └── index.ts  <-- YOU ARE HERE
 */

import { admin } from "../_shared/supabase.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')!;
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !user) return new Response("Unauthorized", { status: 401 });

  const db = admin();
  const { data: caller } = await db.from('profiles').select('role').eq('id', user.id).single();
  if (!caller) return new Response("Profile not found", { status: 403 });

  const { username, role: targetRole, password, gamemaster_id, game_id } = await req.json();

  // Role hierarchy validation
  const levels: Record<string, number> = { admin: 4, manager: 3, gamemaster: 2, player: 1 };
  if (levels[caller.role] <= levels[targetRole]) {
    return new Response("Forbidden: Cannot create this role", { status: 403 });
  }

  // Gamemaster constraint: can only create players for themselves
  if (caller.role === 'gamemaster' && (targetRole !== 'player' || gamemaster_id !== user.id)) {
    return new Response("Gamemasters can only create players for themselves", { status: 403 });
  }

  // Generate random fake email
  const fakeEmail = `user-${crypto.randomUUID()}@interchange.game`;

  // Create Auth User
  const { data: newUser, error: createError } = await db.auth.admin.createUser({
    email: fakeEmail,
    password: password,
    email_confirm: true,
  });

  if (createError) return new Response(createError.message, { status: 400 });

  // Create Profile
  const { error: profileError } = await db.from('profiles').insert({
    id: newUser.user.id,
    email: fakeEmail,
    username: username,
    role: targetRole,
    gamemaster_id: targetRole === 'player' ? gamemaster_id : null,
    game_id: game_id,
  });

  if (profileError) {
     await db.auth.admin.deleteUser(newUser.user.id); // Rollback
     return new Response(profileError.message, { status: 400 });
  }

  return new Response(JSON.stringify({ success: true, user: newUser.user }));
});