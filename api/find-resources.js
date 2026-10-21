/**
 * find-resources.js — the single V2 lookup tool (Vapi tool: find_resources).
 *
 * Replaces the seven V1 lookup tools. Lani works out the need with her own rules
 * first, then calls this ONCE with up to 3 typed needs. It matches DIRECTLY on
 * GHL service keys, topics and levels — no vendor_routing_matrix, no
 * blocker_service_mapping, no education_routing_matrix (all retire at the switch).
 *
 * Spec: claude/LANI-VENDOR-LOOKUP-SPEC.md (Chris, 2026-10-14). Owner: David/chat 6.
 * Tool attach to any assistant needs Chris's approval + a 'planned' tracker row.
 *
 * Reuse: PLAIN_WORDS + column names from api/lib/lani-catalog.js; the geo scorer
 * shape from api/vendors.js; least-recently-referred from vendor_referrals.
 *
 * Input (tool arguments):
 *   { needs: [ { type, topic?, level?, service?, city?, county?, state? }, ... ] }
 *   type ∈ utah_reia | educator | class | tool | event | vendor
 *   (a single need may also be passed as the top-level object.)
 *
 * Output (tool result, JSON string):
 *   { needs: [ { type, requested, status, matches:[{id,name,description,cost,
 *     booking_link,closest_fit}], note } ] }
 *   status ∈ ok | no_match | needs_location
 */

import { PLAIN_WORDS } from './lib/lani-catalog.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// ── Vocabulary maps ────────────────────────────────────────────────────────
// Reverse of PLAIN_WORDS (plain words -> GHL key) so a caller's plain "fix and
// flip" resolves to the topic key fix__flip. An already-key value passes through.
const KEY_BY_PLAIN = (() => {
  const m = {};
  for (const [key, plain] of Object.entries(PLAIN_WORDS)) {
    m[plain.toLowerCase()] = key;
    m[key.toLowerCase()] = key; // identity so keys pass through
  }
  return m;
})();

// Spec level words -> GHL educational_level keys.
const LEVEL_KEY = {
  new: 'exploring__new', exploring: 'exploring__new', 'new and exploring': 'exploring__new',
  getting_started: 'getting_started', 'getting started': 'getting_started', started: 'getting_started',
  active: 'active_investor', 'active investor': 'active_investor', active_investor: 'active_investor',
  experienced: 'experienced_investor', 'experienced investor': 'experienced_investor', experienced_investor: 'experienced_investor',
  veteran: 'veteran__operator', 'veteran operator': 'veteran__operator', veteran__operator: 'veteran__operator', operator: 'veteran__operator'
};

// Commercial sub-assets collapse to the 'commercial' topic (education/tool/
// educator records carry 'commercial', not the per-asset key). A match via this
// collapse is a RELATED match (closest_fit), never an exact one.
const COMMERCIAL_ASSETS = new Set([
  'industrial', 'retail', 'multi_family', 'self_storage', 'mobile_home',
  'hotel', 'assisted_living', 'farm_land', 'rv_parks'
]);

// Vendor columns we MATCH on. Spec 4b: other_contractor and other_vendor_services
// are GAP fields, never match fields, so they are excluded here (they are still
// shown in the catalog, just not matched).
const VENDOR_MATCH_ARRAY_COLS = [
  'funding_financial', 'loan_product', 'deals_opportunities', 'team_vendors',
  'attorney_subclass', 'operations', 'development_land', 'education_tech_tools'
];
const VENDOR_MATCH_TEXT_COLS = ['contractor_speciality']; // subtype text, matchable
// Spec 4b: parent values are NOT matchable when a sub-type exists — match the
// sub-type only. A vendor tagged with just a bare parent token never matches.
const PARENT_TOKENS = new Set(['attorney', 'contractor', 'mortgage_broker']);

// Local service types (spec section 4). A local type requested with no city/
// county returns needs_location so Lani asks and looks up again. This is the
// approved list from the spec; Chris owns changes. Architects are NOT local.
const LOCAL_SERVICE_HINTS = [
  'contractor', 'trade', 'electric', 'plumb', 'hvac', 'roof', 'floor', 'drywall',
  'paint', 'framing', 'concrete', 'foundation', 'landscap', 'demolition', 'restoration',
  'appraiser', 'inspector', 'inspection', 'stager', 'staging', 'leasing agent',
  'property manager', 'property management', 'cleaning', 'co-host', 'cohost', 'turnover',
  'furniture', 'permit consultant', 'agent', 'wholesaler', 'bird dog', 'surveyor',
  'engineer', 'geotech', 'environmental', 'zoning'
];
// Out-of-Utah: these vendor kinds are state-regulated, so warn coverage may not
// extend to the caller's state (spec section 4).
const STATE_SCOPED_HINTS = ['lend', 'loan', 'mortgage', 'attorney', 'legal', 'insurance', 'title', 'escrow'];

const asArray = (v) => Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]);
const lc = (v) => String(v || '').toLowerCase().trim();
const isTestRecord = (name) => /testing/i.test(String(name || ''));

// Phase 3 confidence (ROUTING_SCORING_DESIGN.md): a 0-100 match_score per match,
// banded against a threshold N so Lani's "close match" claim is computed, not judged.
// N is a code constant for now (the design allows moving it to app_settings later).
const CONF_THRESHOLD = 60;
const band = (s) => s >= CONF_THRESHOLD ? 'high' : s >= CONF_THRESHOLD - 15 ? 'medium' : 'low';

// During V2 testing Chris wants TESTING fixtures INCLUDED (they are deleted
// before launch). Set FIND_EXCLUDE_TEST_RECORDS=true to exclude them again.
const EXCLUDE_TEST = process.env.FIND_EXCLUDE_TEST_RECORDS === 'true';
const cleanSentence = (v) => {
  if (!v) return '';
  const s = String(v).replace(/\s*—\s*/g, ' - ').replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[.!?])\s/)[0];
  return (first || s).slice(0, 180);
};
const topicKey = (plain) => { const k = lc(plain); return KEY_BY_PLAIN[k] || k.replace(/\s+/g, '_'); };
const levelKey = (plain) => { const k = lc(plain); return LEVEL_KEY[k] || k.replace(/\s+/g, '_'); };

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id ||
    req.body?.message?.toolCalls?.[0]?.id ||
    req.body?.toolCallList?.[0]?.id || null;
  const vapiCallId = req.body?.message?.call?.id || req.body?.call?.id || null;

  const reply = (obj) => {
    const result = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (toolCallId) return res.status(200).json({ results: [{ toolCallId, result }] });
    return res.status(200).json({ result });
  };

  function extractArgs(body) {
    try {
      const a = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (a) return typeof a === 'string' ? JSON.parse(a) : a;
    } catch (e) {}
    return body || {};
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return reply({ needs: [], error: 'not_configured',
      message: 'Resource lookup unavailable. Say the Utah REIA team will follow up with the right resources.' });
  }

  const args = extractArgs(req.body);
  let needs = Array.isArray(args.needs) ? args.needs : null;
  if (!needs) {
    // Single need passed at the top level.
    if (args.type || args.topic || args.service) needs = [args];
    else needs = [];
  }
  needs = needs.slice(0, 3); // spec: up to 3 needs
  if (!needs.length) {
    return reply({ needs: [], message: 'No need was specified. Ask the caller what kind of help they are looking for.' });
  }

  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const get = async (path) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    } catch (e) { console.error('find_resources query error on', path.split('?')[0], '-', e.message); return []; }
  };
  try {
    const results = await Promise.all(needs.map(need => resolveNeed(need, { get, headers })));
    console.log('find_resources:', JSON.stringify(results.map(r => ({ type: r.type, status: r.status, n: r.matches.length }))));

    // End-of-call capture (LANI-V2-CALL-RECORD-SPEC Part 1): cache EVERY match
    // with id/name/type/url/cost/status PLUS the needs that came back no_match or
    // needs_location, keyed by the Vapi call id. This is the exact record the
    // call-record build, educator rotation and vendor_referrals read. _url is
    // collected server-side then STRIPPED so Lani never reads a URL aloud.
    const allEntries = [];      // {id,name,type,url,cost,status}
    let educatorName = '', educatorUrl = '';
    for (const n of results) {
      if (n.status !== 'ok') {  // record a missing need even when Lani does not say it
        allEntries.push({ id: null, name: '', type: n.type, url: '', cost: '', status: n.status });
      }
      for (const m of n.matches) {
        const url = m._url || '';
        allEntries.push({ id: m.id, name: m.name, type: n.type, url, cost: m.cost, status: 'ok' });
        if (n.type === 'educator' && !educatorName) { educatorName = m.name; educatorUrl = url; }
        delete m._url;
      }
    }
    if (vapiCallId && allEntries.length) {
      // Merge, do not overwrite: a second find_resources call in the same call
      // unions with the first (dedupe by type + id/name/status).
      let prior = [], priorName = '', priorUrl = '';
      try {
        const rows = await get(`voice_agent_stack_links?vapi_call_id=eq.${encodeURIComponent(vapiCallId)}&select=links,educator_name,educator_url&limit=1`);
        if (rows[0]) { prior = Array.isArray(rows[0].links) ? rows[0].links : []; priorName = rows[0].educator_name || ''; priorUrl = rows[0].educator_url || ''; }
      } catch (e) {}
      const keyOf = (m) => (m.type || '') + '|' + (m.id || m.name || m.status || '');
      const merged = [...prior];
      const seen = new Set(prior.map(keyOf));
      for (const m of allEntries) if (!seen.has(keyOf(m))) { seen.add(keyOf(m)); merged.push(m); }
      const edName = priorName || educatorName, edUrl = priorUrl || educatorUrl;
      const withUrl = merged.filter(m => m.url);
      const smsLinks = withUrl.length ? 'Your links:\n' + withUrl.map(r => `- ${r.name}: ${r.url}`).join('\n') : '';
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/voice_agent_stack_links?on_conflict=vapi_call_id`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            vapi_call_id: vapiCallId, sms_links: smsLinks, links: merged,
            educator_name: edName, educator_url: edUrl, mode: 'find_resources'
          })
        });
      } catch (e) { console.error('find_resources stack-links cache error:', e.message); }
    }

    return reply({ needs: results });
  } catch (e) {
    console.error('find_resources error:', e.message);
    return reply({ needs: [], error: 'exception',
      message: 'Resource lookup hit an error. Say the Utah REIA team will follow up with the right resources.' });
  }

  // ── Per-need resolver ──────────────────────────────────────────────────
  async function resolveNeed(need, ctx) {
    const type = lc(need.type) || inferType(need);
    const requested = {
      topic: need.topic || '', level: need.level || '', service: need.service || '',
      city: need.city || '', county: need.county || '', state: need.state || ''
    };
    const tKey = need.topic ? topicKey(need.topic) : '';
    const lKey = need.level ? levelKey(need.level) : '';
    const related = COMMERCIAL_ASSETS.has(tKey) ? ['commercial'] : [];

    const base = { type, requested };
    const mk = (status, matches = [], note = '') => ({ ...base, status, matches, note });

    if (type === 'vendor') return resolveVendor(need, { tKey, lKey, requested, mk, ...ctx });
    if (type === 'event')  return resolveEvent({ tKey, related, mk, ...ctx });
    if (type === 'utah_reia' || type === 'utah reia' || type === 'reia') return resolveReia({ need, tKey, mk, ...ctx });
    // educator | class | tool all match on topic + level directly.
    return resolveLearning(type, { tKey, lKey, related, mk, ...ctx });
  }

  // ── Utah REIA resources (these LEAD) ───────────────────────────────────
  async function resolveReia({ need, tKey, mk, get }) {
    const rows = await get('reia_resources?is_active=eq.true&order=priority.asc&select=resource_key,title,voice_description,access,serves_needs,serves_problems,priority,url');
    const want = lc(need.service || need.topic || '');
    const wantKey = tKey || topicKey(need.service || '');
    const scored = rows.map(r => {
      const hay = [...asArray(r.serves_needs), ...asArray(r.serves_problems)].map(lc);
      let s = 100 - (r.priority || 0); // priority leads; these are the house resources
      if (wantKey && hay.some(h => h === wantKey || h.includes(wantKey) || wantKey.includes(h))) s += 50;
      else if (want && (lc(r.title).includes(want) || hay.some(h => h.includes(want)))) s += 20;
      return { r, s };
    }).sort((a, b) => b.s - a.s).slice(0, 2);
    const matches = scored.map(({ r }) => {
      const hay = [...asArray(r.serves_needs), ...asArray(r.serves_problems)].map(lc);
      const hit = (wantKey && hay.some(h => h === wantKey || h.includes(wantKey) || wantKey.includes(h)))
        || (want && lc(r.title).includes(want));
      const score = hit ? 90 : 55; // Utah REIA resources lead; high only when the need matches, else medium
      return {
        id: r.resource_key || r.title, name: r.title,
        description: cleanSentence(r.voice_description), cost: accessWord(r.access),
        booking_link: Boolean(r.url), closest_fit: false,
        match_score: score, confidence: band(score),
        _url: r.url || ''
      };
    });
    return matches.length ? mk('ok', matches) : mk('no_match');
  }

  // ── Educators / classes / tools (topic must match; level must include) ──
  async function resolveLearning(type, { tKey, lKey, related, mk, get }) {
    const cfg = {
      educator: { table: 'ghl_educators_mentors', name: 'educators_name', url: 'educators_url', select: 'ghl_record_id,educators_name,educational_topics,educational_level,commercial_asset_types,educators_url' },
      class:    { table: 'ghl_educational_courses', name: 'course_name', url: 'education_url', select: 'ghl_record_id,course_name,educational_topics,educational_level,commercial_asset_types,education_url,video_url,paid_education,membership_required' },
      tool:     { table: 'ghl_tools_resources', name: 'resource_title', url: 'resource_url', select: 'ghl_record_id,resource_title,educational_topics,educational_level,resource_url,resource_url_nonmember,paid_resource,membership_required' }
    }[type];
    if (!cfg) return mk('no_match');

    // Match across EVERY record (spec 4b: no subset). Pull active, filter in JS so
    // exact-vs-related topic and "no level set = any level" are handled precisely.
    const rows = await get(`${cfg.table}?is_active=eq.true&select=${cfg.select}&limit=200`);

    // Educator rotation (LANI-V2-CALL-RECORD-SPEC Part 1): among equally-good
    // educators, prefer the one recommended least recently, by scanning the
    // find_resources cache for educator IDs. Never-recommended sort first.
    const eduLastRec = new Map();
    if (type === 'educator') {
      try {
        const cache = await get('voice_agent_stack_links?select=links,created_at&order=created_at.desc&limit=500');
        for (const row of cache) {
          const t = Date.parse(row.created_at || 0) || 0;
          for (const m of (Array.isArray(row.links) ? row.links : [])) {
            if (m && m.type === 'educator' && m.id && (!eduLastRec.has(m.id) || t > eduLastRec.get(m.id))) eduLastRec.set(m.id, t);
          }
        }
      } catch (e) {}
    }

    const scored = [];
    for (const r of rows) {
      // Test fixtures: excluded only when FIND_EXCLUDE_TEST_RECORDS is set. During
      // V2 testing they are included (Chris's request); deleted in GHL before launch.
      if (EXCLUDE_TEST && isTestRecord(r[cfg.name])) continue;
      const topics = asArray(r.educational_topics).map(lc);
      const levels = asArray(r.educational_level).map(lc);
      let s = 0, closest = false;
      if (tKey) {
        if (topics.includes(tKey)) s += 50;                       // exact topic beats related
        else if (related.length && related.some(t => topics.includes(t))) { s += 25; closest = true; }
        else continue;                                            // topic required: no topic match => skip
      }
      // Level must include the caller's level; no level set = any level (no penalty).
      if (lKey) { if (levels.includes(lKey)) s += 25; else if (levels.length) continue; }
      // Free beats paid when fit is equal.
      const paid = r.paid_resource === true || r.paid_education === true;
      const members = r.membership_required === true;
      s += paid ? 0 : members ? 5 : 10;
      // Phase 3 match score (0-100): topic 50 exact / 25 related, level 25.
      let earned = 0, mx = 0;
      if (tKey) { mx += 50; earned += topics.includes(tKey) ? 50 : 25; }
      if (lKey) { mx += 25; earned += (levels.includes(lKey) || levels.length === 0) ? 25 : 0; }
      const score100 = mx ? Math.round(earned / mx * 100) : 70;
      scored.push({ r, s, closest, score100,
        last: type === 'educator' ? (eduLastRec.get(r.ghl_record_id) ?? 0) : 0, rnd: Math.random() });
    }
    // Score first; then (educators) least-recently-recommended; then random.
    scored.sort((a, b) => b.s - a.s || a.last - b.last || a.rnd - b.rnd);
    const top = scored.slice(0, 2).map(({ r, closest, score100 }) => {
      // A class with a video_url is a recording of a past event (Chris, 2026-10-16):
      // Lani introduces it as a replay so the caller knows it is not a live class.
      const isReplay = type === 'class' && Boolean(r.video_url);
      const topicWords = asArray(r.educational_topics)
        .map(t => PLAIN_WORDS[t] || String(t).replace(/__/g, ' ').replace(/_/g, ' '))
        .slice(0, 2).join(' and ') || 'real estate investing';
      const link = type === 'class' ? (r.education_url || r.video_url) : r[cfg.url];
      return {
        id: r.ghl_record_id, name: r[cfg.name],
        description: isReplay ? `A replay of a past Utah REIA event on ${topicWords}.`
                              : topicSentence(r.educational_topics, type),
        // All Utah REIA educators and mentors are paid (Chris, 2026-10-21); they
        // carry no cost field so costWord would default them to free.
        cost: type === 'educator' ? 'paid' : costWord(r),
        booking_link: Boolean(link),
        closest_fit: closest,
        match_score: score100, confidence: band(score100),
        _url: link || '',
        ...(isReplay ? { format: 'event_replay' } : {})
      };
    });
    return top.length ? mk('ok', top, top.some(m => m.closest_fit) ? 'closest_fit' : '') : mk('no_match');
  }

  // ── Events (today or later; match by topic or networking) ──────────────
  async function resolveEvent({ tKey, related, mk, get }) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await get(`ghl_upcoming_events?is_active=eq.true&event_date=gte.${today}&order=event_date.asc&limit=20&select=id,event_title,event_subtitle,event_date,event_time,event_location,speaker_name,strategies,event_type,registration_url`);
    const wanted = [tKey, ...related].filter(Boolean);
    const pick = rows.filter(e => {
      const strats = asArray(e.strategies).map(lc);
      if (!strats.length) return true; // open to everyone
      if (!wanted.length) return true;
      return wanted.some(w => strats.some(s => s === w || s.includes(w) || w.includes(s)));
    });
    // No "any event" fallback (Chris, 2026-10-16): if nothing matches the topic
    // (and no open-to-everyone events), return no_match rather than an arbitrary event.
    const list = pick.slice(0, 2).map(e => {
      const strats = asArray(e.strategies).map(lc);
      const hit = wanted.length && strats.some(s => wanted.some(w => s === w || s.includes(w) || w.includes(s)));
      const score = hit ? 82 : 48; // topic match = high; a fallback/open event = medium, not high
      return {
        id: e.id, name: e.event_title,
        description: cleanSentence([e.event_subtitle, e.event_date, e.event_time, e.event_location].filter(Boolean).join(' ')),
        cost: 'first event free', booking_link: Boolean(e.registration_url), closest_fit: false,
        match_score: score, confidence: band(score),
        _url: e.registration_url || ''
      };
    });
    return list.length ? mk('ok', list) : mk('no_match');
  }

  // ── Vendors (service + area; specialty-first; least-recently-referred) ──
  async function resolveVendor(need, { requested, mk, get, headers }) {
    const serviceWords = lc(need.service || need.topic);
    const callerState = (need.state || 'UT').toUpperCase();
    let callerCounty = lc(need.county).replace(/\s+/g, '_');
    if (callerCounty && !callerCounty.endsWith('_county')) callerCounty += '_county';
    const callerCity = lc(need.city);
    const isLocalType = LOCAL_SERVICE_HINTS.some(h => serviceWords.includes(h));
    const isStateScoped = STATE_SCOPED_HINTS.some(h => serviceWords.includes(h));

    // A local service with no location: stop and ask (spec section 4).
    if (isLocalType && !callerCounty && !callerCity) {
      return mk('needs_location', [], 'needs_location: ask the caller which city or county, then look up again.');
    }

    const vendors = await get(`ghl_vendor_resources?is_active=eq.true&enroll_vendor_match=eq.true&approval_status=eq.Approved&limit=200&select=ghl_record_id,company_name,business_description,company_website,company_phone,company_city,company_state,funding_financial,loan_product,deals_opportunities,team_vendors,attorney_subclass,operations,development_land,education_tech_tools,contractor_speciality,other_contractor,other_vendor_services,service_counties,service_areas,service_zip_codes,serves_statewide,serves_national`);

    // Referral recency for least-recently-referred ordering (spec section 4).
    const refs = await get('vendor_referrals?select=vendor_ghl_record_id,referral_delivered_at,created_at&order=created_at.desc&limit=1000');
    const lastRef = new Map();
    for (const r of refs) {
      const id = r.vendor_ghl_record_id; if (!id) continue;
      const t = Date.parse(r.referral_delivered_at || r.created_at || 0) || 0;
      if (!lastRef.has(id) || t > lastRef.get(id)) lastRef.set(id, t);
    }

    const terms = serviceWords.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const scored = [];
    for (const v of vendors) {
      // Stopgap test exclusion: spec wants a real flag, but no is_test column
      // exists yet (flagged to Chris). Exclude by name until the flag lands.
      if (EXCLUDE_TEST && isTestRecord(v.company_name)) continue;

      // Specialty-first: subtype columns first, then category columns. Gap fields
      // (other_contractor, other_vendor_services) are NOT matched.
      const subtypeVals = [
        ...VENDOR_MATCH_TEXT_COLS.flatMap(c => String(v[c] || '').split(',')),
        ...asArray(v.attorney_subclass), ...asArray(v.loan_product)
      ].map(lc).filter(Boolean).filter(t => !PARENT_TOKENS.has(t));
      const categoryVals = VENDOR_MATCH_ARRAY_COLS.flatMap(c => asArray(v[c])).map(lc)
        .filter(Boolean).filter(t => !PARENT_TOKENS.has(t));

      let svcScore = 0;
      const hit = (vals) => vals.some(val => terms.some(t => val.includes(t) || t.includes(val)));
      if (!serviceWords) svcScore = 1;                 // no service specified: any vendor
      else if (hit(subtypeVals)) svcScore = 50;        // specialty-first
      else if (hit(categoryVals)) svcScore = 30;
      else continue;                                   // spec 4b: never fall through to unfiltered

      // Area match (reuse vendors.js logic shape).
      let geo = 0;
      if (v.serves_national) geo = 5;
      else if (v.serves_statewide && callerState === 'UT') geo = 4;
      else if (callerCounty) {
        if (asArray(v.service_counties).some(c => lc(c) === callerCounty)) geo = 9;
        else if (asArray(v.service_counties).length) continue; // serves other counties only
        else geo = 3; // no area data yet — keep at low score (transition-safe)
      } else if (callerCity && asArray(v.service_areas).some(a => lc(a).includes(callerCity))) geo = 7;
      else if (!callerCounty && !callerCity) geo = 3; // no location given
      // TESTING vendors have no Area Serviced (it can't be set through the GHL
      // connector), so during testing treat them as serving all of Utah (Chris).
      if (!EXCLUDE_TEST && isTestRecord(v.company_name) && callerState === 'UT') geo = Math.max(geo, 4);
      if (geo === 0) continue;

      const id = v.ghl_record_id;
      // Phase 3 match score (0-100): service 50 specialty / 30 category, area up to 20.
      let earned = 0, mx = 0;
      if (serviceWords) { mx += 50; earned += svcScore >= 50 ? 50 : (svcScore >= 30 ? 30 : 0); }
      mx += 20; earned += geo >= 9 ? 20 : (geo >= 7 ? 16 : (geo >= 4 ? 12 : 5));
      const score100 = Math.round(earned / mx * 100);
      scored.push({ v, score: svcScore + geo, last: lastRef.get(id) ?? 0, rnd: Math.random(), score100 });
    }

    // Rank by match score, then least-recently-referred, then random tiebreak.
    scored.sort((a, b) => b.score - a.score || a.last - b.last || a.rnd - b.rnd);
    const outOfUtah = callerState && callerState !== 'UT';
    const top = scored.slice(0, 2).map(({ v, score100 }) => ({
      id: v.ghl_record_id, name: v.company_name,
      description: cleanSentence(v.business_description),
      cost: 'partner', booking_link: false, closest_fit: false,
      match_score: score100, confidence: band(score100),
      _url: v.company_website || '',
      ...(outOfUtah && isStateScoped ? { coverage_warning: `may not cover ${callerState}` } : {})
    }));
    return top.length ? mk('ok', top, outOfUtah && isStateScoped ? 'out_of_state_coverage' : '') : mk('no_match');
  }
}

// ── small helpers (module scope) ───────────────────────────────────────────
function inferType(need) {
  if (need.service) return 'vendor';
  return 'utah_reia';
}
function accessWord(access) {
  const a = lc(access);
  if (!a) return 'free';
  if (a.includes('member')) return 'free for members';
  if (a.includes('paid') || a.includes('$')) return 'paid';
  if (a.includes('free') || a.includes('public') || a.includes('join')) return 'free';
  return a;
}
function costWord(r) {
  if (r.paid_education === true || r.paid_resource === true) return 'paid';
  if (r.membership_required === true) return 'free for members';
  return 'free';
}
function topicSentence(topics, type) {
  const words = asArray(topics).map(t => (PLAIN_WORDS[t] || String(t).replace(/__/g, ' ').replace(/_/g, ' '))).slice(0, 2);
  const subject = words.join(' and ') || (type === 'educator' ? 'real estate investing' : 'investing');
  if (type === 'educator') return `Mentorship on ${subject}.`;
  if (type === 'class') return `A class on ${subject}.`;
  return `A tool for ${subject}.`;
}
