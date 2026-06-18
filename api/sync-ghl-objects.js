/**
 * /api/sync-ghl-objects.js
 *
 * Vercel serverless function triggered by Vercel Cron (see vercel.json).
 * Pulls all 4 GHL custom objects and upserts them into Supabase.
 *
 * Required environment variables (set in Vercel project settings):
 *   CRON_SECRET          - shared secret; Vercel sends this in Authorization header
 *   GHL_API_KEY          - GHL private integration API key
 *   GHL_LOCATION_ID      - DNirEjy0ejVwbHsaBYrn
 *   SUPABASE_URL         - https://kttzxjddtkgsitzehiid.supabase.co
 *   SUPABASE_SERVICE_KEY - Supabase service_role key (secret)
 */

import { createClient } from '@supabase/supabase-js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Helper: paginated GHL custom object fetch
// ---------------------------------------------------------------------------
async function fetchAllGhlRecords(objectKey, apiKey, locationId) {
  const records = [];
  let searchAfter = null;

  while (true) {
    const body = {
      locationId,
      page: 1,
      pageSize: PAGE_SIZE,
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const res = await fetch(`${GHL_BASE}/objects/${objectKey}/records/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL fetch failed for ${objectKey}: ${res.status} ${text}`);
    }

    const data = await res.json();
    const batch = data.records || [];
    records.push(...batch);

    if (batch.length < PAGE_SIZE) break;
    // Use the last record's searchAfter cursor for next page
    const last = batch[batch.length - 1];
    searchAfter = last.searchAfter || null;
    if (!searchAfter) break;
  }

  return records;
}

// ---------------------------------------------------------------------------
// Transform: vendor_resources -> ghl_vendor_resources row
// ---------------------------------------------------------------------------
function transformVendor(record) {
  const p = record.properties || {};
  return {
    ghl_record_id: record.id,
    company_name: p.company_name || '',
    company_phone: p.company_phone || null,
    company_email: p.company_email || null,
    business_description: p.business_description || null,
    company_tagline: p.company_tagline || null,
    company_website: p.company_website || null,
    company_address: p.company_address || null,
    company_city: p.company_city || null,
    company_state: p.company_state || null,
    company_postal_code: p.company_postal_code || null,
    company_logo: p.company_logo || null,
    contractor_speciality: p.contractor_speciality || null,
    other_vendor_services: p.other_vendor_services || null,
    deals_opportunities: p.deals_opportunities || null,
    funding_financial: p.funding__financial || null,
    team_vendors: p.team__vendors || null,
    attorney_subclass: p.attorney_subclass || null,
    operations: p.operations || null,
    development_land: p.development__land || null,
    education_tech_tools: p.education__technology__tools || null,
    other_contractor: p.other_contractor || null,
    social_facebook: p.social_facebook || null,
    social_instagram: p.social_instagram || null,
    social_youtube: p.social_youtube || null,
    social_linkedin: p.social_linkedin || null,
    promotion_graphics: p.promotion_graphics || null,
    member_promotions: p.member_promotions || null,
    enroll_vendor_match: p.enroll_vendor_match === 'true' || p.enroll_vendor_match === true,
    investor_types: p.investor_types || null,
    affiliate_partner: p.affiliate_partner === 'true' || p.affiliate_partner === true,
    service_areas: p.service_areas || null,
    service_zip_codes: p.service_zip_codes || null,
    service_radius_miles: p.service_radius_miles ? parseInt(p.service_radius_miles) : null,
    serves_statewide: p.serves_statewide === 'true' || p.serves_statewide === true,
    serves_national: p.serves_national === 'true' || p.serves_national === true,
    primary_zip_code: p.primary_zip_code || null,
    service_counties: p.service_counties || null,
    latitude: p.latitude ? parseFloat(p.latitude) : null,
    longitude: p.longitude ? parseFloat(p.longitude) : null,
    is_active: true,
    ghl_created_at: record.createdAt || null,
    ghl_updated_at: record.updatedAt || null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Transform: educators_mentors -> ghl_educators_mentors row
// ---------------------------------------------------------------------------
function transformEducator(record) {
  const p = record.properties || {};
  return {
    ghl_record_id: record.id,
    educators_name: p.educators_name || '',
    educational_topics: p.educational_topics || null,
    educational_level: p.educational_level || null,
    educators_url: p.educators_url || null,
    commercial_asset_types: p.commercial_asset_types || null,
    is_active: true,
    ghl_created_at: record.createdAt || null,
    ghl_updated_at: record.updatedAt || null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Transform: educational_courses -> ghl_educational_courses row
// ---------------------------------------------------------------------------
function transformCourse(record) {
  const p = record.properties || {};
  const membershipRaw = p.membership_required;
  const membershipBool =
    membershipRaw === true ||
    membershipRaw === 'true' ||
    (Array.isArray(membershipRaw) && membershipRaw.includes('true'));

  return {
    ghl_record_id: record.id,
    course_name: p.educational_courses || '',
    educational_topics: p.what_type_of_investing_are_you_most_interested_in || null,
    commercial_asset_types: p.commercial_asset_types || null,
    educational_level: p.educational_level || null,
    video_url: p.video_url || null,
    education_url: p.education_url || null,
    paid_education: p.paid_education === true || p.paid_education === 'true',
    membership_required: membershipBool,
    is_active: true,
    ghl_created_at: record.createdAt || null,
    ghl_updated_at: record.updatedAt || null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Transform: tools_resources -> ghl_tools_resources row
// ---------------------------------------------------------------------------
function transformTool(record) {
  const p = record.properties || {};
  const membershipRaw = p.membership_required;
  const membershipBool =
    membershipRaw === true ||
    membershipRaw === 'true' ||
    (Array.isArray(membershipRaw) && membershipRaw.includes('true'));

  const paidRaw = p.paid_resource;
  const paidBool =
    paidRaw === true ||
    paidRaw === 'true' ||
    (Array.isArray(paidRaw) && paidRaw.includes('true'));

  return {
    ghl_record_id: record.id,
    resource_title: p.resource_title || '',
    educational_topics: p.educational_topics || null,
    educational_level: p.educational_level || null,
    resource_url: p.resource_url || null,
    resource_url_nonmember: p.resource_url_nonmember || null,
    membership_required: membershipBool,
    paid_resource: paidBool,
    is_active: true,
    ghl_created_at: record.createdAt || null,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Upsert helper
// ---------------------------------------------------------------------------
async function upsertRecords(supabase, tableName, rows, conflictColumn = 'ghl_record_id') {
  if (!rows.length) return { count: 0 };
  const { error, count } = await supabase
    .from(tableName)
    .upsert(rows, { onConflict: conflictColumn, ignoreDuplicates: false });
  if (error) throw new Error(`Upsert to ${tableName} failed: ${error.message}`);
  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // Verify cron secret
  const authHeader = req.headers['authorization'] || '';
  const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;
  if (authHeader !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID || 'DNirEjy0ejVwbHsaBYrn';
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!apiKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing required environment variables' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const results = {};
  const errors = [];
  const started = Date.now();

  // --- Vendor Resources ---
  try {
    const raw = await fetchAllGhlRecords('custom_objects.vendor_resources', apiKey, locationId);
    const rows = raw.map(transformVendor);
    const { count } = await upsertRecords(supabase, 'ghl_vendor_resources', rows);
    results.ghl_vendor_resources = { fetched: raw.length, upserted: count };
  } catch (err) {
    errors.push(`ghl_vendor_resources: ${err.message}`);
    results.ghl_vendor_resources = { error: err.message };
  }

  // --- Educators & Mentors ---
  try {
    const raw = await fetchAllGhlRecords('custom_objects.educators_mentors', apiKey, locationId);
    const rows = raw.map(transformEducator);
    const { count } = await upsertRecords(supabase, 'ghl_educators_mentors', rows);
    results.ghl_educators_mentors = { fetched: raw.length, upserted: count };
  } catch (err) {
    errors.push(`ghl_educators_mentors: ${err.message}`);
    results.ghl_educators_mentors = { error: err.message };
  }

  // --- Educational Courses ---
  try {
    const raw = await fetchAllGhlRecords('custom_objects.educational_courses', apiKey, locationId);
    const rows = raw.map(transformCourse);
    const { count } = await upsertRecords(supabase, 'ghl_educational_courses', rows);
    results.ghl_educational_courses = { fetched: raw.length, upserted: count };
  } catch (err) {
    errors.push(`ghl_educational_courses: ${err.message}`);
    results.ghl_educational_courses = { error: err.message };
  }

  // --- Tools & Resources ---
  try {
    const raw = await fetchAllGhlRecords('custom_objects.tools_resources', apiKey, locationId);
    const rows = raw.map(transformTool);
    const { count } = await upsertRecords(supabase, 'ghl_tools_resources', rows);
    results.ghl_tools_resources = { fetched: raw.length, upserted: count };
  } catch (err) {
    errors.push(`ghl_tools_resources: ${err.message}`);
    results.ghl_tools_resources = { error: err.message };
  }

  const duration = Date.now() - started;
  const status = errors.length === 0 ? 200 : 207;

  return res.status(status).json({
    success: errors.length === 0,
    duration_ms: duration,
    results,
    errors: errors.length ? errors : undefined,
  });
}