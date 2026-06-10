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

    // Normalize inputs
    const stageKey = (stage || '').toLowerCase().replace(/ /g, '_').replace('/', '_');
    const strategyKey = (strategy || '').toLowerCase().replace(/ /g, '_').replace(/ and /g, '_and_');

    // Step 1 — query education_routing_matrix for stage x strategy match
    if (stageKey && strategyKey) {
      const matrixResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_routing_matrix?stage=eq.${encodeURIComponent(stageKey)}&strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&select=track_name,description,resource_titles,resource_types,delivery_methods&order=priority.asc&limit=1`,
        { headers: baseHeaders }
      );
      const matrixData = await matrixResp.json();

      if (matrixData.length > 0) {
        const track = matrixData[0];
        results.push({ type: 'track', ...track });
      }
    }

    // Step 2 — query education_resources table for specific resources
    const resourceResp = await fetch(
      `${SUPABASE_URL}/rest/v1/education_resources?is_active=eq.true&select=title,resource_type,stages,strategies,goals,blockers,description,educator_name,educator_specialty,booking_url,priority&order=priority.asc&limit=100`,
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

    // Lead with track if found
    if (results.length > 0) {
      const track = results[0];
      parts.push(`Based on where you are, the right track for you is ${track.track_name}. ${track.description}`);
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
      return res.status(200).json({
        result: 'The Investor Academy has content covering most strategies and stages. Our monthly events are the fastest way to get connected with investors doing what you want to do.'
      });
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
    // from education_resources table. This adds Mohammed's name and booking URL
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
    return res.status(200).json({
      result: finalResultWithTool,
      educator_name: educatorName,
      booking_url: bookingUrl
    });

  } catch(e) {
    console.error('Education match error:', e.message);
    return res.status(200).json({
      result: 'We have calculators, event replays, and educators covering every major strategy. Tell me what you are working on and I can point you to exactly the right resource.'
    });
  }
}