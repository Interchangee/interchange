/* ==========================================================================
   Static packaging step.

     node tools/pack.mjs        -> builds ./public

   The repository root IS the web app, which is what the Supabase GitHub
   integration needs (supabase/ must sit at the root). Vercel, on the other
   hand, wants a directory to serve. This script produces exactly that: a
   `public/` containing only what a browser (or the Supabase deployer) should
   see, never the tests, the tools, or any git-ignored local config.

     npm run build   ->   generate config.local.js  +  pack
   ========================================================================== */

import { cp, mkdir, rm, readdir, stat, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(root, 'public');

/* Everything a deployed copy needs. Order matters only for the log. */
const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'assets',        // css, js modules, icons (config.local.js included if built)
  'supabase',      // config.toml + migrations + functions: read by Supabase, not by browsers
  '.env.example',  // documents the two variables, contains no values
  '.gitignore',    // harmless, and keeps the folder self-describing
];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  let copied = 0;
  const lines = [];
  for (const entry of INCLUDE) {
    const src = join(root, entry);
    if (!(await exists(src))) {
      lines.push(`  skip   ${entry} (not present)`);
      continue;
    }
    const dest = join(out, entry);
    await cp(src, dest, { recursive: true });
    const s = await stat(src);
    if (s.isDirectory()) {
      const n = (await readdir(dest, { recursive: true })).length;
      copied += n;
      lines.push(`  dir    ${entry}/ (${n} entries)`);
    } else {
      copied++;
      lines.push(`  file   ${entry}`);
    }
  }

  // `public/` must never be treated as source: it is a build artefact.
  await cp(join(root, '.gitignore'), join(out, '.gitignore'), { force: true }).catch(() => {});

  console.log(`packed ${copied} entries into public/`);
  lines.forEach((l) => console.log(l));

  const hasConfig = await exists(join(out, 'assets/js/config.local.js'));
  console.log(hasConfig
    ? '  config.local.js: included (Supabase connection is baked in)'
    : '  config.local.js: absent (the app will show its "Connect to Supabase" screen)');

  return copied;
}

export const packed = await main();
