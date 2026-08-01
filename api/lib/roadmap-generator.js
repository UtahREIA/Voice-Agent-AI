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
// MODULE-LEVEL REFS CACHE
// ---------------------------------------------------------------------------

let _refs = null;

/**
 * Inject pre-built reference data (for tests or pre-fetched production cache).
 * @param {{ archetypesById, strategyMap, phasesByArchetype }} refs
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

  const [archetypesRes, phasesRes, strategyRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/roadmap_archetypes?select=id,archetype_key,name`, { headers }),
    fetch(`${supabaseUrl}/rest/v1/archetype_phases?select=archetype_id,phase_order,canonical_intent,display_label`, { headers }),
    fetch(`${supabaseUrl}/rest/v1/strategy_archetype_map?select=strategy,default_archetype_id,promote_to_archetype_id,promote_trigger,notes`, { headers }),
  ]);

  const [archetypes, phases, strategyRows] = await Promise.all([
    archetypesRes.json(),
    phasesRes.json(),
    strategyRes.json(),
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

  const refs = { archetypesById, strategyMap, phasesByArchetype };
  _refs = refs;
  return refs;
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
