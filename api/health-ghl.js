/**
 * health-ghl.js — GHL platform-drift canary.
 *
 * WHY THIS EXISTS: GoHighLevel changes things behind the scenes. Two classes of change
 * have already broken Utah REIA automations:
 *   1. TOKEN/ENDPOINT: the GHL Private Integration token was sunset (2026-08-14), killing
 *      the nightly sync; a separate endpoint change broke the Claude tool's contact lookups.
 *   2. FIELD-KEY DRIFT: a custom field renamed/removed in GHL silently changes its fieldKey,
 *      so webhook bodies and routing stop matching and queries return nothing (no error).
 * This canary actively probes GHL so those breaks are caught in a day, not weeks. It is the
 * automated half of the "catch GHL platform changes" process (see GHL_CHANGE_PROCESS.md).
 *
 * WHAT IT CANNOT CHECK: GHL custom OBJECTS (Vendor Partners, Educators, Tools) 403 from
 * external IPs, so this endpoint cannot verify their fields. Those are covered by the manual
 * MCP checks in the runbook. This checks what IS reachable from a server IP: the token, the
 * contacts endpoint shape, and the contact custom-field keys our automations depend on.
 *
 * HOW IT RUNS: a GitHub Action (.github/workflows/health-ghl.yml) curls this daily; a failed
 * run emails the repo admins (optional Slack via SLACK_WEBHOOK_URL).
 *
 * AUTH: optional. If HEALTHCHECK_TOKEN is set, a matching Bearer token is required.
 *
 * Responses (always HTTP 200; the workflow reads the JSON):
 *   { ok:true,  checks:{...} }
 *   { ok:false, error:'ghl_auth_failed'|'ghl_shape_changed'|'ghl_fields_missing'|'not_configured', ... }
 */

export const config = { maxDuration: 15 };

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 'DNirEjy0ejVwbHsaBYrn';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || '';
const TIMEOUT_MS = 10000;

// Contact custom-field keys our automations depend on (webhook body -> ghl-webhook edge
// function, intake/vendor routing, and the voice-agent write-back). If GHL renames or
// removes one, its fieldKey changes and the dependent automation silently stops matching.
// Keys are the GHL fieldKey minus the "contact." prefix. Keep this list to the fields whose
// break would actually hurt; add to it as new automations take a dependency.
const CRITICAL_FIELD_KEYS = [
  // investor questionnaire (drives routing + investor_profiles sync)
  'where_would_you_say_you_are_in_your_real_estate_investing_journey',
  'what_type_of_investing_are_you_most_interested_in',
  'what_are_you_trying_to_accomplish_in_the_next_6_to_12_months',
  'tell_us_what_best_describes_you_right_now',
  'select_the_commercial_asset_types_that_most_interest_you',
  // need buckets
  'funding__financial', 'deals__opportunities', 'team__vendors', 'growth__network', 'education__tools',
  // vendor enrollment
  'what_is_your_area_of_expertise', 'contractor_speciality_member',
  'which_types_of_investors_do_you_typically_work_with',
  // commitments + identity
  'soft_commit_amount', 'initial_commitment_amount', 'entity_type', 'membership_type',
  // voice-agent write-back (ghl-sync.js pushes these back after a call)
  'voice_agent_stage', 'voice_agent_strategy', 'voice_agent_goals', 'voice_agent_blocker'
];

function ghlFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(`${GHL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: GHL_VERSION, Accept: 'application/json' },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
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
  if (!GHL_API_KEY) {
    return res.status(200).json({ ok: false, error: 'not_configured', detail: 'GHL_API_KEY unset' });
  }

  const checks = {};

  // --- Probe 1: token + contacts endpoint shape (catches token sunset + endpoint drift) ---
  try {
    const r = await ghlFetch(`/contacts/?locationId=${GHL_LOCATION_ID}&limit=1`);
    checks.contacts_status = r.status;
    if (r.status === 401 || r.status === 403) {
      return res.status(200).json({ ok: false, error: 'ghl_auth_failed', detail: `contacts returned ${r.status} — the GHL Private Integration token is likely revoked or sunset. Rotate GHL_API_KEY in Vercel.`, checks });
    }
    if (!r.ok) {
      return res.status(200).json({ ok: false, error: 'ghl_request_failed', detail: `contacts returned ${r.status}`, checks });
    }
    const body = await r.json();
    if (!body || !Array.isArray(body.contacts)) {
      return res.status(200).json({ ok: false, error: 'ghl_shape_changed', detail: 'GET /contacts no longer returns a `contacts` array — the response shape changed. Check code that reads body.contacts (e.g. ghl-sync.js phone lookup).', checks });
    }
    checks.contacts_shape_ok = true;
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'ghl_unreachable', detail: String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)).slice(0, 160), checks });
  }

  // --- Probe 2: critical contact custom-field keys still present (catches field drift) ---
  try {
    const r = await ghlFetch(`/locations/${GHL_LOCATION_ID}/customFields`);
    checks.custom_fields_status = r.status;
    if (!r.ok) {
      return res.status(200).json({ ok: false, error: 'ghl_request_failed', detail: `customFields returned ${r.status}`, checks });
    }
    const body = await r.json();
    const defs = Array.isArray(body?.customFields) ? body.customFields : null;
    if (!defs) {
      return res.status(200).json({ ok: false, error: 'ghl_shape_changed', detail: 'GET /locations/{id}/customFields no longer returns a `customFields` array — the response shape changed.', checks });
    }
    const presentKeys = new Set(
      defs.map(f => String(f.fieldKey || f.key || '').replace(/^contact\./, ''))
    );
    checks.custom_fields_count = defs.length;
    const missing = CRITICAL_FIELD_KEYS.filter(k => !presentKeys.has(k));
    if (missing.length) {
      return res.status(200).json({
        ok: false,
        error: 'ghl_fields_missing',
        detail: `${missing.length} critical custom-field key(s) are gone from GHL — renamed or deleted. Dependent automations will silently stop matching. Fix the field in GHL or update the key in code/webhook bodies.`,
        missing_fields: missing,
        checks
      });
    }
    checks.critical_fields_ok = CRITICAL_FIELD_KEYS.length;
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'ghl_unreachable', detail: String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)).slice(0, 160), checks });
  }

  return res.status(200).json({ ok: true, location_id: GHL_LOCATION_ID, checks });
}
