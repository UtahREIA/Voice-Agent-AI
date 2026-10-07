/**
 * lani-prompt.test.js - Lani V2 prompt rebuild (catalog, assembly, safety rails)
 *
 * Runs with:  node scripts/lani-prompt.test.js
 *
 * Inline fixture rows, no network: every fetch is stubbed. Kept in scripts/
 * because files under api/ become public functions.
 */

import { buildCatalog } from '../api/lib/lani-catalog.js';
import {
  assemblePrompt, rebuildLaniPrompt, LIVE_ASSISTANT_ID, CATALOG_MARKER, catalogDiff
} from '../api/lib/lani-prompt.js';
import { extractPartA } from './seed-lani-part-a.js';

let passed = 0;
let failed = 0;
function check(label, actual, predicate) {
  let ok = false;
  try { ok = predicate(actual); } catch (e) { ok = false; }
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n        got: ${JSON.stringify(actual)}`); }
}
const EM = String.fromCharCode(0x2014);

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------
const vendor = (o) => ({
  company_name: 'Vendor', funding_financial: [], loan_product: [], deals_opportunities: [],
  team_vendors: [], attorney_subclass: [], operations: [], development_land: [],
  education_tech_tools: [], other_contractor: [], contractor_speciality: '', ...o
});
const FIXTURE = {
  reia: [
    { title: 'True Wealth Joint Venture Club', voice_description: 'Free to join.', priority: 20 },
    { title: 'Deal Center', voice_description: 'Public and free.', priority: 10 },
  ],
  events: [],
  tools: [
    { resource_title: 'Rental Property Calculator', paid_resource: false, membership_required: false, resource_url_nonmember: '' },
    { resource_title: 'Purchase Agreement Pack', paid_resource: true, membership_required: true, resource_url_nonmember: '' },
    { resource_title: 'Member Calc With Public Link', paid_resource: false, membership_required: true, resource_url_nonmember: 'https://example.com/x' },
  ],
  courses: [
    { course_name: 'Raising Private Money', paid_education: false, membership_required: false },
    { course_name: 'Members Class', paid_education: false, membership_required: true },
    { course_name: 'Paid Class', paid_education: true, membership_required: false },
  ],
  educators: [
    { educators_name: 'Amy Majhoory', educational_topics: ['fix__flip', 'brand_new_topic'], educational_level: ['exploring__new'], commercial_asset_types: ['self_storage'] },
  ],
  vendors: [
    vendor({ company_name: 'CamaPlan', funding_financial: ['selfdirected_ira__401k_custodian'] }),
    vendor({ company_name: 'Dash ' + EM + ' Lending', funding_financial: ['money_lender_private__hard_money'], business_description: 'Fast ' + EM + ' fair' }),
    vendor({ company_name: 'Plumbing TESTING', contractor_speciality: 'plumbing, rough_in' }),
  ],
};
// What loadCatalogData would return: the vendor gate is applied by the query,
// so a vendor that fails it never reaches buildCatalog. Test (a) checks the gate
// itself via the query string AND via a gated-filter fixture.
const isGated = (v) => v.is_active === true && v.enroll_vendor_match === true && v.approval_status === 'Approved';

// ---------------------------------------------------------------------------
console.log('\na) vendor gate');
{
  const raw = [
    { ...vendor({ company_name: 'Approved Enrolled' }), is_active: true, enroll_vendor_match: true, approval_status: 'Approved' },
    { ...vendor({ company_name: 'Pending Vendor' }),    is_active: true, enroll_vendor_match: true, approval_status: 'Pending' },
    { ...vendor({ company_name: 'Not Enrolled' }),      is_active: true, enroll_vendor_match: false, approval_status: 'Approved' },
  ];
  // Capture the exact query loadCatalogData sends, then serve rows the way
  // PostgREST would for that filter.
  const { loadCatalogData } = await import('../api/lib/lani-catalog.js');
  let vendorQuery = '';
  const fakeFetch = async (url) => {
    const u = String(url);
    let rows = [];
    if (u.includes('ghl_vendor_resources')) {
      vendorQuery = u;
      rows = raw.filter(v =>
        (!u.includes('is_active=eq.true') || v.is_active) &&
        (!u.includes('enroll_vendor_match=eq.true') || v.enroll_vendor_match) &&
        (!u.includes('approval_status=eq.Approved') || v.approval_status === 'Approved'));
    }
    return { ok: true, json: async () => rows };
  };
  const data = await loadCatalogData('https://stub', 'k', fakeFetch, '2026-10-07');
  const cat = buildCatalog(data);
  check('a: query carries all three gate filters', vendorQuery,
    q => q.includes('is_active=eq.true') && q.includes('enroll_vendor_match=eq.true') && q.includes('approval_status=eq.Approved'));
  check('a: approved + enrolled vendor is in', cat.text, t => t.includes('Approved Enrolled'));
  check('a: not-Approved vendor is left out', cat.text, t => !t.includes('Pending Vendor'));
  check('a: not-enrolled vendor is left out', cat.text, t => !t.includes('Not Enrolled'));
  check('a: vendor count is 1', cat.counts.vendors, n => n === 1);
}

// ---------------------------------------------------------------------------
const cat = buildCatalog(FIXTURE);
const section = (name) => {
  const lines = cat.text.split('\n');
  const i = lines.indexOf(name);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (!l.trim() || /^[A-Z][A-Z &]+$/.test(l)) break; out.push(l); }
  return out;
};

console.log('\nb) paid tool placement');
check('b: paid tool is under PAID TOOLS AND FORMS', section('PAID TOOLS AND FORMS'), s => s.some(l => l.startsWith('Purchase Agreement Pack')));
check('b: paid tool is not under FREE CALCULATORS', section('FREE CALCULATORS'), s => !s.some(l => l.startsWith('Purchase Agreement Pack')));
check('b: members only when required AND no nonmember URL', section('PAID TOOLS AND FORMS'), s => s.includes('Purchase Agreement Pack | members only'));
check('b: no members only when a nonmember URL exists', section('FREE CALCULATORS'), s => s.includes('Member Calc With Public Link'));

console.log('\nc) class access labels');
check('c: neither flag -> Free', section('CLASSES'), s => s.includes('Raising Private Money | Free'));
check('c: membership_required -> Free for members', section('CLASSES'), s => s.includes('Members Class | Free for members'));
check('c: paid_education -> Paid', section('CLASSES'), s => s.includes('Paid Class | Paid'));

console.log('\nd) unmapped topic');
check('d: unmapped topic passes through', section('EDUCATORS AND MENTORS'), s => s[0] === 'Amy Majhoory | fix and flip, brand_new_topic, commercial: self storage | new and exploring');
check('d: counted as unmapped', cat.counts.unmapped, u => JSON.stringify(u) === '["brand_new_topic"]');
check('d: record not dropped', cat.counts.educators, n => n === 1);

console.log('\ne) missing [[Name]] fails the build');
{
  const partA = 'Recommend [[Deal Center]] and [[True Wealth]] and [[Ghost Vendor]].\n\n' + CATALOG_MARKER;
  const r = assemblePrompt(partA, cat);
  check('e: build fails', r.ok, v => v === false);
  check('e: names every missing record', r.missing, m => JSON.stringify(m) === '["True Wealth","Ghost Vendor"]');
  check('e: error text names them', r.error, t => t.includes('True Wealth') && t.includes('Ghost Vendor'));
}
// e, end to end: a failed build writes a failed row and never calls Vapi.
{
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url); calls.push({ u, m: opts.method || 'GET', body: opts.body });
    if (u.includes('lani_prompt_parts')) return { ok: true, json: async () => [{ version: 1, part_a: 'Try [[Ghost Vendor]].\n\n' + CATALOG_MARKER }] };
    if (u.includes('lani_prompt_builds')) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [] };
  };
  const env = { VAPI_API_KEY: 'k', LANI_V2_ASSISTANT_ID: 'v2-test', SUPABASE_URL: 'https://stub', SUPABASE_SERVICE_KEY: 'k', LANI_PROMPT_WRITE: 'true' };
  const r = await rebuildLaniPrompt({ trigger: 'test', env, fetchImpl, log: { log() {}, error() {} } });
  const row = calls.find(c => c.u.includes('lani_prompt_builds') && c.m === 'POST');
  check('e: rebuild returns failed', r.status, s => s === 'failed');
  check('e: failed row written with the missing name', row && JSON.parse(row.body), b => b.status === 'failed' && b.error.includes('Ghost Vendor') && b.counts.missing.includes('Ghost Vendor'));
  check('e: no Vapi call at all', calls, cs => !cs.some(c => c.u.includes('api.vapi.ai')));
}

console.log('\nf) markers stripped');
{
  const r = assemblePrompt('Offer [[Deal Center]], or [[CamaPlan]] for an IRA.\n\n' + CATALOG_MARKER, cat);
  check('f: build ok', r.ok, v => v === true);
  check('f: no [[ left', r.text, t => !t.includes('[[') && !t.includes(']]'));
  check('f: no << left', r.text, t => !t.includes('<<'));
  check('f: names kept as plain text', r.text, t => t.startsWith('Offer Deal Center, or CamaPlan for an IRA.'));
  check('f: catalog inserted where the marker was', r.text, t => t.includes('\n\nCATALOG\nThis is everything you may recommend.'));
}

console.log('\ng) em dash in vendor text');
check('g: vendor name em dash becomes " - "', section('VENDORS'), s => s.some(l => l.startsWith('Dash - Lending | ')));
check('g: no em dash anywhere in the catalog', cat.text, t => !t.includes(EM));
check('g: business_description is not rendered (spec line is name | categories)', cat.text, t => !t.includes('Fast'));
check('g: contractor_speciality text is split into labels', section('VENDORS'), s => s.includes('Plumbing TESTING | plumbing, rough_in'));

console.log('\nh) identical input, identical hash');
{
  const partA = 'Hello [[Deal Center]].\n\n' + CATALOG_MARKER;
  const shuffled = { ...FIXTURE, vendors: [...FIXTURE.vendors].reverse(), courses: [...FIXTURE.courses].reverse() };
  const h1 = assemblePrompt(partA, buildCatalog(FIXTURE)).hash;
  const h2 = assemblePrompt(partA, buildCatalog(FIXTURE)).hash;
  const h3 = assemblePrompt(partA, buildCatalog(shuffled)).hash;
  check('h: same input -> same sha256', [h1, h2], v => /^[0-9a-f]{64}$/.test(v[0]) && v[0] === v[1]);
  check('h: row order does not change the hash', [h1, h3], v => v[0] === v[1]);
  const h4 = assemblePrompt(partA, buildCatalog({ ...FIXTURE, courses: [] })).hash;
  check('h: different input -> different hash', [h1, h4], v => v[0] !== v[1]);
}

console.log('\ni) endpoint refuses the live assistant');
{
  process.env.VAPI_API_KEY = 'k';
  process.env.LANI_V2_ASSISTANT_ID = LIVE_ASSISTANT_ID;
  process.env.SUPABASE_URL = 'https://stub';
  process.env.SUPABASE_SERVICE_KEY = 'k';
  process.env.LANI_PROMPT_WRITE = 'true';
  delete process.env.CRON_SECRET;
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => { calls.push(String(url)); return { ok: true, json: async () => [] }; };
  const { default: syncHandler } = await import('../api/sync-ghl-objects.js');
  let out = null;
  const res = { status() { return this; }, json(o) { out = o; return this; } };
  try { await syncHandler({ method: 'GET', headers: {}, query: { mode: 'lani-rebuild' } }, res); }
  finally { global.fetch = realFetch; }
  check('i: refused', out, o => o.ok === false && /refused/.test(o.error) && /live/.test(o.error));
  check('i: no network call made', calls, c => c.length === 0);

  process.env.LANI_V2_ASSISTANT_ID = '';
  out = null;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => [] }; };
  try { await syncHandler({ method: 'GET', headers: {}, query: { mode: 'lani-rebuild' } }, res); }
  finally { global.fetch = realFetch; }
  check('i: refused when LANI_V2_ASSISTANT_ID is missing', out, o => o.ok === false && /refused/.test(o.error));

  delete process.env.VAPI_API_KEY;
  out = null;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => [] }; };
  try { await syncHandler({ method: 'GET', headers: {}, query: { mode: 'lani-rebuild' } }, res); }
  finally { global.fetch = realFetch; }
  check('i: without VAPI_API_KEY -> not_configured, nothing else', [out, calls.length], v => v[0].error === 'not_configured' && v[1] === 0);
}

// ---------------------------------------------------------------------------
console.log('\nextra) Vapi write path: full model, confirm, restore');
{
  const partA = 'Hi [[Deal Center]].\n\n' + CATALOG_MARKER;
  const baseModel = () => ({
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001', temperature: 0.3, toolIds: ['t1', 't2'],
    maxTokens: 300, messages: [{ role: 'system', content: 'OLD PROMPT\nCATALOG\nDeal Center: x\nGone Vendor | y' }]
  });
  const run = async ({ mutateOnPatch = null, lastHash = null, write = 'true', dry = false } = {}) => {
    let stored = baseModel();
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      const u = String(url); const m = opts.method || 'GET';
      calls.push({ u, m, body: opts.body ? JSON.parse(opts.body) : null });
      const j = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => '' });
      if (u.includes('lani_prompt_parts')) return j([{ version: 1, part_a: partA }]);
      if (u.includes('lani_prompt_builds') && m === 'GET') return j(lastHash ? [{ prompt_hash: lastHash }] : []);
      if (u.includes('lani_prompt_builds')) return j(null);
      if (u.includes('api.vapi.ai')) {
        if (m === 'PATCH') {
          const body = JSON.parse(opts.body);
          stored = JSON.parse(JSON.stringify(body.model));
          if (mutateOnPatch && !calls.some(c => c.m === 'PATCH' && c !== calls[calls.length - 1])) mutateOnPatch(stored);
          return j({});
        }
        return j({ id: 'v2-test', model: stored });
      }
      if (u.includes('reia_resources')) return j(FIXTURE.reia);
      return j([]);
    };
    const env = { VAPI_API_KEY: 'k', LANI_V2_ASSISTANT_ID: 'v2-test', SUPABASE_URL: 'https://stub', SUPABASE_SERVICE_KEY: 'k', LANI_PROMPT_WRITE: write };
    const r = await rebuildLaniPrompt({ trigger: 'test', dry, env, fetchImpl, log: { log() {}, error() {} } });
    return { r, calls, stored };
  };

  const ok = await run();
  const patch = ok.calls.find(c => c.m === 'PATCH');
  check('extra: ok build', ok.r.status, s => s === 'ok');
  check('extra: PATCH sends the FULL model (provider, toolIds, temperature kept)', patch.body.model,
    m => m.provider === 'anthropic' && JSON.stringify(m.toolIds) === '["t1","t2"]' && m.temperature === 0.3 && m.maxTokens === 300);
  check('extra: only the system content changed', patch.body.model.messages[0].content, c => c.startsWith('Hi Deal Center.') && !c.includes('OLD PROMPT'));
  check('extra: ok row marks written_to_vapi', ok.calls.find(c => c.u.includes('lani_prompt_builds') && c.m === 'POST').body,
    b => b.status === 'ok' && b.written_to_vapi === true);

  const drift = await run({ mutateOnPatch: (m) => { m.toolIds = []; } });
  const patches = drift.calls.filter(c => c.m === 'PATCH');
  check('extra: confirm catches a reset of toolIds', drift.r.status, s => s === 'failed');
  check('extra: original model is PATCHed back', patches.length === 2 && patches[1].body.model.messages[0].content, c => typeof c === 'string' && c.startsWith('OLD PROMPT'));

  const same = await run({ lastHash: ok.r.prompt_hash });
  check('extra: same hash as last ok -> unchanged, no Vapi call', [same.r.status, same.calls.some(c => c.u.includes('api.vapi.ai'))], v => v[0] === 'unchanged' && v[1] === false);

  const dryWrite = await run({ write: 'false' });
  check('extra: LANI_PROMPT_WRITE not "true" -> dry_run, no PATCH', [dryWrite.r.status, dryWrite.calls.some(c => c.m === 'PATCH')], v => v[0] === 'dry_run' && v[1] === false);
  check('extra: dry run diff reports added and removed records', dryWrite.r.diff, d => d.removed.includes('Gone Vendor') && d.added.includes('True Wealth Joint Venture Club') && !d.added.includes('Deal Center'));
  const dryParam = await run({ dry: true });
  check('extra: ?dry=1 forces dry_run even with LANI_PROMPT_WRITE=true', dryParam.r.status, s => s === 'dry_run');
}

console.log('\nextra) seed extraction');
{
  const sys = 'You are Lani ' + EM + ' be kind.\nOffer the Deal Center, CamaPlan, and True Wealth Joint Venture Club.\nCATALOG\nDeal Center: x';
  const { partA, found } = extractPartA(sys);
  check('seed: cut at CATALOG and marker appended', partA, p => p.endsWith('\n\n' + CATALOG_MARKER) && !p.includes('Deal Center: x'));
  check('seed: names wrapped', partA, p => p.includes('[[Deal Center]]') && p.includes('[[CamaPlan]]'));
  check('seed: em dash replaced', partA, p => !p.includes(EM) && p.includes('Lani - be kind'));
  check('seed: "True Wealth" inside the longer name gets wrapped as written in the spec list', [partA, found], v => v[0].includes('[[True Wealth]] Joint Venture Club') && v[1].includes('True Wealth'));
  check('seed: that wrap fails validation against the real record name', assemblePrompt(partA, buildCatalog(FIXTURE)), r => r.ok === false && r.missing.includes('True Wealth'));
  let threw = false; try { extractPartA('no marker here'); } catch { threw = true; }
  check('seed: refuses when there is no exact CATALOG line', threw, t => t === true);
}

console.log(`\n${'-'.repeat(54)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
