/**
 * resources.js — Combined resource stack tool
 *
 * Vapi tool: getResourceStack
 *
 * Default (mode 'all'): returns up to 6 resources spread ACROSS the five
 * categories, keeping only what matches the caller's stage and strategy.
 * Specific request (mode 'vendor' | 'educator' | 'education' | 'tools' |
 * 'events'): returns up to 5 of that one category. When a specific request
 * comes back thin, we deliver what matched and OFFER to widen rather than
 * silently padding with things the caller did not ask for.
 *
 * THREE VOCABULARIES — all three are live and none can be dropped:
 *   1. long stage   active_investor      Vapi enum, educational_level on the
 *                                        ghl_* record tables
 *   2. short stage  active                education_routing_matrix.stage,
 *                                        tools_routing_matrix.stage
 *   3. topic        fix__flip             educational_topics on the ghl_* tables
 * Callers send vocabulary 1. Everything here translates before querying.
 *
 * Commercial strategies (industrial, retail, multi_family, ...) match through
 * the 'commercial' topic. commercial_asset_types is now populated for commercial
 * educators (one asset type each), but matching still goes through the topic for
 * breadth; refining to the specific asset type belongs with the resource-
 * hierarchy work, not here.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Vocabulary 1 -> 2. Only getting_started is spelled the same in both.
const SHORT_STAGE = {
  exploring__new: 'exploring',
  getting_started: 'getting_started',
  active_investor: 'active',
  experienced_investor: 'experienced',
  veteran__operator: 'veteran'
};

// Vocabulary 1 -> 3. Several strategies have no topic of their own and route
// through 'commercial', which is how the commercial asset types are covered.
const TOPICS_BY_STRATEGY = {
  fix_and_flip: ['fix__flip'],
  buy_and_hold: ['buy__hold__rentals'],
  wholesale: ['wholesaling'],
  brrrr: ['brrrr'],
  creative_financing: ['creative_financing'],
  raising_capital: ['raising_capital'],
  development: ['development'],
  notes_lending: ['notes__lending'],
  land_entitlement: ['land__entitlement'],
  short_term_rental: ['short_term_rental'],
  mid_term_coliving: ['midterm__coliving_rentals'],
  tax_deeds_liens: ['tax_deeds_and_liens'],
  house_hacking: ['house_hacking'],
  passive_investing: ['passive_investments'],
  // Both spellings exist in the data; match either.
  syndication: ['syndications__funds', 'syndication__funds'],
  commercial: ['commercial'],
  industrial: ['commercial'],
  retail: ['commercial'],
  multi_family: ['commercial'],
  self_storage: ['commercial'],
  mobile_home: ['commercial'],
  hotel: ['commercial'],
  assisted_living: ['commercial'],
  farm_land: ['commercial'],
  rv_parks: ['commercial'],
  out_of_state: [],
  tax_optimization: [],
  mentoring_others: [],
  not_sure: []
};

// Vocabulary 1 -> the routing matrices, which spell strategies differently
// again. education_routing_matrix carries no per-asset commercial rows, so the
// commercial asset types collapse to 'commercial' here. The remaining entries
// are nearest-neighbour fallbacks, only ever tried after the caller's own
// strategy has been attempted verbatim.
const MATRIX_STRATEGY = {
  industrial: ['commercial'],
  retail: ['commercial'],
  multi_family: ['commercial'],
  self_storage: ['commercial'],
  mobile_home: ['commercial'],
  hotel: ['commercial'],
  assisted_living: ['commercial'],
  farm_land: ['commercial'],
  rv_parks: ['commercial'],
  tax_deeds_liens: ['tax_deeds'],
  notes_lending: ['notes_and_lending'],
  not_sure: ['not_sure_yet'],
  wholesale: ['wholesale', 'wholesaling'],
  // brrrr has its own vendor row (matched first via stratEq) but NO education
  // track and no fallback, so brrrr callers got a thin/empty LEARN stack. Fall
  // education back to buy_and_hold (BRRRR's defining end-state is a refinanced
  // rental hold). Interim mapping — Chris can refine or author a dedicated track.
  brrrr: ['buy_and_hold'],
  syndication: ['raising_capital'],
  passive_investing: ['buy_and_hold'],
  house_hacking: ['buy_and_hold'],
  mid_term_coliving: ['short_term_rental'],
  land_entitlement: ['development']
};

// Which categories a requested mode resolves to, and how deep to go.
const MODE_CATEGORIES = {
  all: ['education', 'vendor', 'tool', 'educator', 'event'],
  vendor: ['vendor'],
  education: ['education'],
  educator: ['educator'],
  mentor: ['educator'],
  tool: ['tool'],
  event: ['event']
};

// Caller phrasing -> canonical mode.
const MODE_ALIASES = {
  all: 'all', any: 'all', everything: 'all',
  vendor: 'vendor', vendors: 'vendor', service_provider: 'vendor', professionals: 'vendor',
  education: 'education', educations: 'education', course: 'education', courses: 'education',
  training: 'education', class: 'education', classes: 'education',
  educator: 'educator', educators: 'educator', mentor: 'educator', mentors: 'educator',
  mentorship: 'educator', coach: 'educator', coaching: 'educator',
  tool: 'tool', tools: 'tool', calculator: 'tool', calculators: 'tool', software: 'tool',
  event: 'event', events: 'event', meetup: 'event', meetups: 'event'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id ||
    req.body?.message?.toolCalls?.[0]?.id ||
    req.body?.toolCallList?.[0]?.id ||
    null;

  function vapiResult(result) {
    if (toolCallId) return res.status(200).json({ results: [{ toolCallId, result: String(result) }] });
    return res.status(200).json({ result: String(result) });
  }

  function extractArgs(body) {
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (args) return typeof args === 'string' ? JSON.parse(args) : args;
    } catch (e) {}
    return body || {};
  }

  // Vapi call id — used to cache the links this stack delivers so ghl-sync can
  // fold them into the follow-up SMS at end of call (see voice_agent_stack_links).
  const vapiCallId =
    req.body?.message?.call?.id ||
    req.body?.call?.id ||
    null;

  const args = extractArgs(req.body);
  const rawStage = (args.stage || args.investor_stage || '').toLowerCase().trim();
  const strategy = (args.strategy || '').toLowerCase().trim();
  const blocker  = (args.blocker  || '').toLowerCase().trim();
  const goal     = (args.goal     || '').toLowerCase().trim();
  const credit   = (args.credit   || '').toLowerCase().trim();
  const capital  = (args.capital  || '').toLowerCase().trim();
  const alreadyTried = (args.already_tried || '').toLowerCase().trim();

  // ---- Phase 1a signal-based soft re-rank (ROUTING_SCORING_DESIGN.md) ----
  // credit/capital/already_tried already arrive in tool_args but never shaped the
  // order. Nudge (never hard-exclude — soft deltas on priority) so the best-fit
  // floats up: weak credit or low capital surfaces creative & private/hard money
  // and sinks conventional financing; already_tried pushes down what they've done.
  const weakCredit = /\b(bad|poor|weak|low|rough|rebuild|thin|bruised|no credit|not (very )?(strong|good|great)|challeng)/.test(credit);
  const lowCapital = /\b(little|no money|none|low|tight|limited|not much|nothing|zero|starting with)/.test(capital);
  const triedWords = alreadyTried.split(/[^a-z0-9]+/).filter(w => w.length >= 5);
  const reRank = (r) => {
    let d = 0;
    const hay = `${r.name || ''} ${r.description || ''} ${(r.tags || []).join(' ')}`.toLowerCase().replace(/_/g, ' ');
    if (triedWords.length && triedWords.some(w => hay.includes(w))) d += 3; // already did this
    if (weakCredit || lowCapital) {
      if (/(creative|private money|hard money|seller financ|subject.?to|lease option|owner financ|gap fund|no money|low money)/.test(hay)) d -= 4;
      if (/(conventional|traditional bank|bank loan)/.test(hay)) d += 3;
    }
    return d;
  };

  const rawMode = (args.mode || args.resource_request || 'all').toLowerCase().trim().replace(/\s+/g, '_');
  const mode = MODE_ALIASES[rawMode] || 'all';
  const categories = MODE_CATEGORIES[mode] || MODE_CATEGORIES.all;
  const isSpecific = mode !== 'all';
  const maxResultsRaw = parseInt(args.max_results, 10);
  const maxResults = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
    ? maxResultsRaw
    : (isSpecific ? 5 : 6);

  const shortStage = SHORT_STAGE[rawStage] || rawStage;
  const longStage  = rawStage;
  const topics = TOPICS_BY_STRATEGY[strategy] || (strategy ? [strategy] : []);

  // The caller's own strategy is always tried first; altStrategy is the
  // matrix-vocabulary fallback for when the matrices have no row for it.
  const altStrategies = MATRIX_STRATEGY[strategy] || [];
  const inList = (vals) => `in.(${vals.map(encodeURIComponent).join(',')})`;
  const stratEq  = strategy ? `&strategy=eq.${encodeURIComponent(strategy)}` : '';
  const stratAlt = altStrategies.length ? `&strategy=${inList(altStrategies)}` : '';

  console.log('getResourceStack args:', { stage: rawStage, shortStage, strategy, topics, blocker, mode, maxResults });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return vapiResult('Resource lookup unavailable. Say that someone from the Utah REIA team will follow up with the right resources.');
  }

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  const get = async (path) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    } catch (e) {
      console.error('Query error on', path.split('?')[0], '-', e.message);
      return [];
    }
  };

  // PostgREST array operators: cs = contains, ov = overlaps.
  const levelFilter = longStage ? `&educational_level=cs.{${encodeURIComponent(longStage)}}` : '';
  const topicFilter = topics.length ? `&educational_topics=ov.{${topics.map(encodeURIComponent).join(',')}}` : '';

  // Progressive relaxation: try the tightest filter, widen only if empty. Each
  // step is a real fallback, not a default, so a caller with no match still
  // gets something rather than nothing.
  async function widen(steps) {
    for (const step of steps) {
      const rows = await get(step);
      if (rows.length) return rows;
    }
    return [];
  }

  try {
    const want = (c) => categories.includes(c);
    const depth = isSpecific ? maxResults : 3;

    // ─── EDUCATION: routing-matrix tracks, then real courses ────────────────
    const educationP = !want('education') ? [] : (async () => {
      const base = `education_routing_matrix?is_active=eq.true&order=priority.asc&limit=${depth}&select=track_name,description,resource_titles,priority`;
      const stageEq = shortStage ? `&stage=eq.${encodeURIComponent(shortStage)}` : '';
      const rows = await widen([
        stageEq && stratEq  ? `${base}${stageEq}${stratEq}`  : null,
        stageEq && stratAlt ? `${base}${stageEq}${stratAlt}` : null,
        stratEq  ? `${base}${stratEq}`  : null,
        stratAlt ? `${base}${stratAlt}` : null,
        stageEq  ? `${base}${stageEq}`  : null
      ].filter(Boolean));

      const out = rows.map(r => ({
        type: 'education',
        name: r.track_name || 'Education Track',
        description: r.description || (Array.isArray(r.resource_titles) ? r.resource_titles.slice(0, 2).join(' and ') : ''),
        contact: '',
        connection_method: 'resource_page',
        priority: r.priority || 5
      }));

      // Real courses matched on topic and level, not just the abstract track.
      // When the strategy is known, only topic-matched courses qualify. Falling
      // back to level-only matches nearly every course, which pads the answer
      // with material the caller never asked about.
      const cBase = `ghl_educational_courses?is_active=eq.true&limit=${depth}&select=course_name,educational_topics,education_url,paid_education`;
      const courses = await widen(topics.length
        ? [`${cBase}${topicFilter}${levelFilter}`, `${cBase}${topicFilter}`]
        : [levelFilter ? `${cBase}${levelFilter}` : null, cBase].filter(Boolean));

      for (const c of courses) {
        if (out.some(o => o.name === c.course_name)) continue;
        out.push({
          type: 'education',
          name: c.course_name || 'Course',
          description: (c.educational_topics || []).slice(0, 2).join(' and ').replace(/__/g, ' ').replace(/_/g, ' '),
          contact: c.education_url || '',
          connection_method: 'resource_page',
          priority: c.paid_education ? 6 : 5
        });
      }
      return out;
    })();

    // ─── EDUCATORS / MENTORS ────────────────────────────────────────────────
    const educatorP = !want('educator') ? [] : (async () => {
      // Same rule as courses: a known strategy means topic-matched educators
      // only. 43 educators are active, so a level-only fallback would return
      // five essentially arbitrary people.
      const base = `ghl_educators_mentors?is_active=eq.true&limit=${depth}&select=educators_name,educational_topics,educators_url`;
      const rows = await widen(topics.length
        ? [`${base}${topicFilter}${levelFilter}`, `${base}${topicFilter}`]
        : [levelFilter ? `${base}${levelFilter}` : null, base].filter(Boolean));

      return rows.map(r => ({
        type: 'educator',
        name: r.educators_name || 'Utah REIA educator',
        description: (r.educational_topics || []).slice(0, 2).join(' and ').replace(/__/g, ' ').replace(/_/g, ' ')
          || 'Personalized mentorship and strategy sessions',
        contact: r.educators_url || '',
        connection_method: 'warm_intro',
        priority: 4
      }));
    })();

    // ─── TOOLS: routing matrix joined to real records via tool_record_id ────
    const toolP = !want('tool') ? [] : (async () => {
      // Only 11 tool rows exist across 5 strategies, so most callers legitimately
      // have no matching tool. Stop at blocker rather than falling back to "any
      // tool" — a relevant stack of 5 beats a padded 6 with a wrong one in it.
      const base = `tools_routing_matrix?is_active=eq.true&order=priority.asc&limit=${depth}&select=tool_title,recommendation_reason,priority,tool_record_id`;
      const rows = await widen([
        stratEq  ? `${base}${stratEq}`  : null,
        stratAlt ? `${base}${stratAlt}` : null,
        blocker  ? `${base}&blocker=eq.${encodeURIComponent(blocker)}` : null
      ].filter(Boolean));
      if (!rows.length) return [];

      const records = await get(`ghl_tools_resources?is_active=eq.true&limit=50&select=ghl_record_id,resource_title,resource_url,resource_url_nonmember`);
      const byId = new Map(records.map(t => [t.ghl_record_id, t]));

      return rows.map(r => {
        // Prefer the explicit id join; fall back to title match only if absent.
        const rec = byId.get(r.tool_record_id)
          || records.find(t => (t.resource_title || '').toLowerCase() === (r.tool_title || '').toLowerCase())
          || null;
        return {
          type: 'tool',
          name: r.tool_title || rec?.resource_title || 'Calculator',
          description: r.recommendation_reason || 'Analyze your deals before committing',
          contact: rec?.resource_url || rec?.resource_url_nonmember || '',
          connection_method: 'resource_page',
          priority: r.priority || 6
        };
      });
    })();

    // ─── VENDORS ────────────────────────────────────────────────────────────
    const vendorP = !want('vendor') ? [] : (async () => {
      // investor_need carries the same vocabulary as blocker (deals, funding,
      // team, legal, ...), so the caller's blocker picks the right vendor kind.
      const base = `vendor_routing_matrix?is_active=eq.true&order=priority.asc&limit=10&select=investor_need,strategy,vendor_categories,connection_methods,priority`;
      const needEq = blocker ? `&investor_need=eq.${encodeURIComponent(blocker)}` : '';
      const rows = await widen([
        stratEq && needEq  ? `${base}${stratEq}${needEq}`  : null,
        stratAlt && needEq ? `${base}${stratAlt}${needEq}` : null,
        stratEq  ? `${base}${stratEq}`  : null,
        stratAlt ? `${base}${stratAlt}` : null,
        needEq   ? `${base}${needEq}`   : null,
        base
      ].filter(Boolean));
      if (!rows.length) return [];

      // enroll_vendor_match=true is the gate: only vendors who opted into being
      // matched to callers are recommendable. 21 of 112 active vendors are false
      // and must never surface here.
      const vendors = await get(`ghl_vendor_resources?is_active=eq.true&enroll_vendor_match=eq.true&limit=60&select=company_name,business_description,company_phone,company_website,funding_financial,deals_opportunities`);

      const out = [];
      const seen = new Set();
      for (const row of rows) {
        if (out.length >= depth) break;
        const cats = (row.vendor_categories || []).map(c => String(c).toLowerCase());
        // Walk the row's lender types IN PRIORITY ORDER so the correct service for
        // this investor/asset type surfaces first: hard money before DSCR for a
        // flip, DSCR mortgage before hard money for a hold, SDIRA/advisor for
        // passive, commercial bridge for commercial assets. Matching by vendor
        // order (the old behavior) ignored this ordering entirely. An empty cats
        // list (no differentiation) still matches every vendor via the '' sentinel.
        const ordered = cats.length ? cats : [''];
        for (const c of ordered) {
          if (out.length >= depth) break;
          for (const v of vendors) {
            if (out.length >= depth) break;
            const name = v.company_name || '';
            if (!name || seen.has(name)) continue;
            const services = [...(v.funding_financial || []), ...(v.deals_opportunities || [])].map(s => String(s).toLowerCase());
            const hit = c === '' || services.some(s => s.includes(c) || c.includes(s));
            if (!hit) continue;
            seen.add(name);
            out.push({
              type: 'vendor',
              name,
              description: v.business_description || cats.slice(0, 2).join(', '),
              contact: v.company_website || v.company_phone || '',
              connection_method: (row.connection_methods || [])[0] || 'ai_recommendation',
              priority: row.priority || 5,
              tags: services  // funding_financial/deals tokens, so the signal re-rank can read lender type
            });
          }
        }
      }
      return out;
    })();

    // ─── EVENTS ─────────────────────────────────────────────────────────────
    const eventP = !want('event') ? [] : (async () => {
      const today = new Date().toISOString().split('T')[0];
      const rows = await get(`ghl_upcoming_events?is_active=eq.true&event_date=gte.${today}&order=event_date.asc&limit=10&select=event_title,event_subtitle,event_date,event_time,event_location,speaker_name,registration_url,strategies,event_description`);
      if (!rows.length) return [];

      // An event with no strategies listed is open to everyone.
      const relevant = strategy
        ? rows.filter(e => !Array.isArray(e.strategies) || !e.strategies.length ||
            e.strategies.some(s => String(s).toLowerCase().includes(strategy) || strategy.includes(String(s).toLowerCase())))
        : rows;

      return (relevant.length ? relevant : rows).map(e => {
        const when = `${e.event_date || ''}${e.event_time ? ' at ' + e.event_time : ''}`;
        const where = e.event_location ? ` at ${e.event_location}` : '';
        const desc = e.event_subtitle || e.event_description || '';
        return {
          type: 'event',
          name: e.event_title || 'Utah REIA event',
          description: `${desc ? desc + ' ' : ''}${when}${where}`.trim(),
          contact: e.registration_url || '',
          speaker: e.speaker_name || '',
          connection_method: 'event_referral',
          priority: 3
        };
      });
    })();

    const [education, educators, tools, vendors, events] =
      await Promise.all([educationP, educatorP, toolP, vendorP, eventP]);

    const buckets = { education, vendor: vendors, tool: tools, educator: educators, event: events };
    for (const k of Object.keys(buckets)) {
      // Effective rank = base priority + the caller-signal re-rank delta (soft, never
      // hard-excludes). Lower ranks first, so a negative delta floats a resource up.
      for (const r of buckets[k]) r._rank = (r.priority || 5) + reRank(r);
      buckets[k].sort((a, b) => a._rank - b._rank);
    }

    // Round-robin across categories so the default stack is genuinely mixed
    // instead of five results from whichever category happened to score best.
    let top = [];
    if (isSpecific) {
      top = (buckets[categories[0]] || []).slice(0, maxResults);
    } else {
      for (let pass = 0; top.length < maxResults; pass++) {
        let added = 0;
        for (const c of categories) {
          if (top.length >= maxResults) break;
          const item = (buckets[c] || [])[pass];
          if (item) { top.push(item); added++; }
        }
        if (!added) break;
      }
    }

    // ─── GAP LOGGING ────────────────────────────────────────────────────────
    // Persist what the matcher could NOT serve, kept as two separate signals for
    // the problem-taxonomy work (never conflated):
    //   taxonomy gap = the need mapped to nothing  -> which problem to map next
    //   service gap  = a category the caller needed came back empty -> a vendor
    //                  or educator to acquire (demand we are not serving)
    async function logGaps(rows) {
      if (!rows.length) return;
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/resource_gaps`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body: JSON.stringify(rows.map(g => ({
            gap_type: g.gap_type,
            missing_category: g.missing_category || null,
            specific_need: String(args.specific_need || args.goal || '').slice(0, 300),
            stage: rawStage, strategy, blocker,
            requested_mode: mode,
            vapi_call_id: vapiCallId
          })))
        });
      } catch (e) { console.error('gap log error:', e.message); }
    }

    if (top.length === 0) {
      // Asked for one specific category and got nothing = we do not serve it
      // (service gap). Default mode with nothing at all = unmapped need (taxonomy).
      await logGaps([ isSpecific
        ? { gap_type: 'service', missing_category: mode }
        : { gap_type: 'taxonomy', missing_category: null } ]);
      return vapiResult(
        'NO_MATCH — Say exactly this to the caller: ' +
        '"I was not able to find a specific match for what you are looking for right now. ' +
        'I will make sure someone from our Utah REIA team reaches out to you directly to help find the right resources." ' +
        'Then ask "Is there anything else I can help you with today?" and close the call normally with Mahalo.'
      );
    }

    // ─── VOICE RESPONSE ─────────────────────────────────────────────────────
    const parts = top.map((r, i) => {
      const n = i + 1;
      const link = r.contact ? ' I will include the link in your follow-up message.' : '';
      if (r.type === 'vendor') {
        if (r.connection_method === 'warm_intro') {
          return `${n}. ${r.name} — ${r.description}. I will send them your contact info so they reach out within 24 hours.`;
        }
        return `${n}. ${r.name} — ${r.description}.${link}`;
      }
      if (r.type === 'educator') return `${n}. ${r.name} for ${r.description}.${link}`;
      if (r.type === 'tool')     return `${n}. ${r.name} — ${r.description}.${link}`;
      if (r.type === 'event') {
        const sp = r.speaker ? ` featuring ${r.speaker}` : '';
        return `${n}. Upcoming event: ${r.name}${sp} — ${r.description}.${r.contact ? ' I will include the registration link in your follow-up message.' : ''}`;
      }
      return `${n}. ${r.name} — ${r.description}.${link}`;
    });

    const warmIntro = top.some(r => r.connection_method === 'warm_intro')
      ? ' For any warm intro, I will send your contact info to them automatically after this call.'
      : '';

    let closer;
    if (isSpecific && top.length < 5) {
      // Deliver what matched, then offer to widen. Never pad silently.
      const label = { vendor: 'vendors', education: 'trainings', educator: 'educators', tool: 'tools', event: 'events' }[mode] || 'resources';
      closer = ` Those are the ${label} that fit what you described. Would you like me to include some other resources that go along with it?`;
    } else {
      closer = ' Which of these would be most useful to start with, or would you like all of them?';
    }

    const lead = isSpecific
      ? `Here is what I found for you.`
      : `Here are the resources that match your needs.`;

    console.log('getResourceStack returning', top.length, 'of', maxResults,
      '| mode:', mode, '| mix:', top.map(r => r.type).join(','), '|', top.map(r => r.name).join(' / '));

    // ─── SMS LINKS ──────────────────────────────────────────────────────────
    // Lani never reads URLs aloud (they go in the follow-up SMS), so capture the
    // real links for exactly the items she promised a link for — the ones with a
    // web URL in `contact`. Cache them keyed by the Vapi call id so ghl-sync can
    // fold them into the SMS at end of call. Warm-intro vendors are excluded:
    // they were promised a callback, not a link.
    // Exclude warm-intro vendors: the voice told the caller that vendor will
    // reach out and never promised a link, so a link in the SMS would contradict
    // what Lani said. Educators are warm-intro too, but their spoken line does
    // promise a link, so they stay.
    const linkItems = top
      .filter(r => !(r.type === 'vendor' && r.connection_method === 'warm_intro'))
      .filter(r => r.contact && /^https?:\/\//i.test(r.contact))
      .map(r => ({ name: r.name, type: r.type, url: r.contact }));
    const smsLinks = linkItems.length
      ? 'Your links:\n' + linkItems.map(r => `- ${r.name}: ${r.url}`).join('\n')
      : '';

    // Capture the educator in the stack (if any), even when they have no booking
    // URL, so ghl-sync can set bookingRequired=true off a reliable signal rather
    // than the educatorMatch structured output, which does not always emit.
    const educatorItem = top.find(r => r.type === 'educator');
    const educatorName = educatorItem ? (educatorItem.name || '') : '';
    const educatorUrl  = educatorItem ? (educatorItem.contact || '') : '';

    if (vapiCallId && (smsLinks || educatorName)) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/voice_agent_stack_links?on_conflict=vapi_call_id`, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            vapi_call_id: vapiCallId,
            sms_links: smsLinks,
            links: linkItems,
            educator_name: educatorName,
            educator_url: educatorUrl,
            mode
          })
        });
      } catch (e) {
        console.error('stack-links cache write error:', e.message);
      }
    }

    // A stack got delivered, but the caller's blocker routes to a vendor need and
    // we matched none — a service gap (vendor to acquire) even though other
    // categories filled the stack.
    if (!isSpecific && blocker && (buckets.vendor || []).length === 0) {
      await logGaps([{ gap_type: 'service', missing_category: 'vendor' }]);
    }

    const voiceText = `${lead} ${parts.join(' ')}${warmIntro}${closer}`;
    if (toolCallId) return res.status(200).json({ results: [{ toolCallId, result: voiceText }], links: linkItems, sms_links: smsLinks });
    return res.status(200).json({ result: voiceText, links: linkItems, sms_links: smsLinks });

  } catch (e) {
    console.error('getResourceStack error:', e.message);
    return vapiResult('Resource lookup encountered an error. Say that someone from the Utah REIA team will follow up with the right resources.');
  }
}
