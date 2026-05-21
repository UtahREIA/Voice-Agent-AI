// Map 3 Education Alignment — queries education_resources table from Supabase
// Returns matched calculators, event replays, and training based on investor profile
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { stage, strategy, goal, blocker, resource_type } = req.body || {};
  console.log('Education match — stage:', stage, 'strategy:', strategy, 'goal:', goal, 'blocker:', blocker);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Fetch all active resources
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/education_resources?is_active=eq.true&select=title,resource_type,stages,strategies,goals,blockers,description,educator_name,educator_specialty,booking_url,event_date,priority&order=priority.asc&limit=100`,
      { headers: baseHeaders }
    );
    const resources = await resp.json();

    // Score each resource by how well it matches the caller profile
    const scored = resources
      .filter(r => {
        if (resource_type && r.resource_type !== resource_type) return false;
        return true;
      })
      .map(r => {
        let score = 0;

        // Stage match
        if (stage && r.stages) {
          const stageKey = stage.toLowerCase().replace(/ /g, '_').replace('/', '_');
          if (r.stages.some(s => stageKey.includes(s) || s.includes(stageKey))) score += 3;
        }

        // Strategy match
        if (strategy && r.strategies) {
          const stratKey = strategy.toLowerCase().replace(/ /g, '_');
          if (r.strategies.some(s => stratKey.includes(s) || s.includes(stratKey))) score += 3;
        }

        // Goal match
        if (goal && r.goals) {
          const goalKey = goal.toLowerCase().replace(/ /g, '_');
          if (r.goals.some(g => goalKey.includes(g) || g.includes(goalKey))) score += 2;
        }

        // Blocker match
        if (blocker && r.blockers) {
          if (r.blockers.some(b => blocker.toLowerCase().includes(b) || b.includes(blocker.toLowerCase()))) score += 2;
        }

        return { ...r, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || a.priority - b.priority);

    if (scored.length === 0) {
      return res.status(200).json({
        result: 'The Investor Academy has replays covering most major strategies. The Deal Center has active listings from community members. Both are solid starting points depending on what you are working on.'
      });
    }

    // Build a natural spoken response from top matches
    const top = scored.slice(0, 3);
    const parts = [];

    top.forEach(r => {
      if (r.resource_type === 'calculator') {
        parts.push(`the ${r.title} — ${r.description}`);
      } else if (r.resource_type === 'event_replay') {
        parts.push(`a replay from our ${r.title} event — ${r.description}`);
      } else if (r.resource_type === 'educator') {
        const who = r.educator_name ? `${r.educator_name}` : r.title;
        parts.push(`${who} — ${r.educator_specialty || r.description}`);
      } else {
        parts.push(`${r.title} — ${r.description}`);
      }
    });

    let result = '';
    if (parts.length === 1) {
      result = `Here is what I would point you to: ${parts[0]}.`;
    } else if (parts.length === 2) {
      result = `Two things for you. First, ${parts[0]}. Second, ${parts[1]}.`;
    } else {
      result = `Three resources for where you are. First, ${parts[0]}. Second, ${parts[1]}. Third, ${parts[2]}.`;
    }

    console.log(`Education match — ${scored.length} resources scored, returning top ${top.length}`);
    return res.status(200).json({ result });

  } catch(e) {
    console.error('Education match error:', e.message);
    return res.status(200).json({
      result: 'We have calculators for every strategy and event replays covering deal analysis, funding, and fix and flip. Let me know which area you want to dig into and I can point you to the right one.'
    });
  }
}
