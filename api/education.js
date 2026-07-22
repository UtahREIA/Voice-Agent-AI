// Map 3 Education Alignment — queries education_routing_matrix from Supabase
// Accepts all 6 diagnostic dimensions, returns matched education track and resources
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Extract tool arguments from all possible Vapi request formats
  // Vapi sends arguments nested inside toolCallList[0].function.arguments as a JSON string
  // not directly in req.body — this caused "No result returned" errors on every tool call
  function extractArgs(body) {
    if (body && (body.stage !== undefined || body.strategy !== undefined || body.blocker !== undefined)) {
      return body; // direct body format
    }
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (args) return typeof args === 'string' ? JSON.parse(args) : args;
    } catch(e) {}
    return body || {};
  }

  const args = extractArgs(req.body);

  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id
    || req.body?.message?.toolCalls?.[0]?.id
    || req.body?.toolCallList?.[0]?.id
    || null;

  function vapiResult(resultOrObj) {
    const resultStr = typeof resultOrObj === 'object' && resultOrObj !== null
      ? (resultOrObj.result || JSON.stringify(resultOrObj))
      : String(resultOrObj);
    if (toolCallId) return { results: [{ toolCallId, result: resultStr }] };
    return { result: resultStr };
  }
  const {
    stage,
    strategy,
    goal,
    blocker,
    resource_type,
    already_tried,
    readiness,
    capital_range
  } = args;

  console.log('Education match — stage:', stage, 'strategy:', strategy, 'goal:', goal, 'blocker:', blocker);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    const results = [];

    // --- STAGE NORMALIZATION ---
    // Map all possible caller stage inputs to education_routing_matrix stage keys
    const stageMapping = {
      'exploring':        'exploring',
      'exploring__new':   'exploring',
      'new':              'exploring',
      'beginner':         'exploring',
      'just_starting':    'exploring',
      'getting_started':  'getting_started',
      'first_deal':       'getting_started',
      'active':           'active',
      'active_investor':  'active',
      'experienced':      'experienced',
      'experienced_investor': 'experienced',
      'advanced':         'experienced',
      'veteran':          'veteran',
      'operator':         'veteran',
      'veteran__operator':'veteran',
    };
    const rawStage = (stage || '').toLowerCase().replace(/ /g, '_').replace('/', '_');
    const stageKey = stageMapping[rawStage] || rawStage;

    // --- STRATEGY NORMALIZATION ---
    // Map all possible caller strategy inputs to education_routing_matrix strategy keys
    const strategyMapping = {
      'fix_and_flip':         'fix_and_flip',
      'fix__flip':            'fix_and_flip',
      'flipping':             'fix_and_flip',
      'flip':                 'fix_and_flip',
      'buy_and_hold':         'buy_and_hold',
      'buy__hold':            'buy_and_hold',
      'buy__hold__rentals':   'buy_and_hold',
      'rentals':              'buy_and_hold',
      'rental':               'buy_and_hold',
      'wholesale':            'wholesale',
      'wholesaling':          'wholesale',
      'wholesaling':          'wholesaling',
      'brrrr':                'brrrr',
      'buy_rehab_rent_refinance_repeat': 'brrrr',
      'short_term_rental':    'short_term_rental',
      'str':                  'short_term_rental',
      'airbnb':               'short_term_rental',
      'vrbo':                 'short_term_rental',
      'creative_financing':   'creative_financing',
      'creative_finance':     'creative_financing',
      'subject_to':           'creative_financing',
      'seller_finance':       'creative_financing',
      'development':          'development',
      'land_development':     'development',
      'new_construction':     'development',
      'notes_lending':        'notes_and_lending',
      'notes_and_lending':    'notes_and_lending',
      'note_investing':       'notes_and_lending',
      'lending':              'notes_and_lending',
      'raising_capital':      'raising_capital',
      'private_money':        'raising_capital',
      'capital_raising':      'raising_capital',
      'commercial':           'commercial',
      'multi_family':         'commercial',
      'multifamily':          'commercial',
      'syndication':          'raising_capital',
      'not_sure':             'not_sure_yet',
      'not_sure_yet':         'not_sure_yet',
      'unsure':               'not_sure_yet',
      'tax_optimization':     'tax_optimization',
      'tax_strategy':         'tax_optimization',
      'tax_deeds':            'tax_deeds',
      'tax_deeds_liens':      'tax_deeds',
      'out_of_state':         'out_of_state',
      'remote_investing':     'out_of_state',
      'mentoring_others':     'mentoring_others',
      'house_hacking':        'buy_and_hold',
      'mid_term_coliving':    'short_term_rental',
      'passive_investing':    'raising_capital',
      'assisted_living':      'commercial',
      'self_storage':         'commercial',
      'mobile_home':          'commercial',
      'hotel':                'commercial',
      'retail':               'commercial',
      'industrial':           'commercial',
      'rv_parks':             'commercial',
      'farm_land':            'development',
      'land_entitlement':     'development',
    };
    const rawStrategy = (strategy || '').toLowerCase().replace(/ /g, '_');
    const strategyKey = strategyMapping[rawStrategy] || rawStrategy;

    // --- STEP 1: Three-tier matrix lookup ---
    // Tier 1: exact stage + strategy match
    // Tier 2: same stage, any strategy (stage-level track)
    // Tier 3: any stage, same strategy (strategy foundation)
    let matrixRow = null;

    if (stageKey && strategyKey) {
      // Try exact match first (also try wholesaling variant)
      const exactResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_routing_matrix?stage=eq.${encodeURIComponent(stageKey)}&strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&select=track_name,description,resource_titles,resource_types,delivery_methods&order=priority.asc&limit=1`,
        { headers: baseHeaders }
      );
      const exactData = await exactResp.json();
      if (Array.isArray(exactData) && exactData.length > 0) matrixRow = exactData[0];

      // Try wholesaling as alternate key if wholesale didn't match
      if (!matrixRow && (strategyKey === 'wholesale' || strategyKey === 'wholesaling')) {
        const altKey = strategyKey === 'wholesale' ? 'wholesaling' : 'wholesale';
        const altResp = await fetch(
          `${SUPABASE_URL}/rest/v1/education_routing_matrix?stage=eq.${encodeURIComponent(stageKey)}&strategy=eq.${encodeURIComponent(altKey)}&is_active=eq.true&select=track_name,description,resource_titles,resource_types,delivery_methods&order=priority.asc&limit=1`,
          { headers: baseHeaders }
        );
        const altData = await altResp.json();
        if (Array.isArray(altData) && altData.length > 0) matrixRow = altData[0];
      }
    }

    // Tier 2: fall back to stage only
    if (!matrixRow && stageKey) {
      const stageResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_routing_matrix?stage=eq.${encodeURIComponent(stageKey)}&is_active=eq.true&select=track_name,description,resource_titles,resource_types,delivery_methods&order=priority.asc&limit=1`,
        { headers: baseHeaders }
      );
      const stageData = await stageResp.json();
      if (Array.isArray(stageData) && stageData.length > 0) matrixRow = stageData[0];
    }

    // Tier 3: fall back to strategy only
    if (!matrixRow && strategyKey) {
      const stratResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_routing_matrix?strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&select=track_name,description,resource_titles,resource_types,delivery_methods&order=priority.asc&limit=1`,
        { headers: baseHeaders }
      );
      const stratData = await stratResp.json();
      if (Array.isArray(stratData) && stratData.length > 0) matrixRow = stratData[0];
    }

    if (matrixRow) {
      results.push({ type: 'track', ...matrixRow });
    }

    // Step 2 — query education_resources table for specific resources
    const resourceResp = await fetch(
      `${SUPABASE_URL}/rest/v1/ghl_educational_courses?is_active=eq.true&select=course_name,educational_topics,educational_level,video_url,education_url,paid_education,membership_required&order=course_name.asc&limit=100`,
      { headers: baseHeaders }
    );
    const resources = await resourceResp.json();

    // Filter out already tried resources
    const alreadyTriedList = already_tried
      ? already_tried.toLowerCase().split(',').map(s => s.trim())
      : [];

    // Score resources against all dimensions
    const scored = resources
      .filter(r => {
        if (resource_type && r.resource_type !== resource_type) return false;
        // Filter out already tried
        if (alreadyTriedList.some(tried =>
          r.title.toLowerCase().includes(tried) ||
          (r.description || '').toLowerCase().includes(tried)
        )) return false;
        return true;
      })
      .map(r => {
        let score = 0;

        if (stageKey && r.stages?.some(s =>
          stageKey.includes(s) || s.includes(stageKey)
        )) score += 3;

        if (strategyKey && r.strategies?.some(s =>
          strategyKey.includes(s) || s.includes(strategyKey)
        )) score += 3;

        if (goal && r.goals?.some(g =>
          goal.toLowerCase().replace(/ /g, '_').includes(g) || g.includes(goal.toLowerCase().replace(/ /g, '_'))
        )) score += 2;

        if (blocker && r.blockers?.some(b =>
          blocker.toLowerCase().includes(b) || b.includes(blocker.toLowerCase())
        )) score += 2;

        // Boost educators for experienced/veteran callers
        if (r.resource_type === 'educator' && ['experienced', 'veteran', 'active'].includes(stageKey)) {
          score += 1;
        }

        return { ...r, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.priority - b.priority);

    // Build natural spoken response
    const parts = [];

    // Lead with track if found — include resource titles for concrete delivery
    if (results.length > 0) {
      const track = results[0];
      const topResources = (track.resource_titles || []).slice(0, 2).join(' and ');
      const deliveryMethods = (track.delivery_methods || []).join(' or ');
      let trackIntro = `The right track for you is the ${track.track_name}. ${track.description}`;
      if (topResources) trackIntro += ` Start with: ${topResources}.`;
      if (deliveryMethods) trackIntro += ` Delivered via ${deliveryMethods}.`;
      parts.push(trackIntro);
    }

    // Add top matched resources
    const topResources = scored.slice(0, 3);
    topResources.forEach(r => {
      if (r.resource_type === 'calculator') {
        parts.push(`the ${r.title} — ${r.description}`);
      } else if (r.resource_type === 'event_replay') {
        parts.push(`a replay from our ${r.title} event — ${r.description}`);
      } else if (r.resource_type === 'educator') {
        const booking = r.booking_url ? ` You can connect with them at ${r.booking_url}` : '';
        parts.push(`${r.educator_name} — ${r.educator_specialty || r.description}.${booking}`);
      } else if (r.resource_type === 'lead_magnet') {
        parts.push(`${r.title} — ${r.description}`);
      } else {
        parts.push(`${r.title} — ${r.description}`);
      }
    });

    // Fallback if nothing matched
    if (parts.length === 0) {
      return res.status(200).json(vapiResult('The Investor Academy has content covering most strategies and stages. Our monthly events are the fastest way to get connected with investors doing what you want to do.'));
    }

    let result = '';
    if (parts.length === 1) {
      result = parts[0];
    } else if (parts.length === 2) {
      result = `Two things for you. First, ${parts[0]}. Second, ${parts[1]}.`;
    } else {
      result = `Here is the stack for where you are. First, ${parts[0]}. Second, ${parts[1]}. Third, ${parts[2]}.`;
    }

    // --- EDUCATOR LOOKUP ---
    // After matching a track, look up the best educator for this stage+strategy
    // from ghl_educational_courses table. This adds Mohammed's name and booking URL
    // to the response so Claude can deliver a complete, personalized recommendation.
    let educatorResult = '';
    let educatorName = '';
    let bookingUrl = '';

    try {
      // Build filter to match educator specialties against caller's stage and strategy
      // Query ghl_educators_mentors (synced from GHL custom objects) — source of truth for educators
      const educatorResp = await fetch(
        `${SUPABASE_URL}/rest/v1/ghl_educators_mentors?select=educators_name,educational_topics,educational_level,educators_url&is_active=eq.true&limit=10`,
        { headers: baseHeaders }
      );
      const educators = await educatorResp.json();

      if (Array.isArray(educators) && educators.length > 0) {
        // Score educators by how well they match the caller's stage and strategy
        const scoredEducators = educators
          .filter(e => e.educators_name && e.educators_url)
          .map(e => {
            let score = 0;
            const levels = (e.educational_level || []).map(l => l.toLowerCase());
            const topics = (e.educational_topics || []).map(t => t.toLowerCase());
            if (stageKey && levels.some(l => l.includes(stageKey.replace('_', ' ')))) score += 10;
            if (strategyKey && topics.some(t => t.includes(strategyKey.replace('_', ' ')))) score += 5;
            return { ...e, score };
          })
          .sort((a, b) => b.score - a.score);

        const bestEducator = scoredEducators[0];
        if (bestEducator && bestEducator.score > 0) {
          educatorName = bestEducator.educators_name;
          bookingUrl = bestEducator.educators_url;
          const specialty = (bestEducator.educational_topics || []).slice(0, 2).join(' and ');
          educatorResult = ' I would also connect you with ' + educatorName + ' who specializes in ' + (specialty || 'real estate investing') + '. You can book a session at ' + bookingUrl + '.';
        }
      }
    } catch(e) {
      console.error('Educator lookup error:', e.message);
    }

    // Append educator recommendation to result if found
    const finalResult = result + educatorResult;

    // --- TOOLS LOOKUP from tools_routing_matrix ---
    // Query tools that match this caller's stage and strategy
    // This surfaces calculator and tool recommendations alongside education tracks
    let toolResult = '';
    try {
      // Try stage + strategy match first, fall back to strategy only
      let toolRows = [];
      if (stageKey && strategyKey) {
        const toolResp = await fetch(
          `${SUPABASE_URL}/rest/v1/tools_routing_matrix?stage=eq.${encodeURIComponent(stageKey)}&strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&order=priority.asc&limit=2`,
          { headers: baseHeaders }
        );
        toolRows = await toolResp.json();
      }
      if (!Array.isArray(toolRows) || toolRows.length === 0) {
        const toolResp2 = await fetch(
          `${SUPABASE_URL}/rest/v1/tools_routing_matrix?stage=is.null&strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&order=priority.asc&limit=2`,
          { headers: baseHeaders }
        );
        toolRows = await toolResp2.json();
      }

      if (Array.isArray(toolRows) && toolRows.length > 0) {
        const topTool = toolRows[0];
        toolResult = ' I also recommend the ' + topTool.tool_title + ' — ' + topTool.recommendation_reason;
      }
    } catch(e) {
      console.error('Tools routing lookup error:', e.message);
    }

    // Append tool recommendation to final result if found
    const finalResultWithTool = finalResult + toolResult;

    console.log(`Education match — track: ${results.length > 0 ? results[0].track_name : 'none'}, educator: ${educatorName || 'none'}, resources: ${scored.length} scored`);
    return res.status(200).json(vapiResult(finalResultWithTool));

  } catch(e) {
    console.error('Education match error:', e.message);
    return res.status(200).json(vapiResult('We have calculators, event replays, and educators covering every major strategy. Tell me what you are working on and I can point you to exactly the right resource.'));
  }
}