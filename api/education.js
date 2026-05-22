// Map 3 Education Alignment — queries education_routing_matrix from Supabase
// Accepts all 6 diagnostic dimensions, returns matched education track and resources
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
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
  } = req.body || {};

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

    console.log(`Education match — track: ${results.length > 0 ? results[0].track_name : 'none'}, resources: ${scored.length} scored`);
    return res.status(200).json({ result });

  } catch(e) {
    console.error('Education match error:', e.message);
    return res.status(200).json({
      result: 'We have calculators, event replays, and educators covering every major strategy. Tell me what you are working on and I can point you to exactly the right resource.'
    });
  }
}