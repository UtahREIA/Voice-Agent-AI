/**
 * roadmap-generator.test.js — standalone test harness
 *
 * Runs with:  node api/lib/roadmap-generator.test.js
 *
 * Reference data is inlined from the Supabase seed (stable, read-only tables).
 * No live DB connection required.
 */

import {
  resolveArchetype, detectEntryPhase, setRefs,
  orderPhaseItems, buildRoadmapSummary, createRoadmap,
  dedupeByIdentity,
} from './roadmap-generator.js';

// ---------------------------------------------------------------------------
// INLINE REFERENCE DATA  (mirrors roadmap_archetypes + archetype_phases +
//                         strategy_archetype_map + phase_intent_precedence
//                         as of 2026-08-01)
// ---------------------------------------------------------------------------

const archetypesById = {
  1: { id: 1, archetype_key: 'A1', name: 'Active Deal Operator' },
  2: { id: 2, archetype_key: 'A2', name: 'Commercial / Large Asset' },
  3: { id: 3, archetype_key: 'A3', name: 'Capital Deployer / Passive' },
  4: { id: 4, archetype_key: 'A4', name: 'Capital Raiser / Sponsor' },
  5: { id: 5, archetype_key: 'A5', name: 'Land & Development' },
  6: { id: 6, archetype_key: 'A6', name: 'Paper Strategies' },
  7: { id: 7, archetype_key: 'A7', name: 'Discovery / Not Sure' },
};

const _p = (archetype_id, phase_order, canonical_intent, display_label) =>
  ({ archetype_id, phase_order, canonical_intent, display_label });

const phasesByArchetype = {
  1: [
    _p(1,1,'CLARIFY','Clarify & Commit'),
    _p(1,2,'LEARN','Learn the Model'),
    _p(1,3,'PREPARE','Get Deal-Ready'),
    _p(1,4,'ACQUIRE','Source & Analyze Deals'),
    _p(1,5,'EXECUTE','Execute & Repeat'),
  ],
  2: [
    _p(2,1,'CLARIFY','Clarify & Commit'),
    _p(2,2,'LEARN','Learn the Model & Underwriting'),
    _p(2,3,'PREPARE','Build the Capital Stack & Team'),
    _p(2,4,'ACQUIRE','Source & Underwrite Deals'),
    _p(2,5,'EXECUTE','Acquire & Operate'),
  ],
  3: [
    _p(3,1,'CLARIFY','Clarify Goals & Capital Position'),
    _p(3,2,'LEARN','Learn to Evaluate'),
    _p(3,3,'PREPARE','Build Evaluation Toolkit & Network'),
    _p(3,4,'ACQUIRE','Vet & Select Opportunities'),
    _p(3,5,'EXECUTE','Deploy & Monitor'),
  ],
  4: [
    _p(4,1,'CLARIFY','Clarify Model & Legitimacy Path'),
    _p(4,2,'LEARN','Learn the Raise (Legal, Structure, Compliance)'),
    _p(4,3,'PREPARE','Build the Sponsor Stack'),
    _p(4,4,'ACQUIRE','Build Investor Relationships & Raise'),
    _p(4,5,'EXECUTE','Deploy & Report'),
  ],
  5: [
    _p(5,1,'CLARIFY','Clarify Project Type & Exit'),
    _p(5,2,'LEARN','Learn Entitlement & Feasibility'),
    _p(5,3,'PREPARE','Assemble Capital & Professional Team'),
    _p(5,4,'ACQUIRE','Acquire & Entitle'),
    _p(5,5,'EXECUTE','Build / Exit'),
  ],
  6: [
    _p(6,1,'CLARIFY','Clarify the Instrument & Approach'),
    _p(6,2,'LEARN','Learn the Niche & Jurisdiction'),
    _p(6,3,'PREPARE','Get Specialist Team & Access'),
    _p(6,4,'ACQUIRE','Acquire (Bid / Buy)'),
    _p(6,5,'EXECUTE','Resolve & Exit'),
  ],
  // A7 has only 3 phases — HANDOFF in place of PREPARE/ACQUIRE/EXECUTE
  7: [
    _p(7,1,'CLARIFY','Understand the Person'),
    _p(7,2,'LEARN','Explore & Narrow'),
    _p(7,3,'HANDOFF','Assign & Hand Off'),
  ],
};

const strategyMap = {
  assisted_living:   { strategy:'assisted_living',   default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  brrrr:             { strategy:'brrrr',             default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  buy_and_hold:      { strategy:'buy_and_hold',      default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  commercial:        { strategy:'commercial',        default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate for the deal', notes:'A2 invokes A4 capital-raising as a sub-journey.' },
  creative_financing:{ strategy:'creative_financing',default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  development:       { strategy:'development',       default_archetype_id:5, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV for the project',         notes:'A5 invokes A4.' },
  farm_land:         { strategy:'farm_land',         default_archetype_id:5, promote_to_archetype_id:null, promote_trigger:null, notes:'Land play; may terminate at ACQUIRE.' },
  fix_and_flip:      { strategy:'fix_and_flip',      default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  hotel:             { strategy:'hotel',             default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  house_hacking:     { strategy:'house_hacking',     default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  industrial:        { strategy:'industrial',        default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  land_entitlement:  { strategy:'land_entitlement',  default_archetype_id:5, promote_to_archetype_id:null, promote_trigger:null, notes:'Land play; may terminate at ACQUIRE.' },
  mid_term_coliving: { strategy:'mid_term_coliving', default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  mobile_home:       { strategy:'mobile_home',       default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  multi_family:      { strategy:'multi_family',      default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  not_sure:          { strategy:'not_sure',          default_archetype_id:7, promote_to_archetype_id:null, promote_trigger:null, notes:'Discovery entry archetype.' },
  notes_lending:     { strategy:'notes_lending',     default_archetype_id:6, promote_to_archetype_id:3, promote_trigger:'passive/performing-notes signal (money, no time, buying for yield)', notes:'Default A6; promote to A3 on strong passive signal.' },
  out_of_state:      { strategy:'out_of_state',      default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  passive_investing:  { strategy:'passive_investing',  default_archetype_id:3, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  raising_capital:   { strategy:'raising_capital',   default_archetype_id:4, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  retail:            { strategy:'retail',            default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  rv_parks:          { strategy:'rv_parks',          default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  self_storage:      { strategy:'self_storage',      default_archetype_id:2, promote_to_archetype_id:4, promote_trigger:'needs to raise capital / JV / syndicate',            notes:'A2 invokes A4.' },
  short_term_rental: { strategy:'short_term_rental', default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
  syndication:       { strategy:'syndication',       default_archetype_id:3, promote_to_archetype_id:4, promote_trigger:'caller is the SPONSOR / GP (raising a fund, putting the deal together)', notes:'Default LP/passive (A3); promote to A4 on clear sponsor signal.' },
  tax_deeds_liens:   { strategy:'tax_deeds_liens',   default_archetype_id:6, promote_to_archetype_id:1, promote_trigger:'foreclosed and took possession -> needs rehab/disposition', notes:'A6 EXECUTE branch (b) invokes A1 operator content.' },
  wholesale:         { strategy:'wholesale',         default_archetype_id:1, promote_to_archetype_id:null, promote_trigger:null, notes:null },
};

// Inline phase_intent_precedence (confirmed from DB 2026-08-01)
const intentPrecedence = [
  { canonical_intent: 'ACQUIRE',  resource_type: 'tool',      ord: 1 },
  { canonical_intent: 'ACQUIRE',  resource_type: 'vendor',    ord: 2 },
  { canonical_intent: 'ACQUIRE',  resource_type: 'education', ord: 3 },
  { canonical_intent: 'CLARIFY',  resource_type: 'education', ord: 1 },
  { canonical_intent: 'CLARIFY',  resource_type: 'mentor',    ord: 2 },
  { canonical_intent: 'EXECUTE',  resource_type: 'vendor',    ord: 1 },
  { canonical_intent: 'EXECUTE',  resource_type: 'tool',      ord: 2 },
  { canonical_intent: 'HANDOFF',  resource_type: 'mentor',    ord: 1 },
  { canonical_intent: 'LEARN',    resource_type: 'education', ord: 1 },
  { canonical_intent: 'LEARN',    resource_type: 'mentor',    ord: 2 },
  { canonical_intent: 'LEARN',    resource_type: 'tool',      ord: 3 },
  { canonical_intent: 'PREPARE',  resource_type: 'tool',      ord: 1 },
  { canonical_intent: 'PREPARE',  resource_type: 'vendor',    ord: 2 },
  { canonical_intent: 'PREPARE',  resource_type: 'education', ord: 3 },
];

const REFS = { archetypesById, strategyMap, phasesByArchetype, intentPrecedence };

// ---------------------------------------------------------------------------
// MINIMAL TEST HARNESS
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(label, actual, expectFn) {
  try {
    const ok = expectFn(actual);
    if (ok) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.log(`  FAIL  ${label}`);
      console.log(`        got: ${JSON.stringify(actual)}`);
      failed++;
    }
  } catch (e) {
    console.log(`  FAIL  ${label} [threw: ${e.message}]`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// TESTS — resolveArchetype
// ---------------------------------------------------------------------------

setRefs(REFS);
console.log('\n── resolveArchetype ──────────────────────────────────────');

check('fix_and_flip → A1',
  resolveArchetype({ strategy: 'fix_and_flip', signals: {} }),
  r => r.archetype_key === 'A1' && r.was_promoted === false);

check('commercial → A2 (NOT promoted even with promote_to:4)',
  resolveArchetype({ strategy: 'commercial', signals: {} }),
  r => r.archetype_key === 'A2' && r.was_promoted === false);

check('notes_lending, no passive signal → A6 (default)',
  resolveArchetype({ strategy: 'notes_lending', signals: {} }),
  r => r.archetype_key === 'A6' && r.was_promoted === false);

check('notes_lending + is_passive:true → A3 (promoted)',
  resolveArchetype({ strategy: 'notes_lending', signals: { is_passive: true } }),
  r => r.archetype_key === 'A3' && r.was_promoted === true);

check('notes_lending + buying_for_yield string signal → A3 (promoted)',
  resolveArchetype({ strategy: 'notes_lending', signals: { motivation: 'passive yield income' } }),
  r => r.archetype_key === 'A3' && r.was_promoted === true);

check('syndication, no sponsor signal → A3 (default)',
  resolveArchetype({ strategy: 'syndication', signals: {} }),
  r => r.archetype_key === 'A3' && r.was_promoted === false);

check('syndication + is_sponsor:true → A4 (promoted)',
  resolveArchetype({ strategy: 'syndication', signals: { is_sponsor: true } }),
  r => r.archetype_key === 'A4' && r.was_promoted === true);

check('syndication + role:gp string signal → A4 (promoted)',
  resolveArchetype({ strategy: 'syndication', signals: { role: 'raising_fund for investors' } }),
  r => r.archetype_key === 'A4' && r.was_promoted === true);

check('not_sure → A7',
  resolveArchetype({ strategy: 'not_sure', signals: {} }),
  r => r.archetype_key === 'A7');

check('unknown strategy → A7 fallback',
  resolveArchetype({ strategy: 'crypto_flipping', signals: {} }),
  r => r.archetype_key === 'A7' && r.was_promoted === false);

check('mentoring_others → contributor_handoff sentinel',
  resolveArchetype({ strategy: 'mentoring_others', signals: {} }),
  r => r.archetype === null && r.route === 'contributor_handoff');

check('tax_deeds_liens → A6 (invocation, NOT promoted to A1)',
  resolveArchetype({ strategy: 'tax_deeds_liens', signals: {} }),
  r => r.archetype_key === 'A6' && r.was_promoted === false);

// ---------------------------------------------------------------------------
// TESTS — detectEntryPhase
// ---------------------------------------------------------------------------

console.log('\n── detectEntryPhase ──────────────────────────────────────');

check('stated stuck-point "can\'t get funding" → PREPARE (overrides everything)',
  detectEntryPhase(1, { stage: 'exploring__new', deal_count: 0, stated_stuck_point: "can't get funding" }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'stated_stuck_point');

check('stated stuck-point "can\'t find deals" → ACQUIRE',
  detectEntryPhase(1, { stated_stuck_point: "I can't find deals to source" }),
  r => r.canonical_intent === 'ACQUIRE' && r.signal_used === 'stated_stuck_point');

check('stated stuck-point "I don\'t understand the model" → LEARN',
  detectEntryPhase(1, { stated_stuck_point: "I don't understand the model" }),
  r => r.canonical_intent === 'LEARN' && r.signal_used === 'stated_stuck_point');

check('A1 fix_and_flip deal_count 8 → PREPARE (past threshold of 5)',
  detectEntryPhase(1, { deal_count: 8 }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'deal_count');

check('A1 fix_and_flip deal_count 1 → LEARN (below threshold of 5)',
  detectEntryPhase(1, { deal_count: 1 }),
  r => r.canonical_intent === 'LEARN' && r.signal_used === 'deal_count');

check('A1 fix_and_flip deal_count 5 → PREPARE (at threshold, inclusive)',
  detectEntryPhase(1, { deal_count: 5 }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'deal_count');

check('A2 commercial deal_count 3 → PREPARE (commercial threshold is 3)',
  detectEntryPhase(2, { deal_count: 3 }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'deal_count');

check('A2 commercial deal_count 2 → LEARN (below commercial threshold of 3)',
  detectEntryPhase(2, { deal_count: 2 }),
  r => r.canonical_intent === 'LEARN' && r.signal_used === 'deal_count');

check('High education_history + empty already_tried, null deal_count → PREPARE (educated-but-stuck)',
  detectEntryPhase(1, { deal_count: null, education_history: 'read 10 books, took 2 courses', already_tried: '' }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'knowledge_vs_action_gap');

check('Some already_tried, null deal_count → LEARN',
  detectEntryPhase(1, { deal_count: null, education_history: '', already_tried: 'wrote a few offers' }),
  r => r.canonical_intent === 'LEARN' && r.signal_used === 'knowledge_vs_action_gap');

check('Brand-new (no signals) → CLARIFY or LEARN (default)',
  detectEntryPhase(1, {}),
  r => r.canonical_intent === 'CLARIFY' || r.canonical_intent === 'LEARN');

check('Stage active_investor (long form), no deal_count → PREPARE (stage fallback)',
  detectEntryPhase(1, { stage: 'active_investor', deal_count: null }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'stage_fallback');

check('Stage active (already short form), no deal_count → PREPARE (deliberate translation, not substring luck)',
  detectEntryPhase(1, { stage: 'active', deal_count: null }),
  r => r.canonical_intent === 'PREPARE' && r.signal_used === 'stage_fallback');

// A7 has only 3 phases (CLARIFY=1, LEARN=2, HANDOFF=3). No PREPARE/ACQUIRE/EXECUTE.
// Even with a high deal_count or active stage, phase_order must stay <= 3.

check('A7 deal_count 20 → phase_order never exceeds 3',
  detectEntryPhase(7, { deal_count: 20 }),
  r => r.entry_phase_order <= 3);

check('A7 stage veteran → phase_order never exceeds 3',
  detectEntryPhase(7, { stage: 'veteran__operator', deal_count: null }),
  r => r.entry_phase_order <= 3);

check('A7 brand-new → CLARIFY at phase_order 1',
  detectEntryPhase(7, {}),
  r => r.canonical_intent === 'CLARIFY' && r.entry_phase_order === 1);

// A7: stated stuck-point maps to PREPARE which doesn't exist in A7 — should gracefully
// fall through to the next signal and still return a valid phase_order <= 3.
check('A7 stuck-point "funding" (no PREPARE in A7) → falls through, phase_order <= 3',
  detectEntryPhase(7, { stated_stuck_point: 'funding' }),
  r => r.entry_phase_order <= 3);

// ---------------------------------------------------------------------------
// TESTS — orderPhaseItems  (pure function, no DB)
// ---------------------------------------------------------------------------

console.log('\n── orderPhaseItems ───────────────────────────────────────');

const LEARN_PREC = [
  { resource_type: 'education', ord: 1 },
  { resource_type: 'mentor',    ord: 2 },
  { resource_type: 'tool',      ord: 3 },
];

const makeItem = (resource_type, display_name, within_type_priority) =>
  ({ resource_type, display_name, within_type_priority, source_table: 'test', source_ref: 'x', is_cross_cutting: false, status: 'not_started', status_source: 'system', canonical_intent: 'LEARN' });

check('LEARN: education(ord 1) precedes tool(ord 3)',
  orderPhaseItems(
    { education: [makeItem('education','Course A', 1)], tool: [makeItem('tool','DealMachine', 1)] },
    LEARN_PREC,
  ),
  items => items[0].resource_type === 'education' && items[items.length - 1].resource_type === 'tool');

check('LEARN: mentor(ord 2) between education and tool',
  orderPhaseItems(
    { education: [makeItem('education','Course A', 1)], mentor: [makeItem('mentor','Jane', 1)], tool: [makeItem('tool','DealMachine', 1)] },
    LEARN_PREC,
  ),
  items => items[0].resource_type === 'education' && items[1].resource_type === 'mentor' && items[2].resource_type === 'tool');

const EXEC_PREC = [
  { resource_type: 'vendor', ord: 1 },
  { resource_type: 'tool',   ord: 2 },
];

check('EXECUTE: vendor(ord 1) precedes tool(ord 2)',
  orderPhaseItems(
    { vendor: [makeItem('vendor','Contractor', 1)], tool: [makeItem('tool','ProjectMgmt', 1)] },
    EXEC_PREC,
  ),
  items => items[0].resource_type === 'vendor' && items[1].resource_type === 'tool');

check('within-type: lower within_type_priority comes first',
  orderPhaseItems(
    { education: [
        makeItem('education','Track B', 2),
        makeItem('education','Track A', 1),
    ]},
    [{ resource_type: 'education', ord: 1 }],
  ),
  items => items[0].display_name === 'Track A' && items[1].display_name === 'Track B');

check('missing resource_type produces empty slot (no crash)',
  orderPhaseItems({}, LEARN_PREC),
  items => items.length === 0);

// ---------------------------------------------------------------------------
// TESTS — buildRoadmapSummary  (pure function, no DB)
// ---------------------------------------------------------------------------

console.log('\n── buildRoadmapSummary ───────────────────────────────────');

const A1_PHASES = phasesByArchetype[1];

check('5 phases from entry=1: names first 3, adds "a couple more after that"',
  buildRoadmapSummary(
    A1_PHASES[0],  // CLARIFY
    A1_PHASES,
    [],
  ),
  s => s.includes('Clarify & Commit') && s.includes('and a couple more after that'));

check('3 phases from entry=3: names all 3, no ellipsis',
  buildRoadmapSummary(
    A1_PHASES[2],  // PREPARE (entry at order 3)
    A1_PHASES,
    [],
  ),
  s => s.includes('Get Deal-Ready') && s.includes('Source & Analyze Deals') && s.includes('Execute & Repeat') && !s.includes('couple more'));

check('first item display_name appears in summary when items present',
  buildRoadmapSummary(
    A1_PHASES[0],
    A1_PHASES,
    [{ display_name: 'Fix & Flip 101' }],
  ),
  s => s.includes('Fix & Flip 101'));

check('no items → fallback "connect you with the right starting point"',
  buildRoadmapSummary(A1_PHASES[0], A1_PHASES, []),
  s => s.includes("connect you"));

check('A7 3 phases (<=4): names all 3, no ellipsis',
  buildRoadmapSummary(
    phasesByArchetype[7][0],  // CLARIFY
    phasesByArchetype[7],
    [],
  ),
  s => s.includes('Understand the Person') && s.includes('Assign & Hand Off') && !s.includes('couple more'));

// ---------------------------------------------------------------------------
// TESTS — dedupeByIdentity  (pure function, no DB)
// ---------------------------------------------------------------------------

console.log('\n── dedupeByIdentity ──────────────────────────────────────');

const makeCandidate = (source_ref, within_type_priority, _specificity = 0) =>
  ({ source_ref, display_name: `Item-${source_ref}`, within_type_priority, _specificity });

check('same source_ref 3× at priorities [1,1,2] → 1 item at priority 1',
  dedupeByIdentity([
    makeCandidate('tool-abc', 1),
    makeCandidate('tool-abc', 1),
    makeCandidate('tool-abc', 2),
  ]),
  result => result.length === 1 && result[0].source_ref === 'tool-abc' && result[0].within_type_priority === 1);

check('two different source_refs → both survive (no over-collapse)',
  dedupeByIdentity([
    makeCandidate('tool-abc', 1),
    makeCandidate('tool-xyz', 2),
  ]),
  result => result.length === 2);

check('priority tie: specific (_specificity 0) beats generic (_specificity 1) even when generic is first',
  dedupeByIdentity([
    { source_ref: 'tool-abc', display_name: 'Tool A', within_type_priority: 1, _specificity: 1, source_table: 'generic-row' },
    { source_ref: 'tool-abc', display_name: 'Tool A', within_type_priority: 1, _specificity: 0, source_table: 'specific-row' },
  ]),
  result => result.length === 1 && result[0].source_table === 'specific-row');

check('_specificity field is stripped from returned items',
  dedupeByIdentity([makeCandidate('tool-abc', 1, 0)]),
  result => result[0]._specificity === undefined);

// ---------------------------------------------------------------------------
// TESTS — createRoadmap  (dryRun=true, no DB writes or matrix fetches)
// ---------------------------------------------------------------------------

console.log('\n── createRoadmap (dryRun) ────────────────────────────────');

// Case A: fix_and_flip, getting_started, deal_count null → CLARIFY (phase 1, A1)
{
  const result = await createRoadmap(
    { strategy: 'fix_and_flip', stage: 'getting_started', deal_count: null, contact_id: 'test-001', phone: '8015551234' },
    { url: 'http://placeholder.test', key: 'test-key' },
    { dryRun: true },
  );

  check('dry-run A [fix_and_flip/getting_started]: archetype_key A1',
    result, r => r.archetype_key === 'A1');

  check('dry-run A: entry_phase_order 1 (CLARIFY)',
    result, r => r.entry_phase_order === 1);

  check('dry-run A: 5 phase descriptors created',
    result, r => r._debug.phaseDescs.length === 5);

  check('dry-run A: entry phase status=current',
    result, r => r._debug.phaseDescs[0].status === 'current');

  check('dry-run A: all non-entry phases status=shell (none completed since entry=1)',
    result, r => r._debug.phaseDescs.slice(1).every(p => p.status === 'shell'));

  check('dry-run A: summary includes Clarify display_label',
    result, r => r.summary.includes('Clarify & Commit'));

  check('dry-run A: summary is a non-empty string',
    result, r => typeof r.summary === 'string' && r.summary.length > 10);
}

// Case B: fix_and_flip, deal_count 8 → PREPARE (phase 3, A1) — 2 phases completed
{
  const result = await createRoadmap(
    { strategy: 'fix_and_flip', deal_count: 8 },
    { url: 'http://placeholder.test', key: 'test-key' },
    { dryRun: true },
  );

  check('dry-run B [deal_count 8]: entry_phase_order 3 (PREPARE)',
    result, r => r.entry_phase_order === 3);

  check('dry-run B: 2 phases marked completed (orders 1 and 2)',
    result, r => r._debug.phaseDescs.filter(p => p.status === 'completed').length === 2);

  check('dry-run B: entry phase (order 3) status=current',
    result, r => r._debug.phaseDescs.find(p => p.phase_order === 3)?.status === 'current');

  check('dry-run B: phases 4,5 status=shell',
    result, r => r._debug.phaseDescs.filter(p => p.status === 'shell').length === 2);

  check('dry-run B: summary includes Get Deal-Ready (PREPARE display_label)',
    result, r => r.summary.includes('Get Deal-Ready'));
}

// Case C: contributor_handoff sentinel
{
  const result = await createRoadmap(
    { strategy: 'mentoring_others' },
    { url: 'http://placeholder.test', key: 'test-key' },
    { dryRun: true },
  );

  check('dry-run C: mentoring_others → contributor_handoff route',
    result, r => r.route === 'contributor_handoff' && r.roadmap_id === null);
}

// ---------------------------------------------------------------------------
// TESTS — createRoadmap (live write path): partial-write guard
//
// Reproduces the bug seen on a real call: caller_roadmaps parent inserted,
// then roadmap_phases insert fails (container froze mid-sequence under
// fire-and-forget on Vercel). Asserts createRoadmap now self-cleans: the
// parent it just inserted gets deleted, and the failure still propagates
// (so createRoadmapAlongside's caller sees it and logs it, per commit 5ae5fff).
// ---------------------------------------------------------------------------

console.log('\n── createRoadmap (live write): partial-write guard ──────');

{
  const FAKE_ROADMAP_ID = 'roadmap-under-test-123';
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    calls.push({ url: u, method });

    if (u.includes('/caller_roadmaps') && method === 'POST') {
      return { json: async () => [{ id: FAKE_ROADMAP_ID }] };
    }
    if (u.includes('/roadmap_phases') && method === 'POST') {
      // Simulate the observed failure: phases insert never lands.
      return { ok: false, status: 500, text: async () => 'simulated roadmap_phases insert failure' };
    }
    if (u.includes('/caller_roadmaps') && method === 'DELETE') {
      return { ok: true, status: 204 };
    }
    return { json: async () => [] };
  };

  let threw = false;
  let thrownMessage = '';
  try {
    await createRoadmap(
      { strategy: 'fix_and_flip', stage: 'getting_started', deal_count: 0 },
      { url: 'http://placeholder.test', key: 'test-key' },
      // no dryRun — exercises the real write path with the stubbed fetch above
    );
  } catch (e) {
    threw = true;
    thrownMessage = e.message;
  }

  global.fetch = originalFetch;

  const deleteCalls = calls.filter(c => c.method === 'DELETE' && c.url.includes('/caller_roadmaps'));
  const deletedCorrectId = deleteCalls.some(c => c.url.includes(`id=eq.${FAKE_ROADMAP_ID}`));

  check('partial-write: roadmap_phases failure propagates as a thrown error',
    threw, ok => ok === true);

  check('partial-write: error message reflects the roadmap_phases failure',
    thrownMessage, msg => msg.includes('roadmap_phases insert failed'));

  check('partial-write: exactly one DELETE issued against caller_roadmaps for the orphaned parent',
    deleteCalls, arr => arr.length === 1);

  check('partial-write: the DELETE targets the exact roadmap_id that was just inserted',
    deletedCorrectId, ok => ok === true);

  check('partial-write: no roadmap_items insert was attempted after the phases failure',
    calls, arr => !arr.some(c => c.url.includes('/roadmap_items') && c.method === 'POST'));
}

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(54)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
