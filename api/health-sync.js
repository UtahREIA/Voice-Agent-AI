/**
 * health-sync.js — staleness watchdog for the nightly GHL -> Supabase sync.
 *
 * WHY THIS EXISTS: on 2026-08-14 the nightly sync (sync-ghl-objects) started failing
 * on an invalid GHL Private Integration token, and nobody was alerted for ~7 weeks
 * (Chris, item 62). Tools, classes, educators, vendors and events all went stale with
 * no signal. This checks how long ago each ghl_* mirror table last updated and flags
 * when the feed has gone stale, so a dead sync is caught in a day, not weeks.
 *
 * HOW IT RUNS: a GitHub Actions workflow (.github/workflows/health-sync.yml) curls this
 * on a schedule; a failed run emails the repo admins (optional Slack via SLACK_WEBHOOK_URL).
 * It reads Supabase directly, so it does NOT depend on the GHL token that is the usual
 * culprit -- which is exactly why it can still report when that token is the problem.
 *
 * AUTH: optional. If HEALTHCHECK_TOKEN is set, a matching Bearer token is required.
 *
 * Responses (always HTTP 200; the workflow reads the JSON):
 *   { ok:true,  newest_age_hours, threshold_hours, tables:[...] }
 *   { ok:false, error:'stale', stale:[{table, age_hours}], threshold_hours, tables:[...] }
 *   { ok:false, error:'query_failed'|'not_configured', ... }
 *
 * LANI V2 PROMPT FRESHNESS: every response also carries a `lani` block.
 *   lani.configured:false while VAPI_API_KEY is unset (never alerts then).
 * Once configured, the check fails (ok:false) with error:
 *   'lani_prompt_failed'   the latest lani_prompt_builds row is failed
 *   'lani_prompt_missing'  no build at all
 *   'lani_prompt_stale'    the latest ok/unchanged build is more than
 *                          LANI_STALE_HOURS (2) older than the newest ghl_* synced_at
 *                          (dry_run also counts while LANI_PROMPT_WRITE is not "true")
 * Table staleness keeps its own error and is reported first.
 */

export const config = { maxDuration: 15 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || '';
// Sync runs nightly (~03:00 UTC), so healthy data is < ~24h old. 36h allows one missed
// run before alerting. Override via env SYNC_STALE_HOURS.
const THRESHOLD_HOURS = parseInt(process.env.SYNC_STALE_HOURS, 10) || 36;
const TABLES = [
  'ghl_vendor_resources',
  'ghl_educators_mentors',
  'ghl_educational_courses',
  'ghl_tools_resources'
];
const TIMEOUT_MS = 10000;
const VAPI_CONFIGURED = Boolean(process.env.VAPI_API_KEY);
const LANI_STALE_HOURS = 2;
// While writes are off every build is a dry_run, so a recent dry_run counts as
// fresh; once LANI_PROMPT_WRITE is "true" only ok/unchanged count.
const LANI_GOOD_STATUSES = process.env.LANI_PROMPT_WRITE === 'true' ? 'ok,unchanged' : 'ok,unchanged,dry_run';

// Lani V2 prompt freshness. newestSyncIso is the newest synced_at across the
// ghl_* tables read above. Returns { configured, ok, error?, ... }.
async function checkLaniPrompt(newestSyncIso) {
  if (!VAPI_CONFIGURED) return { configured: false, ok: true };
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const read = async (q) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/lani_prompt_builds?${q}`, { headers, signal: controller.signal });
      if (!r.ok) throw new Error(`http_${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  };
  try {
    const latest = (await read('select=status,built_at,error&order=built_at.desc&limit=1'))[0] || null;
    if (!latest) return { configured: true, ok: false, error: 'lani_prompt_missing' };
    if (latest.status === 'failed') {
      return { configured: true, ok: false, error: 'lani_prompt_failed', latest_status: latest.status, latest_at: latest.built_at, latest_error: latest.error };
    }
    const good = (await read(`status=in.(${LANI_GOOD_STATUSES})&select=status,built_at&order=built_at.desc&limit=1`))[0] || null;
    const goodTs = good ? new Date(good.built_at).getTime() : null;
    const syncTs = newestSyncIso ? new Date(newestSyncIso).getTime() : null;
    const lagHours = goodTs && syncTs ? +(((syncTs - goodTs) / 3600000).toFixed(1)) : null;
    if (!good || (lagHours != null && lagHours > LANI_STALE_HOURS)) {
      return { configured: true, ok: false, error: 'lani_prompt_stale', latest_status: latest.status, last_good_at: good?.built_at || null, newest_sync_at: newestSyncIso, lag_hours: lagHours };
    }
    return { configured: true, ok: true, latest_status: latest.status, last_good_at: good.built_at, newest_sync_at: newestSyncIso, lag_hours: lagHours };
  } catch (e) {
    return { configured: true, ok: false, error: 'lani_query_failed', detail: String(e?.message || e).slice(0, 120) };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }
  if (HEALTHCHECK_TOKEN) {
    const auth = req.headers?.authorization || '';
    if (auth !== `Bearer ${HEALTHCHECK_TOKEN}` && req.query?.token !== HEALTHCHECK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'not_configured' });
  }

  const now = Date.now();
  const results = [];
  for (const t of TABLES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${t}?select=synced_at&order=synced_at.desc.nullslast&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, signal: controller.signal }
      );
      if (!r.ok) { results.push({ table: t, error: `http_${r.status}` }); continue; }
      const rows = await r.json();
      const iso = rows?.[0]?.synced_at || null;
      const ts = iso ? new Date(iso).getTime() : null;
      results.push({ table: t, synced_at: iso, age_hours: ts ? +(((now - ts) / 3600000).toFixed(1)) : null });
    } catch (e) {
      results.push({ table: t, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e).slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
  }

  // Every table failed to read = can't assess; alert as a query failure, not false "fresh".
  if (results.every(r => r.error)) {
    return res.status(200).json({ ok: false, error: 'query_failed', tables: results });
  }

  // Stale = no timestamp at all, or older than the threshold.
  const stale = results
    .filter(r => !r.error && (r.age_hours == null || r.age_hours > THRESHOLD_HOURS))
    .map(r => ({ table: r.table, age_hours: r.age_hours }));

  const syncIsos = results.map(r => r.synced_at).filter(Boolean).sort();
  const lani = await checkLaniPrompt(syncIsos.length ? syncIsos[syncIsos.length - 1] : null);

  if (stale.length) {
    return res.status(200).json({ ok: false, error: 'stale', threshold_hours: THRESHOLD_HOURS, stale, tables: results, lani });
  }

  const ages = results.filter(r => r.age_hours != null).map(r => r.age_hours);
  if (!lani.ok) {
    return res.status(200).json({ ok: false, error: lani.error, threshold_hours: THRESHOLD_HOURS, tables: results, lani });
  }
  return res.status(200).json({
    ok: true,
    threshold_hours: THRESHOLD_HOURS,
    newest_age_hours: ages.length ? Math.min(...ages) : null,
    tables: results,
    lani
  });
}
