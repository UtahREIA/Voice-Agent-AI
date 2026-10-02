/**
 * intake-assessment.test.js - in-call assessment in api/intake.js
 *
 * Runs with:  node scripts/intake-assessment.test.js
 *
 * Kept in scripts/ (not api/) so it is never deployed as a Vercel function:
 * it stubs global.fetch and process.env.
 *
 * Reference data is inlined (subset of the seed mirrored in
 * api/lib/roadmap-generator.test.js). No live DB connection required.
 */

import { setRefs } from '../api/lib/roadmap-generator.js';
import { parseDealCount } from '../api/lib/deal-count.js';

process.env.SUPABASE_URL = 'https://stub.supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'stub-key';

const { buildAssessment } = await import('../api/intake.js');

// ---------------------------------------------------------------------------
// INLINE REFERENCE DATA
// ---------------------------------------------------------------------------

const archetypes = [
  { id: 1, archetype_key: 'A1', name: 'Active Deal Operator' },
  { id: 3, archetype_key: 'A3', name: 'Capital Deployer / Passive' },
  { id: 7, archetype_key: 'A7', name: 'Discovery / Not Sure' },
];
const _p = (archetype_id, phase_order, canonical_intent, display_label) =>
  ({ archetype_id, phase_order, canonical_intent, display_label });
const phases = [
  _p(1,1,'CLARIFY','Clarify & Commit'), _p(1,2,'LEARN','Learn the Model'),
  _p(1,3,'PREPARE','Get Deal-Ready'), _p(1,4,'ACQUIRE','Source & Analyze Deals'),
  _p(1,5,'EXECUTE','Execute & Repeat'),
  _p(3,1,'CLARIFY','Clarify Goals & Capital Position'), _p(3,2,'LEARN','Learn to Evaluate'),
  _p(3,3,'PREPARE','Build Evaluation Toolkit & Network'), _p(3,4,'ACQUIRE','Vet & Select Opportunities'),
  _p(3,5,'EXECUTE','Deploy & Monitor'),
  _p(7,1,'CLARIFY','Understand the Person'), _p(7,2,'LEARN','Explore & Narrow'),
  _p(7,3,'HANDOFF','Assign & Hand Off'),
];
const strategyRows = [
  { strategy: 'fix_and_flip',      default_archetype_id: 1, promote_to_archetype_id: null, promote_trigger: null, notes: null },
  { strategy: 'passive_investing', default_archetype_id: 3, promote_to_archetype_id: null, promote_trigger: null, notes: null },
];
const precedenceRows = [];

const phasesByArchetype = {};
for (const p of phases) (phasesByArchetype[p.archetype_id] ||= []).push(p);
setRefs({
  archetypesById: Object.fromEntries(archetypes.map(a => [a.id, a])),
  strategyMap: Object.fromEntries(strategyRows.map(r => [r.strategy, r])),
  phasesByArchetype,
  intentPrecedence: precedenceRows,
});

// ---------------------------------------------------------------------------
// MINIMAL TEST HARNESS (same shape as roadmap-generator.test.js)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(label, actual, predicate) {
  let ok = false;
  try { ok = predicate(actual); } catch (e) { ok = false; }
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n        got: ${JSON.stringify(actual)}`); }
}
const EM = String.fromCharCode(0x2014);
const noEmDash = (a) => !JSON.stringify(a).includes(EM);

const caseInputs = (o) => ({
  strategy: '', stage: '', education_history: '', already_tried: '', specific_need: '', blocker: '',
  ...o,
  dealCountParsed: parseDealCount(o.deal_count ?? ''),
});

// ---------------------------------------------------------------------------
// a) passive_investing, active, 24 deals, "access to more deals"
// ---------------------------------------------------------------------------
console.log('\na) passive_investing + stated stuck point');
{
  const a = buildAssessment(caseInputs({
    strategy: 'passive_investing', stage: 'active_investor', deal_count: '24',
    specific_need: 'access to more deals', blocker: '',
  }));
  check('a: archetype A3', a.archetype_key, v => v === 'A3');
  check('a: intent ACQUIRE', a.canonical_intent, v => v === 'ACQUIRE');
  check('a: signal stated_stuck_point', a.signal_used, v => v === 'stated_stuck_point');
  check('a: phase 4', a.entry_phase_order, v => v === 4);
  check('a: all spec fields present', a, v => ['archetype_id','archetype_key','was_promoted','archetype_reason',
    'entry_phase_order','canonical_intent','phase_reason','signal_used','computed_at'].every(k => k in v));
  check('a: no em dashes in stored reasons', a, noEmDash);
}

// ---------------------------------------------------------------------------
// b) same, specific_need matches nothing, blocker "capital" -> retry
// ---------------------------------------------------------------------------
console.log('\nb) blocker retry');
{
  const b = buildAssessment(caseInputs({
    strategy: 'passive_investing', stage: 'active_investor', deal_count: '24',
    specific_need: 'help with my portfolio', blocker: 'capital',
  }));
  check('b: intent PREPARE', b.canonical_intent, v => v === 'PREPARE');
  check('b: signal stated_stuck_point (from blocker retry)', b.signal_used, v => v === 'stated_stuck_point');
  check('b: reason names the blocker, not specific_need', b.phase_reason, v => v.includes("'capital'"));

  // Control: without the blocker, the same inputs fall to the deal_count signal.
  const ctrl = buildAssessment(caseInputs({
    strategy: 'passive_investing', stage: 'active_investor', deal_count: '24',
    specific_need: 'help with my portfolio', blocker: '',
  }));
  check('b control: no blocker -> deal_count signal (24 >= 5 -> PREPARE)', ctrl.signal_used, v => v === 'deal_count');
}

// ---------------------------------------------------------------------------
// c) fix_and_flip, getting_started, deal_count "" -> unknown, not 0
// ---------------------------------------------------------------------------
console.log('\nc) empty deal_count is unknown, not 0');
{
  const inputs = caseInputs({ strategy: 'fix_and_flip', stage: 'getting_started', deal_count: '' });
  check('c: dealCountParsed is null', inputs.dealCountParsed, v => v === null);
  const c = buildAssessment(inputs);
  check('c: archetype A1', c.archetype_key, v => v === 'A1');
  check('c: signal is NOT deal_count', c.signal_used, v => v !== 'deal_count');
  check('c: lands on default CLARIFY', [c.signal_used, c.canonical_intent], v => v[0] === 'default' && v[1] === 'CLARIFY');

  // Guard: the raw string would have been coerced to 0 and forced LEARN.
  const wrong = buildAssessment({ ...inputs, dealCountParsed: Number('') });
  check('c guard: Number("") would wrongly give deal_count -> LEARN', [wrong.signal_used, wrong.canonical_intent],
    v => v[0] === 'deal_count' && v[1] === 'LEARN');
}

// ---------------------------------------------------------------------------
// d) mentoring_others -> contributor_handoff
// ---------------------------------------------------------------------------
console.log('\nd) contributor_handoff');
{
  const d = buildAssessment(caseInputs({ strategy: 'mentoring_others', stage: 'active_investor', specific_need: 'deals' }));
  check('d: route contributor_handoff', d.route, v => v === 'contributor_handoff');
  check('d: no phase', [d.entry_phase_order, d.canonical_intent, d.signal_used], v => v.every(x => x === null));
}

// ---------------------------------------------------------------------------
// e) loadRefs throws -> no assessment, routing response unchanged
// ---------------------------------------------------------------------------
console.log('\ne) loadRefs failure falls through');

const REF_TABLES = ['roadmap_archetypes', 'archetype_phases', 'strategy_archetype_map', 'phase_intent_precedence'];
const CATCH_ALL_RULE = {
  rule_name: 'catch_all_test', path: 'both', stage_key: null, strategy: null, blocker: null,
  priority: 99, routing_action: 'getEducationMatch', tier: '2_and_3',
  voice_bridge: 'Here is what I recommend.', tool_args: {}
};

function makeFetch({ refsFail, rules, writes }) {
  const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  return (url, opts = {}) => {
    const u = String(url);
    if (REF_TABLES.some(t => u.includes(`/rest/v1/${t}`))) {
      if (refsFail) return Promise.reject(new Error('refs down (test)'));
      if (u.includes('roadmap_archetypes')) return json(archetypes);
      if (u.includes('archetype_phases')) return json(phases);
      if (u.includes('strategy_archetype_map')) return json(strategyRows);
      return json(precedenceRows);
    }
    if (u.includes('/rest/v1/intake_state')) {
      if ((opts.method || 'GET') === 'POST') { writes.push(JSON.parse(opts.body)); return json(null); }
      return json([]);
    }
    if (u.includes('/rest/v1/intake_routing_rules')) return json(rules);
    return json([]); // intake_questions, intake_stages
  };
}

async function runHandler(handler, { refsFail, rules }) {
  const writes = [];
  const realFetch = global.fetch;
  global.fetch = makeFetch({ refsFail, rules, writes });
  const req = {
    method: 'POST',
    body: { message: {
      call: { id: 'test-call-1' },
      toolCallList: [{ id: 'tc-1', function: { arguments: JSON.stringify({
        stage: 'active_investor', strategy: 'passive_investing', deal_count: '24',
        specific_need: 'access to more deals'
      }) } }]
    } }
  };
  let out = null;
  const res = { status() { return this; }, json(o) { out = o; return this; } };
  const realErr = console.error, realLog = console.log;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  try { await handler(req, res); }
  finally { global.fetch = realFetch; console.error = realErr; console.log = realLog; }
  const full = out.results[0].result;
  const i = full.indexOf(' [META:');
  return { text: full.slice(0, i), meta: JSON.parse(full.slice(i + 7, -1)), writes, logs };
}
const withoutAssessmentKeys = (m) => {
  const { archetype_key, entry_phase_order, canonical_intent, ...rest } = m.tool_args;
  return { ...m, tool_args: rest };
};

let freshN = 0;
for (const [label, rules] of [['matched-rule path', [CATCH_ALL_RULE]], ['absolute fallback path', []]]) {
  // Fresh module instance per scenario so the module-level ref cache starts
  // empty. Failure runs first: the cache resets on failure, so the success
  // run reloads the refs through the stubbed fetch.
  const { default: freshHandler } = await import(`../api/intake.js?fresh=${++freshN}`);
  const fail = await runHandler(freshHandler, { refsFail: true, rules });
  const ok = await runHandler(freshHandler, { refsFail: false, rules });

  check(`e ${label}: still a routing response`, fail.meta.action, v => v === 'getResourceStack');
  check(`e ${label}: tool_args has no assessment keys`, fail.meta.tool_args,
    v => !('archetype_key' in v) && !('entry_phase_order' in v) && !('canonical_intent' in v));
  check(`e ${label}: no _assessment persisted`, fail.writes, w => w.length === 1 && !('_assessment' in w[0].state));
  check(`e ${label}: error logged, not thrown`, fail.logs, l => l.some(x => x.startsWith('ASSESSMENT error | call test-call-1 | refs down')));
  check(`e ${label}: spoken instruction identical to success run`, [fail.text, ok.text], v => v[0] === v[1]);
  check(`e ${label}: META identical to success run minus the 3 new keys`,
    [fail.meta, withoutAssessmentKeys(ok.meta)], v => JSON.stringify(v[0]) === JSON.stringify(v[1]));

  check(`e ${label} (success): tool_args gains A3 / 4 / ACQUIRE`, ok.meta.tool_args,
    v => v.archetype_key === 'A3' && v.entry_phase_order === 4 && v.canonical_intent === 'ACQUIRE');
  check(`e ${label} (success): _assessment persisted, not a CACHE_DIM`, ok.writes,
    w => w.length === 1 && w[0].state._assessment?.archetype_key === 'A3');
  check(`e ${label} (success): one ASSESSMENT log line, no em dash`, ok.logs,
    l => { const a = l.filter(x => x.startsWith('ASSESSMENT | call test-call-1 | A3 | intent ACQUIRE | phase 4 | signal stated_stuck_point | ')); return a.length === 1 && !a[0].includes(EM); });
  if (label === 'matched-rule path') {
    const line = ok.logs.find(x => x.startsWith('ASSESSMENT |'));
    console.log(`        log: ${line}`);
  }
}

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(54)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
