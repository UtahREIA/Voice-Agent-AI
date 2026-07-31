/**
 * reconcile-contacts.js — GHL-deletion reconciliation (Item 16)
 *
 * Finds Supabase contact records whose GHL contact has been deleted, and — only
 * when explicitly and securely asked — purges them and their downstream data.
 *
 * DEFAULT IS DETECT-ONLY. It deletes nothing unless BOTH are true:
 *   ?purge=true  AND  ?confirm=<value equal to env PURGE_CONFIRM_TOKEN>
 * If PURGE_CONFIRM_TOKEN is unset (it is not set by default), purge is refused,
 * so deploying this file cannot delete anything until an operator deliberately
 * sets that secret in Vercel and passes it. Knowing the URL is not enough.
 *
 * Why reconciliation and not a delete webhook: GHL custom objects 403 from
 * external IPs, but contact-level v2 reads work from the edge (ghl-sync and
 * member-lookup already do it), so this runs on Vercel without MCP. Confirmed
 * 2026-07-30.
 *
 * DELETION SEMANTICS: a contact counts as deleted ONLY when GHL returns a
 * not-found MESSAGE. GHL sends this as a 400 (verified 2026-07-30 against ids
 * the GHL MCP confirmed deleted), NOT a 404, so we match the body, not the
 * status. A 429, 5xx, auth failure, malformed-id 400, or network error is an
 * ERROR, never an orphan — so a purge can never act on a transient blip. Each
 * orphan is re-verified live in the same request immediately before deletion;
 * no stale list is ever trusted.
 *
 * CASCADE: contacts FKs are mixed — event_attendance / investor_profiles /
 * tool_access / vendor_profiles CASCADE, but readiness_surveys / routing_results
 * / voice_agent_calls are SET NULL, so deleting the contact alone would LEAVE
 * that data behind. We therefore delete every child explicitly, children first,
 * matching on ghl_contact_id too because voice_agent_calls often has a null
 * contact_id.
 *
 * ~5,200 contacts exist, so a full scan cannot finish in one request. Pages via
 * limit/offset and returns next_offset; walk until null.
 *
 * Usage:
 *   detect: GET /api/reconcile-contacts?limit=50&offset=0
 *   purge:  GET /api/reconcile-contacts?limit=25&offset=0&purge=true&confirm=<token>
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY), GHL_API_KEY,
 *      PURGE_CONFIRM_TOKEN (only needed to actually purge).
 */

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GHL_API_KEY  = process.env.GHL_API_KEY;
const PURGE_CONFIRM_TOKEN = process.env.PURGE_CONFIRM_TOKEN || '';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A GHL "this contact does not exist" message, whatever status it rides on.
// Narrow on purpose: a malformed-id or auth 400 does NOT match and stays an error.
const NOT_FOUND_RE = /not\s*found|does\s*not\s*exist|no\s*contact|doesn'?t\s*exist/i;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!GHL_API_KEY) {
    return res.status(200).json({ ok: false, error: 'GHL_API_KEY not set — cannot verify contacts' });
  }

  const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 400);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

  // Purge is doubly gated: the flag AND a secret token that matches the env. The
  // token may come from ?confirm= or an Authorization: Bearer header (the header
  // keeps it out of URLs/logs and matches the sync-ghl-objects cron).
  const purgeRequested = String(req.query?.purge) === 'true';
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const providedToken = req.query?.confirm || bearer || '';
  const confirmOk = PURGE_CONFIRM_TOKEN && providedToken === PURGE_CONFIRM_TOKEN;
  const doPurge = purgeRequested && confirmOk;
  const purgeRefusedReason = !purgeRequested ? null
    : (!PURGE_CONFIRM_TOKEN ? 'PURGE_CONFIRM_TOKEN is not set on the server'
    : (!confirmOk ? 'confirm token did not match' : null));

  const sbHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };
  const ghlHeaders = {
    'Authorization': `Bearer ${GHL_API_KEY}`,
    'Content-Type': 'application/json',
    'Version': '2021-07-28'
  };

  // DELETE helper — returns how many rows it removed (return=representation).
  const del = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'DELETE',
      headers: { ...sbHeaders, 'Prefer': 'return=representation' }
    });
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  };

  // Purge one orphaned contact and everything that hangs off it. Children first
  // (FK-safe regardless of cascade rules), matching ghl_contact_id where the
  // row may have a null contact_id.
  const purgeOne = async (sid, gid) => {
    const g = encodeURIComponent(gid);
    const both = `or=(contact_id.eq.${sid},ghl_contact_id.eq.${g})`;
    const counts = {};
    counts.voice_agent_calls     = await del(`voice_agent_calls?${both}`);
    counts.readiness_surveys     = await del(`readiness_surveys?${both}`);
    counts.routing_results       = await del(`routing_results?contact_id=eq.${sid}`);
    counts.event_routing_members = await del(`event_routing_members?ghl_contact_id=eq.${g}`);
    counts.event_attendance      = await del(`event_attendance?contact_id=eq.${sid}`);
    counts.investor_profiles     = await del(`investor_profiles?contact_id=eq.${sid}`);
    counts.tool_access           = await del(`tool_access?contact_id=eq.${sid}`);
    counts.vendor_profiles       = await del(`vendor_profiles?contact_id=eq.${sid}`);
    counts.contacts              = await del(`contacts?id=eq.${sid}`);
    return counts;
  };

  try {
    const sbResp = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?select=id,ghl_contact_id,full_name,phone&ghl_contact_id=not.is.null&order=id.asc&limit=${limit}&offset=${offset}`,
      { headers: sbHeaders }
    );
    const contacts = await sbResp.json();
    if (!Array.isArray(contacts)) {
      return res.status(200).json({ ok: false, error: 'Unexpected Supabase response', detail: contacts });
    }

    const orphans = [];
    const errors = [];
    let exists = 0, purgedCount = 0;
    const purgeTotals = {};

    for (const c of contacts) {
      const gid = c.ghl_contact_id;
      if (!gid) continue;
      try {
        const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(gid)}`, { headers: ghlHeaders });
        if (r.status === 200) {
          exists++;
        } else {
          const body = await r.text().catch(() => '');
          if (NOT_FOUND_RE.test(body)) {
            const rec = { supabase_id: c.id, ghl_contact_id: gid, name: c.full_name || '', phone: c.phone || '' };
            if (doPurge) {
              // Deleted-in-GHL confirmed live, this iteration. Safe to purge now.
              const counts = await purgeOne(c.id, gid);
              rec.purged = counts;
              purgedCount++;
              for (const k of Object.keys(counts)) purgeTotals[k] = (purgeTotals[k] || 0) + counts[k];
            }
            orphans.push(rec);
          } else {
            errors.push({ ghl_contact_id: gid, status: r.status, body: body.slice(0, 120) });
          }
        }
      } catch (e) {
        errors.push({ ghl_contact_id: gid, error: e.message });
      }
      await sleep(120); // gentle throttle for the GHL rate limit
    }

    const nextOffset = contacts.length >= limit ? offset + limit : null;
    console.log('reconcile-contacts —', doPurge ? 'PURGE' : 'detect',
      '| offset:', offset, '| checked:', contacts.length, '| exists:', exists,
      '| orphans:', orphans.length, '| purged:', purgedCount, '| errors:', errors.length,
      nextOffset !== null ? '| next_offset ' + nextOffset : '| done');
    if (purgeRefusedReason) console.warn('reconcile-contacts — purge refused:', purgeRefusedReason);
    if (orphans.length && !doPurge) {
      console.log('reconcile-contacts — orphans (GHL not-found):',
        JSON.stringify(orphans.map(o => ({ id: o.supabase_id, ghl: o.ghl_contact_id, name: o.name }))));
    }

    return res.status(200).json({
      ok: true,
      mode: doPurge ? 'PURGE (records deleted)' : 'detect-only (deletes nothing)',
      purge_refused: purgeRefusedReason || undefined,
      offset,
      checked: contacts.length,
      exists,
      orphan_count: orphans.length,
      purged_count: doPurge ? purgedCount : undefined,
      purge_totals: doPurge ? purgeTotals : undefined,
      error_count: errors.length,
      next_offset: nextOffset,
      orphans,
      errors: errors.slice(0, 25),
      note: doPurge
        ? 'Orphans and their downstream rows were deleted. Walk next_offset until null.'
        : 'Detect-only. To purge, set PURGE_CONFIRM_TOKEN in the server env and call with &purge=true&confirm=<token>. Walk next_offset until null.'
    });
  } catch (e) {
    console.error('reconcile-contacts error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
