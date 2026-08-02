/**
 * One-shot live smoketest for createRoadmap.
 *
 * Requires env vars (same names the Vercel handlers use):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * Option A — set them in your PowerShell session before running:
 *   $env:SUPABASE_URL = "https://kttzxjddtkgsitzehiid.supabase.co"
 *   $env:SUPABASE_SERVICE_KEY = "<service_role key from Supabase dashboard>"
 *   node scripts/roadmap-smoketest.js
 *
 * Option B — link Vercel and pull env, then run:
 *   npx vercel link
 *   npx vercel env pull .env.local
 *   node --env-file=.env.local scripts/roadmap-smoketest.js
 *
 * Test data is NOT deleted after run so you can inspect it in the Supabase
 * table editor. Delete it manually when done.
 */

import { loadRefs, setRefs, createRoadmap } from '../api/lib/roadmap-generator.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('MISSING CREDENTIALS');
  console.error('  SUPABASE_URL:        ' + (SUPABASE_URL ? 'set' : 'NOT SET'));
  console.error('  SUPABASE_SERVICE_KEY:' + (SUPABASE_KEY ? 'set' : 'NOT SET'));
  console.error('');
  console.error('Get the service_role key from:');
  console.error('  Supabase dashboard → Project Settings → API → service_role key');
  console.error('');
  console.error('Then run:');
  console.error('  $env:SUPABASE_URL = "https://kttzxjddtkgsitzehiid.supabase.co"');
  console.error('  $env:SUPABASE_SERVICE_KEY = "eyJ..."');
  console.error('  node scripts/roadmap-smoketest.js');
  process.exit(1);
}

const db = { url: SUPABASE_URL, key: SUPABASE_KEY };

const diagnosis = {
  strategy: 'fix_and_flip',
  stage: 'getting_started',
  deal_count: 0,
  phone: 'TEST-9990001111',
  contact_id: null,
  stated_stuck_point: null,
  education_history: null,
  already_tried: null,
  signals: {},
};

async function selectTable(table, filter) {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&select=*`, { headers: h });
  return res.json();
}

async function run() {
  console.log('=== roadmap-smoketest ===');
  console.log('Loading refs...');
  const refs = await loadRefs(SUPABASE_URL, SUPABASE_KEY);
  setRefs(refs);

  console.log('Calling createRoadmap...');
  const result = await createRoadmap(diagnosis, db);

  console.log('\n--- createRoadmap returned ---');
  console.log(JSON.stringify(result, null, 2));

  const { roadmap_id } = result;
  if (!roadmap_id) {
    console.error('No roadmap_id returned — write may have failed');
    process.exit(1);
  }

  console.log('\n--- caller_roadmaps ---');
  const rm = await selectTable('caller_roadmaps', `id=eq.${roadmap_id}`);
  console.log(JSON.stringify(rm, null, 2));

  console.log('\n--- roadmap_phases ---');
  const phases = await selectTable('roadmap_phases', `roadmap_id=eq.${roadmap_id}&order=phase_order`);
  console.log(JSON.stringify(phases, null, 2));

  console.log('\n--- roadmap_items ---');
  const items = await selectTable('roadmap_items', `roadmap_id=eq.${roadmap_id}&order=across_type_ord,within_type_priority`);
  console.log(JSON.stringify(items, null, 2));

  console.log('\nDone. Test roadmap_id:', roadmap_id);
  console.log('(rows NOT deleted — inspect in Supabase table editor, delete manually when done)');
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
