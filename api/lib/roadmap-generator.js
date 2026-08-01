/**
 * roadmap-generator.js — Roadmap engine Stage 2a/2b: pure decision logic
 *
 * Exports two deterministic functions (no DB writes, no network side effects
 * beyond reading the three reference tables via loadRefs/setRefs):
 *   resolveArchetype(diagnosis)        → which archetype the caller belongs to
 *   detectEntryPhase(archetype_id, diagnosis) → which phase to start on
 *
 * Usage pattern (production handler):
 *   const refs = await loadRefs(SUPABASE_URL, SUPABASE_SERVICE_KEY);
 *   setRefs(refs);
 *   const arc = resolveArchetype(diagnosis);
 *   const entry = detectEntryPhase(arc.archetype_id, diagnosis);
 *
 * Usage pattern (tests):
 *   setRefs(inlineTestData);
 *   const arc = resolveArchetype(diagnosis);
 */

// ---------------------------------------------------------------------------
// NAMED CONSTANTS — all tuning knobs live here
// ---------------------------------------------------------------------------

/** Minimum deal count before a caller is considered "past foundational LEARN". */
const DEAL_COUNT_THRESHOLD_STANDARD = 5;

/** Lower threshold for commercial-class archetypes (fewer deals to progress). */
const DEAL_COUNT_THRESHOLD_COMMERCIAL = 3;

/** Archetype IDs that use the lower commercial threshold. */
const COMMERCIAL_ARCHETYPE_IDS = new Set([2]); // A2 — Commercial / Large Asset

/**
 * Strategies that perform a TRUE archetype REASSIGNMENT on promotion.
 *
 * All other promote_to rows in strategy_archetype_map are SUB-JOURNEY
 * INVOCATIONS (e.g. A2→A4, A5→A4, A6→A1 — the notes say "invokes").
 * Invocations affect phase-level content, not archetype assignment.
 * resolveArchetype() ignores promote_to for any strategy NOT in this set.
 */
const REASSIGNMENT_STRATEGIES = new Set(['notes_lending', 'syndication']);

/**
 * Signal keywords that indicate a passive/performing-notes orientation.
 * Checked against the concatenated keys+values of the signals object
 * (truthy entries only) for the notes_lending promotion decision.
 */
const PASSIVE_SIGNAL_KEYWORDS = [
  'passive', 'performing', 'yield', 'income', 'no_time', 'buying_for_yield',
];

/**
 * Signal keywords that indicate a sponsor/GP orientation.
 * Checked for the syndication promotion decision.
 */
const SPONSOR_SIGNAL_KEYWORDS = [
  'sponsor', 'gp', 'general_partner', 'raising', 'raising_fund',
  'putting_the_deal', 'syndicating',
];

/**
 * Maps stuck-point keywords (from stated_stuck_point) to canonical_intent.
 * First matching keyword wins (most-specific first within each bucket).
 */
const STUCK_POINT_KEYWORD_MAP = [
  { keywords: ['funding', 'capital', 'financing', 'lender', 'money'],    intent: 'PREPARE'  },
  { keywords: ['deal', 'deals', 'sourcing', 'pipeline', 'find', 'find'], intent: 'ACQUIRE'  },
  { keywords: ['closing', 'contractor', 'execution', 'execute', 'manage'], intent: 'EXECUTE' },
  { keywords: ['understand', 'learning', 'education', 'knowledge', 'learn'], intent: 'LEARN' },
  { keywords: ['which strategy', 'not sure', 'direction', 'what strategy'], intent: 'CLARIFY' },
];

/** Archetype used when a strategy is entirely unknown. */
const DISCOVERY_ARCHETYPE_ID  = 7;
const DISCOVERY_ARCHETYPE_KEY = 'A7';

// ---------------------------------------------------------------------------
// STAGE 2c/2d CONSTANTS
// ---------------------------------------------------------------------------

/** Translate long stage (Vapi/diagnosis) → short stage (education_routing_matrix, tools_routing_matrix). */
const LONG_TO_SHORT_STAGE = {
  exploring__new:       'exploring',
  getting_started:      'getting_started',
  active_investor:      'active',
  experienced_investor: 'experienced',
  veteran__operator:    'veteran',
  exploring:            'exploring',
  active:               'active',
  experienced:          'experienced',
  veteran:              'veteran',
};

/**
 * Commercial sub-strategies collapse to 'commercial' in education_routing_matrix
 * (confirmed: industrial/retail/multi_family/etc. have no own rows in that table).
 */
const EDUCATION_STRATEGY_MAP = {
  industrial:      'commercial',
  retail:          'commercial',
  multi_family:    'commercial',
  hotel:           'commercial',
  assisted_living: 'commercial',
  self_storage:    'commercial',
  mobile_home:     'commercial',
  rv_parks:        'commercial',
};

/**
 * investor_need values to query from vendor_routing_matrix for each canonical_intent
 * that has resource_type='vendor' in phase_intent_precedence (PREPARE, ACQUIRE, EXECUTE).
 */
const INTENT_TO_VENDOR_NEEDS = {
  PREPARE: ['funding', 'legal', 'accounting', 'insurance', 'team'],
  ACQUIRE: ['deals', 'market_data', 'calculators', 'inspection', 'appraisal', 'title'],
  EXECUTE: ['contractors', 'operations', 'management', 'accountability', 'networking'],
};

/**
 * Strategy → topic slugs for ghl_educators_mentors.educational_topics (topic vocabulary).
 * Empty array = skip mentor fetch for this strategy.
 * Both syndication topic spellings exist in DB — list both.
 */
const STRATEGY_TO_MENTOR_TOPICS = {
  fix_and_flip:       ['fix__flip'],
  buy_and_hold:       ['buy__hold__rentals'],
  wholesale:          ['wholesaling'],
  brrrr:              ['brrrr'],
  creative_financing: ['creative_financing'],
  raising_capital:    ['raising_capital'],
  development:        ['development'],
  notes_lending:      ['notes__lending'],
  land_entitlement:   ['land__entitlement'],
  short_term_rental:  ['short_term_rental'],
  mid_term_coliving:  ['midterm__coliving_rentals'],
  tax_deeds_liens:    ['tax_deeds_and_liens'],
  house_hacking:      ['house_hacking'],
  passive_investing:  ['passive_investments'],
  syndication:        ['syndications__funds', 'syndication__funds'],
  commercial:  ['commercial'], industrial:      ['commercial'],
  retail:      ['commercial'], multi_family:    ['commercial'],
  self_storage:['commercial'], mobile_home:     ['commercial'],
  hotel:       ['commercial'], assisted_living: ['commercial'],
  farm_land:   ['commercial'], rv_parks:        ['commercial'],
  out_of_state: [], tax_optimization: [], mentoring_others: [], not_sure: [],
};

/** Name at most this many phases individually in the spoken summary. */
const MAX_PHASES_NAMED_IN_SUMMARY = 3;

/** Max resources per resource_type per phase (applied per fetch). */
const MAX_ITEMS_PER_TYPE = 3;

// ---------------------------------------------------------------------------
// MODULE-LEVEL REFS CACHE
// ---------------------------------------------------------------------------

let _refs = null;

/**
 * Inject pre-built reference data (for tests or pre-fetched production cache).
 * @param {{ archetypesById, strategyMap, phasesByArchetype, intentPrecedence? }} refs
 */
export function setRefs(refs) {
  _refs = refs;
}

// ---------------------------------------------------------------------------
// PUBLIC PURE FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Resolve which archetype a caller belongs to, given their diagnosis.
 *
 * @param {{ strategy: string, stage?: string, signals?: object }} diagnosis
 * @returns {{ archetype_id, archetype_key, was_promoted, reason }
 *          | { archetype: null, route: 'contributor_handoff' }}
 */
export function resolveArchetype(diagnosis) {
  if (!_refs) throw new Error('roadmap-generator: call setRefs() or loadRefs() before resolveArchetype()');
  const { archetypesById, strategyMap } = _refs;
  const { strategy, signals = {} } = diagnosis;

  // mentoring_others is a contributor path, not a roadmap strategy.
  if (strategy === 'mentoring_others') {
    return { archetype: null, route: 'contributor_handoff' };
  }

  const row = strategyMap[strategy];
  if (!row) {
    return {
      archetype_id:  DISCOVERY_ARCHETYPE_ID,
      archetype_key: DISCOVERY_ARCHETYPE_KEY,
      was_promoted:  false,
      reason:        `Unknown strategy '${strategy}' falls back to A7 Discovery`,
    };
  }

  const defaultId  = row.default_archetype_id;
  const promoteId  = row.promote_to_archetype_id;
  const signalStr  = _signalsToString(signals);

  // Only attempt a TRUE reassignment for the two designated strategies.
  // A2/A5/A6 rows that have promote_to are sub-journey invocations handled
  // at the phase level — do not reassign the archetype here.
  if (promoteId && REASSIGNMENT_STRATEGIES.has(strategy)) {
    let shouldPromote = false;
    let promoteReason = '';

    if (strategy === 'notes_lending') {
      shouldPromote = PASSIVE_SIGNAL_KEYWORDS.some(kw => signalStr.includes(kw));
      if (shouldPromote) promoteReason = 'passive/performing-notes signal -> notes_lending promotes from A6 to A3';
    } else if (strategy === 'syndication') {
      shouldPromote = SPONSOR_SIGNAL_KEYWORDS.some(kw => signalStr.includes(kw));
      if (shouldPromote) promoteReason = 'sponsor/GP signal -> syndication promotes from A3 to A4';
    }

    if (shouldPromote) {
      const promoted = archetypesById[promoteId];
      return {
        archetype_id:  promoteId,
        archetype_key: promoted.archetype_key,
        was_promoted:  true,
        reason:        promoteReason,
      };
    }
  }

  const archetype = archetypesById[defaultId];
  return {
    archetype_id:  defaultId,
    archetype_key: archetype.archetype_key,
    was_promoted:  false,
    reason:        `Default archetype for strategy '${strategy}'`,
  };
}

/**
 * Detect which phase a caller should enter, given their archetype and diagnosis.
 * Entry is PROVISIONAL — the signal hierarchy from strongest to weakest is:
 *   1. stated_stuck_point  (caller named their problem explicitly)
 *   2. deal_count          (execution volume vs threshold)
 *   3. knowledge-vs-action gap (education_history vs already_tried, no deal_count)
 *   4. stage fallback      (coarsest — only when nothing better is available)
 *   5. default             (start at CLARIFY or the archetype's first phase)
 *
 * @param {number} archetype_id
 * @param {{ stage?, deal_count?, education_history?, already_tried?, stated_stuck_point? }} diagnosis
 * @returns {{ entry_phase_order, canonical_intent, reason, signal_used }}
 */
export function detectEntryPhase(archetype_id, diagnosis) {
  if (!_refs) throw new Error('roadmap-generator: call setRefs() or loadRefs() before detectEntryPhase()');
  const { phasesByArchetype } = _refs;
  const {
    stage             = '',
    deal_count        = null,
    education_history = '',
    already_tried     = '',
    stated_stuck_point = '',
  } = diagnosis;

  const phases      = phasesByArchetype[archetype_id] || [];
  const maxOrder    = phases.length;

  function phaseByIntent(intent) {
    return phases.find(p => p.canonical_intent === intent) || null;
  }

  function respond(phase, reason, signal_used) {
    const order = Math.min(Math.max(1, phase.phase_order), maxOrder);
    return { entry_phase_order: order, canonical_intent: phase.canonical_intent, reason, signal_used };
  }

  // --- Signal 1: STATED STUCK-POINT ---
  if (stated_stuck_point) {
    const intent = _stuckPointToIntent(stated_stuck_point);
    if (intent) {
      const phase = phaseByIntent(intent);
      if (phase) {
        return respond(phase,
          `Stated stuck-point '${stated_stuck_point}' maps to ${intent}`,
          'stated_stuck_point');
      }
      // Intent not available in this archetype's phases — fall through gracefully.
    }
  }

  // --- Signal 2: EXECUTION VOLUME (deal count) ---
  const dealCount = (deal_count !== null && deal_count !== undefined) ? Number(deal_count) : null;
  if (dealCount !== null && !isNaN(dealCount)) {
    const threshold = COMMERCIAL_ARCHETYPE_IDS.has(archetype_id)
      ? DEAL_COUNT_THRESHOLD_COMMERCIAL
      : DEAL_COUNT_THRESHOLD_STANDARD;

    if (dealCount >= threshold) {
      const prep = phaseByIntent('PREPARE');
      if (prep) return respond(prep,
        `deal_count ${dealCount} >= threshold ${threshold} — past foundational LEARN, enter at PREPARE`,
        'deal_count');
      // No PREPARE in this archetype (e.g. A7 only has CLARIFY/LEARN/HANDOFF) — fall through.
    } else {
      const learn = phaseByIntent('LEARN');
      if (learn) return respond(learn,
        `deal_count ${dealCount} < threshold ${threshold} — LEARN phase still relevant`,
        'deal_count');
    }
  }

  // --- Signal 3: KNOWLEDGE-VS-ACTION GAP (only when deal_count is unknown) ---
  if (dealCount === null) {
    const hasKnowledge = Boolean(education_history && education_history !== 'none');
    const hasAction    = Boolean(already_tried   && already_tried    !== 'none');

    if (hasKnowledge && !hasAction) {
      const prep = phaseByIntent('PREPARE');
      if (prep) return respond(prep,
        'High knowledge + no action: educated-but-stuck, enter at PREPARE',
        'knowledge_vs_action_gap');
    }
    if (hasAction) {
      const learn = phaseByIntent('LEARN');
      if (learn) return respond(learn,
        'Some prior action — LEARN phase appropriate',
        'knowledge_vs_action_gap');
    }
  }

  // --- Signal 4: STAGE FALLBACK (coarsest) ---
  const stageKey = (stage || '').toLowerCase();
  if (stageKey.includes('active') || stageKey.includes('experienced') || stageKey.includes('veteran')) {
    const prep = phaseByIntent('PREPARE');
    if (prep) return respond(prep,
      `Stage '${stage}' suggests experience — tentatively enter at PREPARE`,
      'stage_fallback');
  }

  // --- Default: CLARIFY or first phase ---
  const clarify = phaseByIntent('CLARIFY');
  if (clarify) return respond(clarify, 'No strong signal — start at CLARIFY', 'default');

  const first = phases[0];
  return first
    ? respond(first, 'No strong signal — defaulting to archetype first phase', 'default')
    : { entry_phase_order: 1, canonical_intent: 'CLARIFY', reason: 'No phases found', signal_used: 'default' };
}

// ---------------------------------------------------------------------------
// SUPABASE REF LOADER
// ---------------------------------------------------------------------------

/**
 * Fetch all three reference tables from Supabase, build lookup maps, and
 * cache them in the module. Returns the refs object.
 *
 * @param {string} supabaseUrl
 * @param {string} supabaseKey  service-role key
 * @returns {Promise<{ archetypesById, strategyMap, phasesByArchetype }>}
 */
export async function loadRefs(supabaseUrl, supabaseKey) {
  const headers = {
    'Content-Type':  'application/json',
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
  };

  const [archetypesRes, phasesRes, strategyRes, precedenceRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/roadmap_archetypes?select=id,archetype_key,name`, { headers }),
    fetch(`${supabaseUrl}/rest/v1/archetype_phases?select=archetype_id,phase_order,canonical_intent,display_label`, { headers }),
    fetch(`${supabaseUrl}/rest/v1/strategy_archetype_map?select=strategy,default_archetype_id,promote_to_archetype_id,promote_trigger,notes`, { headers }),
    fetch(`${supabaseUrl}/rest/v1/phase_intent_precedence?select=canonical_intent,resource_type,ord&order=canonical_intent,ord`, { headers }),
  ]);

  const [archetypes, phases, strategyRows, precedenceRows] = await Promise.all([
    archetypesRes.json(),
    phasesRes.json(),
    strategyRes.json(),
    precedenceRes.json(),
  ]);

  const archetypesById = Object.fromEntries(archetypes.map(a => [a.id, a]));
  const strategyMap    = Object.fromEntries(strategyRows.map(r => [r.strategy, r]));

  const phasesByArchetype = {};
  for (const p of phases) {
    if (!phasesByArchetype[p.archetype_id]) phasesByArchetype[p.archetype_id] = [];
    phasesByArchetype[p.archetype_id].push(p);
  }
  for (const id of Object.keys(phasesByArchetype)) {
    phasesByArchetype[id].sort((a, b) => a.phase_order - b.phase_order);
  }

  const intentPrecedence = Array.isArray(precedenceRows) ? precedenceRows : [];
  const refs = { archetypesById, strategyMap, phasesByArchetype, intentPrecedence };
  _refs = refs;
  return refs;
}

// ---------------------------------------------------------------------------
// PUBLIC PURE FUNCTIONS — Stage 2c/2d: item ordering
// ---------------------------------------------------------------------------

/**
 * Merge resource candidates into an ordered flat array.
 * Cross-type order comes from precedence[].ord; within each type items are
 * sorted ascending by within_type_priority (lower number = higher priority).
 *
 * @param {Record<string, object[]>} candidatesByType  e.g. { 'education': [...], 'mentor': [...] }
 * @param {{ resource_type: string, ord: number }[]}   precedence
 * @returns {object[]} flat ordered array ready for roadmap_items insertion
 */
export function orderPhaseItems(candidatesByType, precedence) {
  const result = [];
  const sorted = [...precedence].sort((a, b) => a.ord - b.ord);
  for (const { resource_type, ord } of sorted) {
    const group = (candidatesByType[resource_type] || [])
      .slice()
      .sort((a, b) => (a.within_type_priority ?? 9999) - (b.within_type_priority ?? 9999));
    for (const item of group) {
      result.push({ ...item, across_type_ord: ord });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PUBLIC PURE FUNCTIONS — Stage 2c/2d: spoken summary
// ---------------------------------------------------------------------------

/**
 * Build Lani's spoken roadmap summary.
 * Names phases from entry forward; if > 4 remain, names the first
 * MAX_PHASES_NAMED_IN_SUMMARY and appends "and a couple more after that".
 *
 * @param {{ phase_order, canonical_intent, display_label }} entryPhase
 * @param {{ phase_order, display_label }[]} allPhases  all archetype phases
 * @param {object[]} items  ordered items from populatePhaseItems (may be empty)
 * @returns {string}
 */
export function buildRoadmapSummary(entryPhase, allPhases, items) {
  const future = [...allPhases]
    .filter(p => p.phase_order >= entryPhase.phase_order)
    .sort((a, b) => a.phase_order - b.phase_order);

  const phaseList = future.length > 4
    ? future.slice(0, MAX_PHASES_NAMED_IN_SUMMARY).map(p => p.display_label).join(', then ')
      + ', and a couple more after that'
    : future.map(p => p.display_label).join(', then ');

  const firstStep = items[0]
    ? `Your first step is ${items[0].display_name}.`
    : "I'll connect you with the right starting point.";

  return `Your roadmap: ${phaseList}. ${firstStep}`;
}

// ---------------------------------------------------------------------------
// PUBLIC ASYNC FUNCTIONS — Stage 2c/2d: matrix population (no writes)
// ---------------------------------------------------------------------------

/**
 * Fetch matching resources for one phase from the four source matrices and
 * return them as an ordered item array. Reads DB; no writes.
 *
 * @param {{ strategy: string, stage: string, db: { url: string, key: string } }} context
 * @param {{ phase_order: number, canonical_intent: string, display_label: string }} phase
 * @returns {Promise<object[]>}
 */
export async function populatePhaseItems(context, phase) {
  if (!_refs) throw new Error('roadmap-generator: setRefs() or loadRefs() required before populatePhaseItems()');

  const { strategy, stage, db } = context;
  const { canonical_intent } = phase;

  const precedence = (_refs.intentPrecedence || [])
    .filter(p => p.canonical_intent === canonical_intent);
  if (precedence.length === 0) return [];

  const shortStage = LONG_TO_SHORT_STAGE[stage] || stage || 'exploring';
  const edStrategy = EDUCATION_STRATEGY_MAP[strategy] || strategy;
  const topics     = STRATEGY_TO_MENTOR_TOPICS[strategy] || [];
  const h = { 'Content-Type': 'application/json', apikey: db.key, Authorization: `Bearer ${db.key}` };

  const candidatesByType = {};

  for (const { resource_type, ord } of precedence) {
    try {
      if (resource_type === 'education') {
        const url = `${db.url}/rest/v1/education_routing_matrix`
          + `?strategy=eq.${encodeURIComponent(edStrategy)}`
          + `&stage=eq.${encodeURIComponent(shortStage)}`
          + `&is_active=eq.true&select=canonical_key,track_name,priority`
          + `&order=priority.asc&limit=${MAX_ITEMS_PER_TYPE}`;
        const body = await fetch(url, { headers: h }).then(r => r.json()).catch(() => []);
        candidatesByType[resource_type] = (Array.isArray(body) ? body : []).map(r => ({
          resource_type: 'education', source_table: 'education_routing_matrix',
          source_ref: r.canonical_key || r.track_name || 'unknown',
          display_name: r.track_name,
          within_type_priority: r.priority ?? 999, across_type_ord: ord,
          is_cross_cutting: false, status: 'not_started', status_source: 'system', canonical_intent,
        }));

      } else if (resource_type === 'mentor') {
        if (!topics.length) { candidatesByType[resource_type] = []; continue; }
        const url = `${db.url}/rest/v1/ghl_educators_mentors`
          + `?educational_topics=ov.{${topics.join(',')}}`
          + `&educational_level=ov.{${encodeURIComponent(stage)}}`
          + `&is_active=eq.true&select=ghl_record_id,educators_name&limit=${MAX_ITEMS_PER_TYPE}`;
        const body = await fetch(url, { headers: h }).then(r => r.json()).catch(() => []);
        candidatesByType[resource_type] = (Array.isArray(body) ? body : []).map((r, i) => ({
          resource_type: 'mentor', source_table: 'ghl_educators_mentors',
          source_ref: r.ghl_record_id, display_name: r.educators_name,
          within_type_priority: i + 1, across_type_ord: ord,
          is_cross_cutting: false, status: 'not_started', status_source: 'system', canonical_intent,
        }));

      } else if (resource_type === 'vendor') {
        const needs = INTENT_TO_VENDOR_NEEDS[canonical_intent] || [];
        if (!needs.length) { candidatesByType[resource_type] = []; continue; }
        const url = `${db.url}/rest/v1/vendor_routing_matrix`
          + `?strategy=eq.${encodeURIComponent(strategy)}`
          + `&investor_need=in.(${needs.map(n => encodeURIComponent(n)).join(',')})`
          + `&is_active=eq.true&select=investor_need,vendor_categories,priority`
          + `&order=priority.asc&limit=${MAX_ITEMS_PER_TYPE}`;
        const body = await fetch(url, { headers: h }).then(r => r.json()).catch(() => []);
        candidatesByType[resource_type] = (Array.isArray(body) ? body : []).map(r => ({
          resource_type: 'vendor', source_table: 'vendor_routing_matrix',
          source_ref: r.investor_need,
          display_name: Array.isArray(r.vendor_categories)
            ? r.vendor_categories[0] : String(r.vendor_categories || ''),
          within_type_priority: r.priority ?? 999, across_type_ord: ord,
          is_cross_cutting: false, status: 'not_started', status_source: 'system', canonical_intent,
        }));

      } else if (resource_type === 'tool') {
        const url = `${db.url}/rest/v1/tools_routing_matrix`
          + `?or=(strategy.eq.${encodeURIComponent(strategy)},strategy.is.null)`
          + `&is_active=eq.true&select=tool_record_id,tool_title,priority`
          + `&order=priority.asc&limit=${MAX_ITEMS_PER_TYPE}`;
        const body = await fetch(url, { headers: h }).then(r => r.json()).catch(() => []);
        candidatesByType[resource_type] = (Array.isArray(body) ? body : []).map(r => ({
          resource_type: 'tool', source_table: 'tools_routing_matrix',
          source_ref: r.tool_record_id, display_name: r.tool_title,
          within_type_priority: r.priority ?? 999, across_type_ord: ord,
          is_cross_cutting: false, status: 'not_started', status_source: 'system', canonical_intent,
        }));
      }
    } catch (_e) {
      // Network/parse error for one type: degrade gracefully, leave slot empty
      candidatesByType[resource_type] = candidatesByType[resource_type] || [];
    }
  }

  return orderPhaseItems(candidatesByType, precedence);
}

// ---------------------------------------------------------------------------
// PUBLIC ASYNC FUNCTIONS — Stage 2c/2d: orchestrator (reads + writes DB)
// ---------------------------------------------------------------------------

/**
 * Create a caller roadmap end-to-end:
 *   resolveArchetype → detectEntryPhase
 *   → INSERT caller_roadmaps
 *   → INSERT roadmap_phases shells (ALL phases, statuses set by entry position)
 *   → populatePhaseItems (entry phase only) → INSERT roadmap_items
 *   → buildRoadmapSummary → return
 *
 * HYBRID POPULATION MODEL: phase shells for every phase are created immediately;
 * items are populated only for the entry phase. Future phases get items when the
 * caller advances (handled elsewhere).
 *
 * @param {object}  diagnosis  { strategy, stage, deal_count, contact_id, phone,
 *                               signals, education_history, already_tried, stated_stuck_point }
 * @param {{ url: string, key: string }} db   Supabase credentials
 * @param {{ dryRun?: boolean }} [options]    dryRun=true skips all DB writes + item population
 * @returns {Promise<{ roadmap_id, summary, archetype_key, entry_phase_order, _debug? }>}
 */
export async function createRoadmap(diagnosis, db, options = {}) {
  const { dryRun = false } = options;
  if (!_refs) throw new Error('roadmap-generator: setRefs() or loadRefs() required before createRoadmap()');

  const {
    strategy           = null,
    stage              = null,
    deal_count         = null,
    contact_id         = null,
    phone              = null,
  } = diagnosis;

  const writeHeaders = {
    'Content-Type':  'application/json',
    apikey:          db.key,
    Authorization:   `Bearer ${db.key}`,
    Prefer:          'return=representation',
  };

  // 1. Resolve archetype
  const archetypeResult = resolveArchetype(diagnosis);
  if (archetypeResult.route === 'contributor_handoff') {
    return { roadmap_id: null, summary: null, route: 'contributor_handoff', archetype_key: null, entry_phase_order: null };
  }
  const { archetype_id, archetype_key } = archetypeResult;

  // 2. Detect entry phase
  const { entry_phase_order } = detectEntryPhase(archetype_id, diagnosis);

  // 3. All phases for this archetype
  const allPhases = [...(_refs.phasesByArchetype[archetype_id] || [])]
    .sort((a, b) => a.phase_order - b.phase_order);
  const entryPhase = allPhases.find(p => p.phase_order === entry_phase_order);
  if (!entryPhase) throw new Error(`createRoadmap: no phase at order ${entry_phase_order} for archetype ${archetype_id}`);

  // 4. Build phase row descriptors (roadmap_id filled in after INSERT in live path)
  const phaseDescs = allPhases.map(p => ({
    phase_order:      p.phase_order,
    canonical_intent: p.canonical_intent,
    display_label:    p.display_label,
    status: p.phase_order < entry_phase_order  ? 'completed'
          : p.phase_order === entry_phase_order ? 'current' : 'shell',
  }));

  const roadmapRow = {
    archetype_id,
    current_phase_order: entry_phase_order,
    entry_phase_order,
    strategy:   strategy  || null,
    stage:      stage     || null,
    deal_count: deal_count !== null ? Number(deal_count) : null,
    version:    1,
    status:     'active',
    contact_id: contact_id || null,
    phone:      phone      || null,
  };

  let roadmap_id;

  if (dryRun) {
    roadmap_id = 'dry-run-id';
  } else {
    // Insert caller_roadmaps row
    const rmRes  = await fetch(`${db.url}/rest/v1/caller_roadmaps`, {
      method: 'POST', headers: writeHeaders, body: JSON.stringify(roadmapRow),
    });
    const rmBody = await rmRes.json();
    if (!Array.isArray(rmBody) || !rmBody[0]?.id) {
      throw new Error(`createRoadmap: caller_roadmaps insert failed (${rmRes.status})`);
    }
    roadmap_id = rmBody[0].id;

    // Insert phase shells
    const phaseRows = phaseDescs.map(d => ({ ...d, roadmap_id }));
    const phRes = await fetch(`${db.url}/rest/v1/roadmap_phases`, {
      method: 'POST',
      headers: { ...writeHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify(phaseRows),
    });
    if (!phRes.ok) {
      throw new Error(`createRoadmap: roadmap_phases insert failed (${phRes.status}): ${await phRes.text()}`);
    }
  }

  // 5. Populate entry-phase items (skipped in dryRun)
  const items = dryRun
    ? []
    : await populatePhaseItems({ strategy, stage, db }, entryPhase);

  if (!dryRun && items.length > 0) {
    const itemRows = items.map(item => ({
      roadmap_id,
      phase_order:          entry_phase_order,
      canonical_intent:     entryPhase.canonical_intent,
      resource_type:        item.resource_type,
      source_table:         item.source_table,
      source_ref:           String(item.source_ref ?? ''),
      display_name:         item.display_name,
      within_type_priority: item.within_type_priority,
      across_type_ord:      item.across_type_ord,
      status:               'not_started',
      status_source:        'system',
      is_cross_cutting:     item.is_cross_cutting ?? false,
    }));

    const irRes = await fetch(`${db.url}/rest/v1/roadmap_items`, {
      method: 'POST',
      headers: { ...writeHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify(itemRows),
    });
    if (!irRes.ok) {
      throw new Error(`createRoadmap: roadmap_items insert failed (${irRes.status}): ${await irRes.text()}`);
    }

    // Stamp entry phase populated_at
    await fetch(
      `${db.url}/rest/v1/roadmap_phases?roadmap_id=eq.${roadmap_id}&phase_order=eq.${entry_phase_order}`,
      {
        method: 'PATCH',
        headers: { ...writeHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ populated_at: new Date().toISOString() }),
      },
    );
  }

  // 6. Spoken summary
  const summary = buildRoadmapSummary(entryPhase, allPhases, items);

  return {
    roadmap_id,
    summary,
    archetype_key,
    entry_phase_order,
    ...(dryRun && { _debug: { roadmapRow, phaseDescs, itemCount: items.length } }),
  };
}

// ---------------------------------------------------------------------------
// PRIVATE HELPERS
// ---------------------------------------------------------------------------

/**
 * Flatten signals object (truthy entries only) to a lowercase string so that
 * keyword matching works against both key names and string values.
 * e.g. { is_passive: true } → 'is_passive true'
 * e.g. { is_passive: false } → '' (falsy — excluded)
 */
function _signalsToString(signals) {
  return Object.entries(signals)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k} ${v}`)
    .join(' ')
    .toLowerCase();
}

/**
 * Map a free-text stuck-point to a canonical_intent using keyword matching.
 * Returns null if no keyword matches.
 */
function _stuckPointToIntent(text) {
  const lower = text.toLowerCase();
  for (const { keywords, intent } of STUCK_POINT_KEYWORD_MAP) {
    if (keywords.some(kw => lower.includes(kw))) return intent;
  }
  return null;
}
