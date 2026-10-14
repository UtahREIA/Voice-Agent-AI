/**
 * dashboard-data.js — read-only metrics feed for the Chris dashboard (public/dashboard.html).
 *
 * Calls the Postgres function public.dashboard_metrics() (read-only, STABLE) and returns its
 * JSON. The Supabase service key stays server-side; the page never sees it.
 *
 * Data sources behind the function:
 *   routing_results   — every routing decision. Currently all trigger_source='field_change'
 *                       (the non-voice / survey-driven routing path), ~2,400 rows and growing.
 *   voice_agent_calls — voice-call records. Sparse right now (end-of-call save paused since
 *                       2026-08-13); fills in once the Vapi server URL is reconnected.
 *
 * AUTH: optional. If DASHBOARD_TOKEN is set, a matching ?token= or Bearer token is required.
 */

export const config = { maxDuration: 15 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });
  if (DASHBOARD_TOKEN) {
    const t = req.query?.token || (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (t !== DASHBOARD_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).json({ error: 'not_configured' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/dashboard_metrics`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(200).json({ error: 'rpc_failed', status: r.status, detail: body.slice(0, 200) });
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ error: String(e?.message || e).slice(0, 160) });
  }
}
