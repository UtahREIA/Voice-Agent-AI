/**
 * gaps.js — read the resource-gap tracker
 *
 * Surfaces what getResourceStack could not serve, as two SEPARATE signals:
 *   service  -> a category the caller needed came back empty  = vendor/educator
 *               to acquire (demand we are not serving)
 *   taxonomy -> the need mapped to nothing                     = a problem to map
 *               next in the secondary-questioning taxonomy
 *
 * GET /api/gaps?type=service|taxonomy&days=90&limit=500
 *   type   optional; omit to return both, keyed separately
 *   days   lookback window (default 90)
 *   limit  max raw rows scanned per type (default 500, capped 2000)
 *
 * Each type is aggregated by its structured dimensions and ranked by how often
 * it occurs, with up to 5 sample verbatim caller needs per group.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Use GET' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).json({ ok: false, error: 'Supabase not configured' });

  const days  = Math.max(parseInt(req.query?.days, 10) || 90, 1);
  const limit = Math.min(parseInt(req.query?.limit, 10) || 500, 2000);
  const wanted = ['service', 'taxonomy'].includes(req.query?.type) ? [req.query.type] : ['service', 'taxonomy'];
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  // Group by structured dimensions, count occurrences, keep sample needs.
  const aggregate = (rows, type) => {
    const groups = new Map();
    for (const r of rows) {
      const key = type === 'service'
        ? `${r.missing_category || '?'}|${r.strategy || '?'}|${r.blocker || '?'}`
        : `${r.strategy || '?'}|${r.blocker || '?'}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          ...(type === 'service' ? { missing_category: r.missing_category || null } : {}),
          strategy: r.strategy || null,
          blocker: r.blocker || null,
          occurrences: 0,
          unresolved: 0,
          last_seen: r.created_at,
          sample_needs: []
        };
        groups.set(key, g);
      }
      g.occurrences++;
      if (!r.resolved) g.unresolved++;
      if (r.created_at > g.last_seen) g.last_seen = r.created_at;
      const need = (r.specific_need || '').trim();
      if (need && g.sample_needs.length < 5 && !g.sample_needs.includes(need)) g.sample_needs.push(need);
    }
    return Array.from(groups.values()).sort((a, b) => b.occurrences - a.occurrences);
  };

  try {
    const out = {};
    for (const type of wanted) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/resource_gaps?gap_type=eq.${type}&created_at=gte.${encodeURIComponent(since)}` +
        `&order=created_at.desc&limit=${limit}&select=missing_category,strategy,blocker,specific_need,resolved,created_at`,
        { headers }
      );
      const rows = await r.json();
      const list = Array.isArray(rows) ? rows : [];
      out[type] = { total: list.length, groups: aggregate(list, type) };
    }
    return res.status(200).json({
      ok: true,
      window_days: days,
      ...out,
      note: 'service = vendor/educator acquisition signal (demand not served). taxonomy = problems to map next (need matched nothing). Kept separate.'
    });
  } catch (e) {
    console.error('gaps read error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
