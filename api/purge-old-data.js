/**
 * purge-old-data.js — retention purge for old call-activity data (Item 15)
 *
 * Retention window: 90 days (set 2026-07-31). Deletes rows older than the window
 * from the call-activity tables below. Does NOT touch contacts, investor_profiles
 * or vendor_profiles — those are directory/profile records, not call activity.
 *
 * DEFAULT IS DRY-RUN. It only reports what it WOULD delete. It deletes solely
 * when ?confirm=<value equal to env PURGE_CONFIRM_TOKEN> is passed (the same
 * secret that gates reconcile-contacts). With no token set, purge is refused, so
 * deploying this cannot delete anything until an operator opts in.
 *
 * RECALL TRADEOFF: voice_agent_calls feeds the returning-caller recall in
 * member-lookup. Purging it at 90 days means a caller who last called more than
 * 90 days ago is treated as new. That is an accepted consequence of the window.
 * To preserve recall, remove 'voice_agent_calls' from RETENTION_TABLES (or move
 * it to a longer window) — everything else is unaffected.
 *
 * Usage:
 *   dry-run: GET /api/purge-old-data
 *   purge:   GET /api/purge-old-data?confirm=<token>
 *   override window for one call: &days=60
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY),
 *      PURGE_CONFIRM_TOKEN (only needed to actually delete),
 *      RETENTION_DAYS (optional, defaults to 90).
 */

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const PURGE_CONFIRM_TOKEN = process.env.PURGE_CONFIRM_TOKEN || '';
const DEFAULT_DAYS = parseInt(process.env.RETENTION_DAYS, 10) || 90;

// Call-activity tables purged on the retention window. Most are aged by created_at;
// voice_agent_calls carries the recall tradeoff noted above. intake_state is the
// transient per-call routing cache (see intake.js) — one row per call, only useful
// during the call, and it only has updated_at.
const RETENTION_TABLES = [
  'voice_agent_stack_links',
  'routing_results',
  'readiness_surveys',
  'voice_agent_calls',
  'intake_state'
];

// Timestamp column each table is aged on (default created_at; exceptions here).
const TS_COLUMN = { intake_state: 'updated_at' };
const tsCol = (table) => TS_COLUMN[table] || 'created_at';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'Supabase not configured' });
  }

  const days = Math.max(parseInt(req.query?.days, 10) || DEFAULT_DAYS, 1);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Accept the confirm token from ?confirm= OR an Authorization: Bearer header.
  // The header keeps the secret out of URLs and logs, and matches how the
  // sync-ghl-objects GitHub Actions cron authenticates.
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const providedToken = req.query?.confirm || bearer || '';
  const confirmOk = PURGE_CONFIRM_TOKEN && providedToken === PURGE_CONFIRM_TOKEN;
  const doPurge = Boolean(confirmOk);
  const purgeRefused = (providedToken && !confirmOk)
    ? (!PURGE_CONFIRM_TOKEN ? 'PURGE_CONFIRM_TOKEN is not set on the server' : 'confirm token did not match')
    : null;

  const sbHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  // Pull the exact row count from PostgREST's Content-Range header ("*/N" or
  // "0-24/N"), which both count=exact requests return without a heavy payload.
  const countFrom = (r) => {
    const cr = r.headers.get('content-range') || '';
    const n = cr.split('/')[1];
    return n && n !== '*' ? parseInt(n, 10) : 0;
  };

  const filter = (table) => `${SUPABASE_URL}/rest/v1/${table}?${tsCol(table)}=lt.${encodeURIComponent(cutoff)}`;

  try {
    const result = {};
    for (const table of RETENTION_TABLES) {
      // Always measure first.
      const measure = await fetch(`${filter(table)}&select=${tsCol(table)}&limit=1`, {
        headers: { ...sbHeaders, 'Prefer': 'count=exact' }
      });
      const eligible = countFrom(measure);

      let deleted = 0;
      if (doPurge && eligible > 0) {
        const delResp = await fetch(filter(table), {
          method: 'DELETE',
          headers: { ...sbHeaders, 'Prefer': 'count=exact,return=minimal' }
        });
        deleted = countFrom(delResp);
      }
      result[table] = doPurge ? { eligible, deleted } : { eligible };
    }

    console.log('purge-old-data —', doPurge ? 'PURGE' : 'dry-run',
      '| window:', days + 'd', '| cutoff:', cutoff,
      '|', Object.entries(result).map(([t, v]) => `${t}:${doPurge ? v.deleted : v.eligible}`).join(' '));
    if (purgeRefused) console.warn('purge-old-data — purge refused:', purgeRefused);

    return res.status(200).json({
      ok: true,
      mode: doPurge ? 'PURGE (rows deleted)' : 'dry-run (deletes nothing)',
      purge_refused: purgeRefused || undefined,
      retention_days: days,
      cutoff,
      tables: result,
      note: doPurge
        ? 'Rows older than the window were deleted.'
        : 'Dry-run. To delete, set PURGE_CONFIRM_TOKEN on the server and call with ?confirm=<token>. voice_agent_calls is included — see the recall tradeoff in the file header.'
    });
  } catch (e) {
    console.error('purge-old-data error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
