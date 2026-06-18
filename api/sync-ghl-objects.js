/**
 * sync-ghl-objects.js — GHL Custom Objects to Supabase Sync
 *
 * Fetches records from four GHL custom objects and upserts them
 * into matching Supabase tables so the voice agent can query them.
 *
 * GHL Custom Objects synced:
 *   - custom_objects.vendor_resources     → ghl_vendor_resources
 *   - custom_objects.educators_mentors    → ghl_educators_mentors
 *   - custom_objects.educational_courses  → ghl_educational_courses
 *   - custom_objects.tools_resources      → ghl_tools_resources
 *
 * Called by: GET /api/sync-ghl-objects
 * Auth:      Authorization: Bearer <CRON_SECRET>
 * Trigger:   Vercel cron (3:00 AM UTC) or GitHub Actions (3:15 AM UTC)
 *
 * No external npm packages required — uses native fetch only.
 */

export const config = { api: { bodyParser: false } };

const GHL_LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const GHL_BASE        = 'https://services.leadconnectorhq.com';
const PAGE_SIZE       = 100;

// ---------------------------------------------------------------------------
// GHL: paginated search using the POST /objects/{key}/records/search endpoint
// ---------------------------------------------------------------------------
async function fetchAllGhlRecords(objectKey, apiKey) {
  const records = [];
  let searchAfter = null;

  for (let page = 0; page < 20; page++) {
    const body = { locationId: GHL_LOCATION_ID, pageSize: PAGE_SIZE };
    if (searchAfter) body.searchAfter = searchAfter;

    const res = await fetch(`${GHL_BASE}/objects/${objectKey}/records/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL ${objectKey} error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const batch = data.records || [];
    records.push(...batch);

    if (batch.length < PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    searchAfter = last.searchAfter || null;
    if (!searchAfter) break;
  }

  console.log(`GHL ${objectKey}: fetched ${records.length} records`);
  return records;
}

// ---------------------------------------------------------------------------
// Supabase: upsert using raw fetch (no SDK needed)
// ---------------------------------------------------------------------------
async function upsertToSupabase(supabaseUrl, supabaseKey, table, rows) {
  if (!rows.length) return { upserted: 0 };

  const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table} error ${res.status}: ${text.slice(0, 200)}`);
  }

  return { upserted: rows.length };
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------
function prop(record, key) {
  return (record.properties || {})[key] ?? null;
}

function asBool(val) {
  return val === true || val === 'true' || (Array.isArray(val) && val.includes('true'));
}

function asArr(val) {
  if (Array.isArray(val)) return val;
  if (val == null || val === '') return null;
  return [val];
}

function transformVendor(r) {
  return {
    ghl_record_id:         r.id,
    company_name:          prop(r, 'company_name')          || '',
    company_phone:         prop(r, 'company_phone')         || null,
    company_email:         prop(r, 'company_email')         || null,
    business_description:  prop(r, 'business_description')  || null,
    company_tagline:       prop(r, 'company_tagline')       || null,
    company_website:       prop(r, 'company_website')       || null,
    company_address:       prop(r, 'company_address')       || null,
    company_city:          prop(r, 'company_city')          || null,
    company_state:         prop(r, 'company_state')         || null,
    company_postal_code:   prop(r, 'company_postal_code')   || null,
    company_logo:          prop(r, 'company_logo')          || null,
    contractor_speciality: prop(r, 'contractor_speciality') || null,
    other_vendor_services: prop(r, 'other_vendor_services') || null,
    deals_opportunities:   asArr(prop(r, 'deals_opportunities')),
    funding_financial:     asArr(prop(r, 'funding__financial')),
    team_vendors:          asArr(prop(r, 'team__vendors')),
    attorney_subclass:     asArr(prop(r, 'attorney_subclass')),
    operations:            asArr(prop(r, 'operations')),
    development_land:      asArr(prop(r, 'development__land')),
    education_tech_tools:  asArr(prop(r, 'education__technology__tools')),
    other_contractor:      asArr(prop(r, 'other_contractor')),
    social_facebook:       prop(r, 'social_facebook')       || null,
    social_instagram:      prop(r, 'social_instagram')      || null,
    social_youtube:        prop(r, 'social_youtube')        || null,
    social_linkedin:       prop(r, 'social_linkedin')       || null,
    promotion_graphics:    prop(r, 'promotion_graphics')    || null,
    member_promotions:     prop(r, 'member_promotions')     || null,
    enroll_vendor_match:   asBool(prop(r, 'enroll_vendor_match')),
    investor_types:        asArr(prop(r, 'investor_types')),
    affiliate_partner:     asBool(prop(r, 'affiliate_partner')),
    service_areas:         asArr(prop(r, 'service_areas')),
    service_zip_codes:     asArr(prop(r, 'service_zip_codes')),
    service_radius_miles:  prop(r, 'service_radius_miles') ? parseInt(prop(r, 'service_radius_miles')) : null,
    serves_statewide:      asBool(prop(r, 'serves_statewide')),
    serves_national:       asBool(prop(r, 'serves_national')),
    primary_zip_code:      prop(r, 'primary_zip_code')      || null,
    service_counties:      asArr(prop(r, 'service_counties')),
    latitude:              prop(r, 'latitude')  ? parseFloat(prop(r, 'latitude'))  : null,
    longitude:             prop(r, 'longitude') ? parseFloat(prop(r, 'longitude')) : null,
    is_active:             true,
    ghl_created_at:        r.createdAt || null,
    ghl_updated_at:        r.updatedAt || null,
    synced_at:             new Date().toISOString(),
  };
}

function transformEducator(r) {
  return {
    ghl_record_id:          r.id,
    educators_name:         prop(r, 'educators_name')        || '',
    educational_topics:     asArr(prop(r, 'educational_topics')),
    educational_level:      asArr(prop(r, 'educational_level')),
    educators_url:          prop(r, 'educators_url')         || null,
    commercial_asset_types: asArr(prop(r, 'commercial_asset_types')),
    is_active:              true,
    ghl_created_at:         r.createdAt || null,
    ghl_updated_at:         r.updatedAt || null,
    synced_at:              new Date().toISOString(),
  };
}

function transformCourse(r) {
  const membershipRaw = prop(r, 'membership_required');
  return {
    ghl_record_id:          r.id,
    course_name:            prop(r, 'educational_courses')   || '',
    educational_topics:     asArr(prop(r, 'what_type_of_investing_are_you_most_interested_in')),
    commercial_asset_types: asArr(prop(r, 'commercial_asset_types')),
    educational_level:      asArr(prop(r, 'educational_level')),
    video_url:              prop(r, 'video_url')             || null,
    education_url:          prop(r, 'education_url')         || null,
    paid_education:         asBool(prop(r, 'paid_education')),
    membership_required:    asBool(membershipRaw),
    is_active:              true,
    ghl_created_at:         r.createdAt || null,
    ghl_updated_at:         r.updatedAt || null,
    synced_at:              new Date().toISOString(),
  };
}

function transformTool(r) {
  return {
    ghl_record_id:        r.id,
    resource_title:       prop(r, 'resource_title')          || '',
    educational_topics:   asArr(prop(r, 'educational_topics')),
    educational_level:    asArr(prop(r, 'educational_level')),
    resource_url:         prop(r, 'resource_url')            || null,
    resource_url_nonmember: prop(r, 'resource_url_nonmember') || null,
    membership_required:  asBool(prop(r, 'membership_required')),
    paid_resource:        asBool(prop(r, 'paid_resource')),
    is_active:            true,
    ghl_created_at:       r.createdAt || null,
    synced_at:            new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // Verify cron secret
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey       = process.env.GHL_API_KEY;
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!apiKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing env vars: GHL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY' });
  }

  const results = {};
  const errors  = [];
  const started = Date.now();

  const jobs = [
    { key: 'custom_objects.vendor_resources',    table: 'ghl_vendor_resources',    transform: transformVendor   },
    { key: 'custom_objects.educators_mentors',   table: 'ghl_educators_mentors',   transform: transformEducator },
    { key: 'custom_objects.educational_courses', table: 'ghl_educational_courses', transform: transformCourse   },
    { key: 'custom_objects.tools_resources',     table: 'ghl_tools_resources',     transform: transformTool     },
  ];

  for (const job of jobs) {
    try {
      const raw  = await fetchAllGhlRecords(job.key, apiKey);
      const rows = raw.map(job.transform).filter(r => r.ghl_record_id);
      const out  = await upsertToSupabase(supabaseUrl, supabaseKey, job.table, rows);
      results[job.table] = { fetched: raw.length, upserted: out.upserted };
    } catch (err) {
      errors.push(`${job.table}: ${err.message}`);
      results[job.table] = { error: err.message };
    }
  }

  return res.status(errors.length ? 207 : 200).json({
    success:     errors.length === 0,
    duration_ms: Date.now() - started,
    synced_at:   new Date().toISOString(),
    results,
    errors:      errors.length ? errors : undefined,
  });
}