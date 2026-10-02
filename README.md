# Interchange

A small, installable web app for an in-real-life transit game: players ride
buses, trains, trams and ferries, the app records where they are with GPS, works
out **which stop they are at** (OpenStreetMap / Overpass) and **which vehicle
they are on** (free GTFS + optional GTFS-Realtime), and awards flexible points.

No build step, no framework, no npm dependencies in the browser bundle — plain
ES modules, a service worker, and one SQL migration at the repository root.

---

## Repository layout

The repo root **is** the deployable web app, and `supabase/` sits at the root in
the standard layout that the Supabase GitHub integration and CLI expect.

```
.
├─ index.html                     app shell (screens + splash)
├─ manifest.webmanifest           PWA manifest
├─ sw.js                          service worker (offline app shell)
├─ assets/
│  ├─ css/app.css                 the whole design system
│  ├─ icons/                      SVG + PNG icons generated for install
│  └─ js/
│     ├─ app.js                   boot + router
│     ├─ config.js                runtime config (+ generated config.local.js)
│     ├─ supabase-lite.js         hand-written Supabase REST/Auth client
│     ├─ store.js  api.js         state + data access
│     ├─ authz.js                 client mirror of the role rules
│     ├─ geo.js                   distance/shape/GPS maths + geolocation
│     ├─ overpass.js              OpenStreetMap stop lookup (free, no key)
│     ├─ gtfs.js                  GTFS zip -> indexed timetable (cached)
│     ├─ realtime.js protobuf.js  GTFS-Realtime vehicle positions
│     ├─ transit.js               THE MATCHER: "what am I on?"
│     ├─ tracker.js               GPS sampling, offline queue, batched upload
│     ├─ idb.js zip.js            IndexedDB cache + zip/CSV readers
│     ├─ ui.js dom.js iconbar.js  view helpers
│     └─ screens/                 home, ride flow, create, teams, game, manage, info, auth
├─ supabase/
│  ├─ config.toml                 project config (sign-up off, function settings)
│  ├─ migrations/
│  │  └─ 20250101000000_init.sql  ENTIRE database: tables, RLS, functions
│  └─ functions/create-user/      edge function that creates accounts
├─ tests/                         Node smoke tests (no dependencies)
├─ tools/                         dev server, packer, build step
├─ vercel.json                    static deploy config (build -> public/)
└─ .nvmrc                         Node version for local tooling
```

---

## 1. Supabase

### 1a. If you connected this repo in the Supabase dashboard (recommended)

Supabase deploys straight from `main`: it applies everything in
`supabase/migrations/` and deploys everything in `supabase/functions/`. So once
this repository is pushed:

1. Dashboard → **Project Settings → Integrations → GitHub**: connect
   `Interchangee/interchange`, branch `main`.
2. The first sync applies `20250101000000_init.sql` (tables, RLS, functions) and
   deploys the `create-user` edge function.
3. Dashboard → **Authentication → Providers → Email**: make sure
   **"Allow new users to sign up" is OFF**. `supabase/config.toml` asks for this
   too, but the dashboard is the source of truth for a hosted project.
4. Dashboard → **Authentication → Users → Add user**: create your own account,
   e.g. email `u_admin@players.interchange.local`, any password,
   **Auto Confirm User** ON. This is the only account ever created by hand — it
   cannot be made in-app, because creating users in-app requires being an admin
   already.
5. Open the app, sign in with that username (`admin`) and tap
   **"Make me the admin"**. That calls `claim_first_admin()`, which works exactly
   once: only while the project has no admin **and** no other profile exists.
   After that it refuses forever.

Every other account is created in-app by an admin, manager or gamemaster.

> Without the GitHub integration, do the same from a terminal:
> `supabase link --project-ref <ref> && supabase db push && supabase functions deploy create-user`

### 1b. Manual alternative

Paste `supabase/migrations/20250101000000_init.sql` into the SQL editor and run
it, then promote your first user by hand:

```sql
update public.profiles
   set role = 'admin', display_name = 'Game Control'
 where username = 'admin';

insert into public.auth_accounts (user_id, username, fake_email, password)
select id, username, email, 'the-password-you-typed'
  from public.profiles where username = 'admin';
```

### What the edge function is for

`create-user` is the only place the **service_role** key is ever used. It
authenticates the caller, checks the role rules, then uses the admin API to
create the account, record the username/password in `auth_accounts`, link the
player to their gamemaster, and add them to their game and teams. The platform
injects the keys automatically — never put a service key in the web app.

---

## 2. Deploy / run the web app

The repository root **is** the web app, so most static hosts need no build at
all. It must be served over **HTTPS** for GPS and the service worker, except on
`localhost`.

```bash
npm run serve          # http://localhost:8080 - zero dependencies
# or: python -m http.server 8080
```

### Vercel

Vercel does not auto-detect a plain static site, so without configuration it
fails with *"No Output Directory named public found"*. That is handled in
[`vercel.json`](vercel.json), which tells Vercel to run `npm run build` and
serve the resulting `public/`:

```bash
npm run build     # writes assets/js/config.local.js (if env vars exist) then packs ./public
```

`public/` is a build artefact and is git-ignored. The pack step copies only what
a browser or the Supabase deployer needs — `index.html`, `sw.js`, the manifest,
`assets/`, and `supabase/` — never `tests/`, `tools/`, `.env` or any local
config. Deploy by importing the repo in Vercel; the settings in `vercel.json`
are picked up automatically, so leave Framework Preset as **Other** and do not
set an Output Directory by hand.

Your `public/` on Vercel also contains `supabase/`, which is what a Supabase
GitHub integration reads when it applies migrations and deploys functions.

### Connecting the app to your project

Two options, in priority order (a value saved in the browser always wins):

**Option A — bake it in (nicer for players).** Set the two public values in your
host's environment variables (Vercel: *Settings → Environment Variables*), then
build. On Vercel this happens during deployment; locally:

```bash
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_ANON_KEY=eyJhbGci... \
npm run build          # writes assets/js/config.local.js (git-ignored)
```

`tools/build.mjs` **refuses to build if the key is a `service_role` key**, and
skips the config entirely when the variables are missing.

**Option B — paste it at runtime.** Do nothing; on first launch the app shows a
**Connect to Supabase** screen and stores the project URL and anon key in that
browser only. Handy for testing, and it keeps the repository environment-free.

> **Is Option A safe?** Yes. The anon/publishable key is designed to be public
> and must reach the browser either way; Row Level Security is what actually
> protects your data, and it is enabled on every table. Never put the
> `service_role` key in a host environment variable that the build reads — that
> one bypasses RLS entirely and only belongs in the Supabase edge function,
> where the platform injects it automatically.

Then sign in with the username you created in step 1a. On a phone use the
browser's *Install app / Add to home screen*: the manifest and service worker
make it a standalone, offline-capable app.

---

## 3. Tell it about your city's transit

**Manage → Transit feeds → Add a feed**:

| field | what to put there |
|---|---|
| Key | short slug, e.g. `my-city` |
| Name | display name |
| Timezone | IANA name, e.g. `Europe/Berlin` (must match the GTFS agency timezone) |
| Static GTFS zip url | a direct link to the agency's `google_transit.zip` |
| GTFS-Realtime vehicle positions | optional `.pb` url — unlocks real vehicle IDs ("LIVE" guesses) |

GTFS feeds are free and published by nearly every transit agency; many are
listed on <https://transitfeeds.com> and <https://mobilitydatabase.org>.

The feed is downloaded **once per device**, parsed in the browser and kept in
IndexedDB (buttons in Manage let you force a refresh). Nothing is re-downloaded
until the cache is a day old, which keeps data use tiny.

Stops are *always* also looked up on OpenStreetMap through Overpass — free, no
key, no quota — so the app still knows where you are even if a feed is stale.

---

## 4. Roles and who may create whom

| role | can create | teams | games |
|---|---|---|---|
| **admin** | admins, managers, gamemasters, players | any game | any |
| **manager** | gamemasters, players | any game | any |
| **gamemaster** | players **in their own game only** | own game | own game |
| **player** | nobody | — | tracking + points only |

The rules are enforced twice: in [`authz.js`](assets/js/authz.js) so the UI never
offers a forbidden action, and authoritatively in the database (RLS policies plus
the `create-user` function).

Every created account gets:

* a **username** the player types to sign in,
* a **password** you choose (with a generator),
* a generated email `u_<username>@players.interchange.local` used behind the scenes,
* a row in `profiles` (name, role, status),
* a row in `auth_accounts` so admins/managers can always read the credentials back,
* a `gamemaster_players` link and `game_members` membership.

**Teams** are per game and can be created by admins, managers and gamemasters in
the *Create → Team* tab. The Teams screen shows one card per team with its
members, an edit action per member, and a shuffle button that deals all players
of a game evenly across the teams.

---

## 5. How the ride flow works

### "I just got on" (the big button on Home)

1. A GPS fix is taken (with a timeout and a "skip, pick manually" escape).
2. **Overpass** returns every transit stop within ~350 m, deduplicated into stations.
3. **GTFS static** (from the device cache) gives the scheduled departures at those
   stops in a window around now, using the feed's own timezone and service calendar.
4. **GTFS-Realtime**, when the agency publishes it, adds the actual vehicles
   (route, trip, vehicle label, live position).
5. Candidates are scored on stop distance, how recently the departure left, live
   data, stop-name agreement and whether your recent GPS track follows the route
   shape. The result is a short ranked list — *"Are you on 12 → Airport? · likely"* —
   with **Pick a stop**, **Type the route**, **Scan again** and
   *"record a ride with no route"* fallbacks.

Confirming stores a `boardings` row: vehicle, direction, boarding stop and time,
the guess that was offered, and what the player actually picked (`corrected`).

### While riding

`tracker.js` samples GPS (default every 20 s and at least 15 m apart, noisy fixes
discarded), keeps every sample in IndexedDB first, and flushes small batches to
`track_points`. A dead zone or a tunnel never loses data; a "waiting to upload"
counter is shown on Home and in Info.

### "I got off"

1. The queue is flushed and a final fix is taken.
2. `resolveAlighting()` snaps your recorded track and final position onto the
   trip's `shapes.txt` polyline, counts the stops passed along `stop_times`, and
   names the alighting stop. If the feed has no shapes it falls back to the
   nearest GTFS stop.
3. The `boardings` row is completed (alight time/stop, stops travelled, distance)
   and points are awarded automatically.

Every number is kept in `points_events`, so scoring is auditable and revocable.

---

## 6. Points stay flexible

Two layers, both per game:

* **`games.points_config`** — automatic scoring for every ride:
  `points_per_stop`, `points_per_km`, `points_per_new_route`,
  `points_per_new_station`, `points_per_transfer`, `points_per_minute`,
  `points_per_visit`. Edit them in **Game → Rules**.
  The `award_ride_points()` SQL function applies them with dedupe keys so a ride
  can never be scored twice.
* **`point_events`** — named, free-form awards ("Reached the terminus",
  "Photo at the oldest station") that gamemasters can hand out from the roster.
* **Manual awards** with any value and reason, plus revoke, live in `points_events`.

Because scoring is data, the same tracker can drive a scavenger hunt, a
stations-visited sprint and a longest-journey competition at the same time.

---

## 7. Privacy and bandwidth

* GPS is recorded only while the app is open and a ride is active; the tracker
  can be paused at any time from Home or Info.
* `track_points` is pruned by `purge_old_track_points()` according to each game's
  `tracking_config.keep_history_hours` (default 7 days). Schedule it with
  `pg_cron` if you want it automatic:
  `select cron.schedule('prune-tracks', '0 4 * * *', $$select public.purge_old_track_points()$$);`
* Players can export their own GPX and see every recorded trip in **Info**.
* Live tracking of teammates is opt-in per game (`tracking_config.live_tracking`)
  and enforced by RLS.
* Bandwidth: ~60 kB gzipped app shell (cached after first load), one GTFS
  download per device per day, GPS uploads batched and rounded to 6 decimals.

---

## 8. Tests

Requires Node 20+. Nothing to install — `npm test` runs both suites.

```bash
npm test                      # both suites
node tests/engine.test.mjs    # geo maths, CSV/zip, GTFS, calendars, departures
node tests/render.test.mjs    # modules load, every screen renders, SQL/config audit
```

`engine.test.mjs` covers the matcher's maths offline, including a real GTFS zip
round-trip through the `DecompressionStream` reader.

`render.test.mjs` imports every module, renders all seven screens against a DOM
shim with stubbed Supabase data, asserts the role rules and the per-role icon
bar, and audits the deployment: every helper the app calls exists in the
migration, every created table has RLS enabled, and `supabase/config.toml` still
has sign-up disabled.

---

## 9. Common tasks

| I want to… | Where |
|---|---|
| create players/teams | **Create** tab in the icon bar |
| see live rides and award points | **Game control** (admin/manager/gamemaster) |
| read a player's login again | **Manage → Users → ⇩** |
| change someone's role | **Manage → Users → ★** (admin only) |
| shuffle players into teams | **Teams → shuffle** |
| refresh the GTFS feed | **Manage → Transit feeds → ⇩** |
| export a game | **Game control → Live → Export JSON** |
| sign out or switch project | **Info → Sign out** / *Change Supabase connection* |

---

## 10. Data model at a glance

`profiles` · `auth_accounts` · `gamemaster_players` · `games` · `game_members` ·
`teams` · `team_members` · `transit_agencies` · `gtfs_departures` · `vehicles` ·
`boardings` · `track_points` · `point_events` · `points_events`

plus helper RPCs: `list_my_games`, `list_assignable_games`, `game_leaderboard`,
`email_for_username`, `player_credentials`, `award_ride_points`,
`purge_old_track_points`, `admin_exists`, `claim_first_admin`.
# interchange
# interchange
# interchange
