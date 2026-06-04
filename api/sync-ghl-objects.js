/**
 * sync-ghl-objects.js — GHL Custom Objects to Supabase Sync
 *
 * Fetches records from three GHL custom objects and upserts them
 * into matching Supabase tables so the voice agent can query them.
 *
 * GHL Custom Objects synced:
 *   - educators_mentors    → ghl_educators_mentors
 *   - educational_courses  → ghl_educational_courses
 *   - vendor_resources     → ghl_vendor_resources
 *
 * Called by: GET or POST /api/sync-ghl-objects
 * Trigger:   Manual, scheduled cron, or after GHL record updates
 *
 * Environment variables required:
 *   GHL_API_KEY        — GHL Private Integration Token
 *   SUPABASE_URL       — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
 */

export const config = { api: { bodyParser: true } };

const GHL_LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';

// Helper: fetch all records from a GHL custom object
// GHL paginates at 20 records per page — this fetches all pages
async function fetchGHLObjectRecords(objectKey, ghlToken) {
  const allRecords = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const resp = await fetch(
      `https://services.leadconnectorhq.com/custom-objects/schemas/${objectKey}/records?locationId=${GHL_LOCATION_ID}&page=${page}&pageSize=50`,
      {
        headers: {
          'Authorization': `Bearer ${ghlToken}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );

    if (!resp.ok) {
      console.error(`GHL ${objectKey} fetch error: ${resp.status} ${resp.statusText}`);
      break;
    }

    const data = await resp.json();

    // GHL returns records in data.records or data.customObjects depending on version
    const records = data.records || data.customObjects || data.data || [];
    allRecords.push(...records);

    // Check if there are more pages
    const total = data.total || data.totalCount || 0;
    hasMore = allRecords.length < total && records.length > 0;
    page++;

    // Safety limit to prevent infinite loops
    if (page > 20) break;
  }

  console.log(`GHL ${objectKey}: fetched ${allRecords.length} records`);
  return allRecords;
}

// Helper: extract field value from GHL custom object record
// GHL stores custom field values in record.properties or record.fieldValues
function getField(record, fieldKey) {
  const props = record.properties || record.fieldValues || {};
  return props[fieldKey] ?? null;
}

// Helper: upsert records into Supabase
async function upsertToSupabase(supabaseUrl, supabaseKey, table, records) {
  if (records.length === 0) return { upserted: 0 };

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/${table}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(records)
    }
  );

  if (!resp.ok) {
    const error = await resp.text();
    console.error(`Supabase upsert error for ${table}: ${resp.status} ${error.substring(0, 200)}`);
    return { upserted: 0, error };
  }

  return { upserted: records.length };
}

export default async function handler(req, res) {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!GHL_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({
      ok: false,
      error: 'Missing environment variables: GHL_API_KEY, SUPABASE_URL, or SUPABASE_SERVICE_KEY'
    });
  }

  const results = {};

  // ============================================================
  // SYNC 1: educators_mentors → ghl_educators_mentors
  // Fields: Educators Name, Educational Topics, Educational Level,
  //         Educators URL, Commercial Asset types
  // ============================================================
  try {
    const educatorRecords = await fetchGHLObjectRecords('educators_mentors', GHL_API_KEY);

    const educatorRows = educatorRecords.map(record => ({
      ghl_record_id:         record.id || record.recordId || '',
      educators_name:        getField(record, 'educators_name') || getField(record, 'name') || '',
      educational_topics:    getField(record, 'educational_topics') || [],
      educational_level:     getField(record, 'educational_level') || [],
      educators_url:         getField(record, 'educators_url') || getField(record, 'educatorsUrl') || '',
      commercial_asset_types: getField(record, 'commercial_asset_types') || [],
      is_active:             true,
      ghl_created_at:        record.createdAt || record.dateAdded || null,
      ghl_updated_at:        record.updatedAt || record.dateUpdated || null,
      synced_at:             new Date().toISOString()
    })).filter(r => r.ghl_record_id && r.educators_name);

    results.educators = await upsertToSupabase(SUPABASE_URL, SUPABASE_KEY, 'ghl_educators_mentors', educatorRows);
    console.log('Educators synced:', results.educators);
  } catch(e) {
    console.error('Educator sync error:', e.message);
    results.educators = { error: e.message };
  }

  // ============================================================
  // SYNC 2: educational_courses → ghl_educational_courses
  // Fields: Educational Courses, Educational Topics, Commercial Asset types,
  //         Educational Level, Video URL, Education URL, Paid Education, Membership Required
  // ============================================================
  try {
    const courseRecords = await fetchGHLObjectRecords('educational_courses', GHL_API_KEY);

    const courseRows = courseRecords.map(record => ({
      ghl_record_id:         record.id || record.recordId || '',
      course_name:           getField(record, 'educational_courses') || getField(record, 'name') || '',
      educational_topics:    getField(record, 'educational_topics') || [],
      commercial_asset_types: getField(record, 'commercial_asset_types') || [],
      educational_level:     getField(record, 'educational_level') || [],
      video_url:             getField(record, 'video_url') || getField(record, 'videoUrl') || '',
      education_url:         getField(record, 'education_url') || getField(record, 'educationUrl') || '',
      paid_education:        getField(record, 'paid_education') === true || getField(record, 'paid_education') === 'True',
      membership_required:   getField(record, 'membership_required') === true || getField(record, 'membership_required') === 'true',
      is_active:             true,
      ghl_created_at:        record.createdAt || record.dateAdded || null,
      ghl_updated_at:        record.updatedAt || record.dateUpdated || null,
      synced_at:             new Date().toISOString()
    })).filter(r => r.ghl_record_id && r.course_name);

    results.courses = await upsertToSupabase(SUPABASE_URL, SUPABASE_KEY, 'ghl_educational_courses', courseRows);
    console.log('Courses synced:', results.courses);
  } catch(e) {
    console.error('Course sync error:', e.message);
    results.courses = { error: e.message };
  }

  // ============================================================
  // SYNC 3: vendor_resources → ghl_vendor_resources
  // All partner category fields are stored as arrays
  // ============================================================
  try {
    const vendorRecords = await fetchGHLObjectRecords('vendor_resources', GHL_API_KEY);

    const vendorRows = vendorRecords.map(record => ({
      ghl_record_id:         record.id || record.recordId || '',
      company_name:          getField(record, 'company_name') || getField(record, 'name') || '',
      company_phone:         getField(record, 'company_phone') || getField(record, 'companyPhone') || '',
      company_email:         getField(record, 'company_email') || getField(record, 'companyEmail') || '',
      business_description:  getField(record, 'business_description') || '',
      company_tagline:       getField(record, 'company_tagline') || '',
      company_website:       getField(record, 'company_website') || '',
      company_address:       getField(record, 'company_address') || '',
      company_city:          getField(record, 'company_city') || '',
      company_state:         getField(record, 'company_state') || '',
      company_postal_code:   getField(record, 'company_postal_code') || '',
      company_logo:          getField(record, 'company_logo') || '',
      contractor_speciality: getField(record, 'contractor_speciality') || getField(record, 'contractor_specialty') || '',
      other_vendor_services: getField(record, 'other_vendor_services') || '',
      deals_opportunities:   getField(record, 'deals_opportunities') || [],
      funding_financial:     getField(record, 'funding_financial') || [],
      team_vendors:          getField(record, 'team_vendors') || [],
      attorney_subclass:     getField(record, 'attorney_subclass') || [],
      operations:            getField(record, 'operations') || [],
      development_land:      getField(record, 'development_land') || [],
      education_tech_tools:  getField(record, 'education_tech_tools') || [],
      other_contractor:      getField(record, 'other_contractor') || [],
      social_facebook:       getField(record, 'social_profile_links_facebook') || '',
      social_instagram:      getField(record, 'social_profile_links_instagram') || '',
      social_youtube:        getField(record, 'social_profile_links_youtube') || '',
      social_linkedin:       getField(record, 'social_profile_links_linkedin') || '',
      promotion_graphics:    getField(record, 'promotion_graphics') || '',
      member_promotions:     getField(record, 'member_promotions') || '',
      enroll_vendor_match:   getField(record, 'enroll_vendor_match') === true,
      investor_types:        getField(record, 'which_types_of_investors_do_you_typically_work_with') || [],
      affiliate_partner:     getField(record, 'affiliate_partner') === true,
      is_active:             true,
      ghl_created_at:        record.createdAt || record.dateAdded || null,
      ghl_updated_at:        record.updatedAt || record.dateUpdated || null,
      synced_at:             new Date().toISOString()
    })).filter(r => r.ghl_record_id && r.company_name);

    results.vendors = await upsertToSupabase(SUPABASE_URL, SUPABASE_KEY, 'ghl_vendor_resources', vendorRows);
    console.log('Vendors synced:', results.vendors);
  } catch(e) {
    console.error('Vendor sync error:', e.message);
    results.vendors = { error: e.message };
  }

  // Return summary
  const totalSynced = (results.educators?.upserted || 0) +
                      (results.courses?.upserted || 0) +
                      (results.vendors?.upserted || 0);

  return res.status(200).json({
    ok: true,
    synced_at: new Date().toISOString(),
    total_synced: totalSynced,
    results
  });
}
