/**
 * reconcile-contacts.js — GHL-deletion orphan DETECTOR (Item 16, phase 1)
 *
 * READ ONLY. This endpoint finds Supabase contact records whose GHL contact has
 * been deleted and REPORTS them. It deletes nothing. Purging the orphans is a
 * deliberate phase-2 follow-up, gated behind explicit confirmation, and needs to
 * be reconciled with the Item 15 retention policy first.
 *
 * Why reconciliation and not a delete webhook: GHL custom objects 403 from
 * external IPs, but contact-level reads are reachable from the edge (ghl-sync
 * and member-lookup already call the v2 contacts API from Vercel), so a nightly
 * reconciliation runs here without needing MCP. Confirmed 2026-07-30.
 *
 * SAFETY RULE baked in: only an explicit 404 from GHL counts as "deleted". A
 * rate-limit (429), a 5xx, or a network error is reported as an ERROR, never as
 * an orphan, so a future purge can never delete a record over a transient blip.
 *
 * There are ~5,200 contacts, so a full scan cannot finish in one serverless
 * request. This endpoint pages: it checks `limit` contacts starting at `offset`
 * and returns `next_offset`. Walk the pages until next_offset is null. A future
 * cron can advance the offset across nightly runs, or a driver can loop it.
 *
 * Usage (on demand): GET /api/reconcile-contacts?limit=50&offset=0
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY), GHL_API_KEY.
 */

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GHL_API_KEY  = process.env.GHL_API_KEY;

const GHL_BASE = 'https://services.leadconnectorhq.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // One page per request. Default 50 keeps the run well under the serverless
  // timeout at the 120ms throttle (~6s). Hard-capped so an accidental call can
  // never hammer the GHL API.
  const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 400);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

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

  try {
    // Pull one page of Supabase contacts that carry a GHL id. Stable order by id
    // so paging with offset is deterministic across requests.
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
    let exists = 0;

    for (const c of contacts) {
      const gid = c.ghl_contact_id;
      if (!gid) continue;
      try {
        const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(gid)}`, { headers: ghlHeaders });
        if (r.status === 200) {
          exists++;
        } else if (r.status === 404) {
          // The ONLY condition that means "deleted in GHL".
          orphans.push({ supabase_id: c.id, ghl_contact_id: gid, name: c.full_name || '', phone: c.phone || '' });
        } else {
          // 429 / 5xx / anything else — do NOT treat as deleted.
          errors.push({ ghl_contact_id: gid, status: r.status });
        }
      } catch (e) {
        errors.push({ ghl_contact_id: gid, error: e.message });
      }
      await sleep(120); // gentle throttle for the GHL rate limit
    }

    // A full page means there may be more; advance the offset next call.
    const nextOffset = contacts.length >= limit ? offset + limit : null;
    console.log('reconcile-contacts —', 'offset:', offset, '| checked:', contacts.length,
      '| exists:', exists, '| orphans:', orphans.length, '| errors:', errors.length,
      nextOffset !== null ? '| next_offset ' + nextOffset : '| done');
    if (orphans.length) {
      console.log('reconcile-contacts — orphaned Supabase contacts (GHL 404):',
        JSON.stringify(orphans.map(o => ({ id: o.supabase_id, ghl: o.ghl_contact_id, name: o.name }))));
    }

    return res.status(200).json({
      ok: true,
      mode: 'detect-only (deletes nothing)',
      offset,
      checked: contacts.length,
      exists,
      orphan_count: orphans.length,
      error_count: errors.length,
      next_offset: nextOffset,
      orphans,
      errors: errors.slice(0, 25),
      note: 'Phase 1 detector. Walk next_offset until null for a full scan. Purging orphans is a separate, confirmed follow-up (Item 16 phase 2), pending the Item 15 retention decision.'
    });
  } catch (e) {
    console.error('reconcile-contacts error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
