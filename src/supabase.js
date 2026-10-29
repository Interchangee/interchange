/*
 * FILE: src/supabase.js
 * 
 * FILE TREE:
 * interchange/
 * ├── src/
 * │   ├── supabase.js  <-- YOU ARE HERE
 * │   ├── App.jsx
 * │   ├── Game.jsx
 * │   ├── Map.jsx
 * │   ├── useGpsTracker.js
 * │   ├── TripStatusBanner.jsx
 * │   ├── AlightPrompt.jsx
 * │   └── Scoreboard.jsx
 * 
 * DO NOT CREATE: src/components/, src/hooks/, src/services/, src/utils/
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase env vars in .env.local");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);