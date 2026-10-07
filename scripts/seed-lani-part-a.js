/**
 * seed-lani-part-a.js - one-time seed of lani_prompt_parts version 1 from the
 * Lani V2 assistant's current system prompt.
 *
 * Runs with (PowerShell):
 *   $env:VAPI_API_KEY="..."; $env:LANI_V2_ASSISTANT_ID="39e25be8-2e81-4df5-a314-e741b3a31160"
 *   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_KEY="..."
 *   node scripts/seed-lani-part-a.js --dry-run     # print only
 *   node scripts/seed-lani-part-a.js               # insert version 1
 *
 * What it does:
 *   1. Refuses if version 1 already exists, or the target is the live assistant.
 *   2. GETs the V2 assistant, reads the system message.
 *   3. Part A = everything before the line that is exactly "CATALOG", then the
 *      <<CATALOG>> marker where that section began.
 *   4. Wraps the known record names in [[ ]] wherever they appear.
 *   5. Replaces em dashes with " - ".
 *   6. Checks every [[name]] against the live catalog (same builder the rebuild
 *      uses) and refuses to insert if any would fail the build. The table is
 *      append-only, so a version that can never build is not written.
 *   7. Inserts version 1, is_active true, created_by 'seed'.
 */

import { LIVE_ASSISTANT_ID, CATALOG_MARKER, getSystemContent, assemblePrompt } from '../api/lib/lani-prompt.js';
import { buildCatalog, loadCatalogData } from '../api/lib/lani-catalog.js';

export const SEED_NAMES = [
  'CamaPlan', 'Amy Majhoory', 'Raising Private Money', 'Sec Securities Attorney TESTING',
  'Loan Servicing Company TESTING', 'The Fix& Flip Calculator', 'Short-Term Rental Calculator',
  'Rental Property Calculator', 'Deal Center', 'True Wealth'
];

const EM_DASH_RE = new RegExp('\\s*' + String.fromCharCode(0x2014) + '\\s*', 'g');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: system prompt -> { partA, found } or throws. */
export function extractPartA(systemPrompt, names = SEED_NAMES) {
  const lines = String(systemPrompt).split('\n');
  const idx = lines.findIndex(l => l.replace(/\r$/, '') === 'CATALOG');
  if (idx < 0) throw new Error('No line that is exactly "CATALOG" in the system prompt');
  let partA = lines.slice(0, idx).join('\n').replace(EM_DASH_RE, ' - ');
  // Longest names first so a shorter name never splits a longer one; skip text
  // already inside [[ ]].
  const ordered = [...names].sort((a, b) => b.length - a.length);
  const re = new RegExp('\\[\\[[^\\]]*\\]\\]|(' + ordered.map(escapeRe).join('|') + ')', 'g');
  const found = new Set();
  partA = partA.replace(re, (m, name) => {
    if (!name) return m;
    found.add(name);
    return `[[${name}]]`;
  });
  partA = partA.replace(/\s*$/, '') + '\n\n' + CATALOG_MARKER;
  return { partA, found: names.filter(n => found.has(n)), notFound: names.filter(n => !found.has(n)) };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { VAPI_API_KEY, LANI_V2_ASSISTANT_ID, SUPABASE_URL } = process.env;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const target = (LANI_V2_ASSISTANT_ID || '').trim();
  if (!VAPI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) throw new Error('Set VAPI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  if (!target) throw new Error('Set LANI_V2_ASSISTANT_ID');
  if (target === LIVE_ASSISTANT_ID) throw new Error('Refusing: target is the live assistant');

  const sb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const existing = await (await fetch(`${SUPABASE_URL}/rest/v1/lani_prompt_parts?version=eq.1&select=id`, { headers: sb })).json();
  if (!Array.isArray(existing)) throw new Error('Could not read lani_prompt_parts');
  if (existing.length) throw new Error('Refusing: version 1 already exists');

  const g = await fetch(`https://api.vapi.ai/assistant/${target}`, { headers: { Authorization: `Bearer ${VAPI_API_KEY}` } });
  if (!g.ok) throw new Error(`Vapi GET http ${g.status}`);
  const system = getSystemContent((await g.json()).model);
  if (system === null) throw new Error('Assistant has no system message');

  const { partA, found, notFound } = extractPartA(system);
  console.log(`Part A: ${partA.length} chars`);
  console.log(`[[names]] found (${found.length}): ${found.join(', ')}`);
  if (notFound.length) console.log(`Not present in Part A (not wrapped): ${notFound.join(', ')}`);

  const catalog = buildCatalog(await loadCatalogData(SUPABASE_URL, SUPABASE_KEY));
  const check = assemblePrompt(partA, catalog);
  if (!check.ok) throw new Error('Refusing: this Part A would fail every build. ' + check.error);
  console.log(`Validation: assembles to ${check.chars} chars`);

  if (dryRun) { console.log('\n--dry-run: nothing inserted.\n\n' + partA); return; }

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/lani_prompt_parts`, {
    method: 'POST',
    headers: { ...sb, Prefer: 'return=representation' },
    body: JSON.stringify({ version: 1, part_a: partA, note: 'Seeded from V2 assistant system prompt', is_active: true, created_by: 'seed' })
  });
  if (!ins.ok) throw new Error(`Insert failed http ${ins.status}: ${await ins.text()}`);
  console.log('Inserted lani_prompt_parts version 1 (is_active true).');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/seed-lani-part-a.js')) {
  main().catch(e => { console.error('SEED FAILED: ' + e.message); process.exit(1); });
}
