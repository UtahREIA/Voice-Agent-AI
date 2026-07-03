/**
 * sync-ghl-objects.js — GHL Custom Object Webhook Receiver
 *
 * Receives webhook payloads from GHL when Vendor & Resources,
 * Educators & Mentors, or Educational Courses records are
 * created or updated. Upserts the data into matching Supabase tables.
 *
 * GHL sends the full record payload via inbound webhook when triggered
 * by a workflow. We parse the payload and write to the correct table
 * based on the object_type field included in the webhook body.
 *
 * Endpoint: POST /api/sync-ghl-objects
 *
 * Expected payload from GHL workflow:
 * {
 *   object_type: "vendor_resources" | "educators_mentors" | "educational_courses",
 *   ghl_record_id: string,
 *   ... all field values as top-level keys
 * }
 *
 * Environment variables required:
 *   SUPABASE_URL           — Supabase project URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key
 */

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const GHL_API_KEY  = process.env.GHL_API_KEY;
  const GHL_LOC_ID   = process.env.GHL_LOCATION_ID || 'DNirEjy0ejVwbHsaBYrn';
  const CRON_SECRET  = process.env.CRON_SECRET;

  // GET — nightly event sync triggered by GitHub Actions or Vercel cron
  if (req.method === 'GET') {
    const authHeader = req.headers?.['authorization'] || '';
    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY || !GHL_API_KEY) {
      return res.status(200).json({ ok: false, error: 'Missing env vars' });
    }
    try {
      const cvResp = await fetch(
        `https://services.leadconnectorhq.com/locations/${GHL_LOC_ID}/customValues`,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Version': '2021-07-28',
            'Accept': 'application/json'
          }
        }
      );
      if (!cvResp.ok) {
        const err = await cvResp.text();
        throw new Error(`GHL custom values fetch failed: ${err.slice(0, 200)}`);
      }
      const cvData = await cvResp.json();
      const customValues = cvData.customValues || cvData.customFields || [];
      console.log(`Fetched ${customValues.length} GHL custom values`);

      // Sync events from custom values
      const eventsResult = await syncEvents(customValues, SUPABASE_URL, SUPABASE_KEY);

      // Also bulk sync all four custom object types using correct GHL objects API
      const objectResults = {};
      const objectTypes = [
        { objectKey: 'custom_objects.vendor_resources',    type: 'vendor_resources' },
        { objectKey: 'custom_objects.educators_mentors',   type: 'educators_mentors' },
        { objectKey: 'custom_objects.educational_courses', type: 'educational_courses' },
        { objectKey: 'custom_objects.tools_resources',     type: 'tools_resources' }
      ];

      for (const obj of objectTypes) {
        try {
          let allRecords = [];
          let skip = 0;
          const limit = 100;

          // Paginate through all records using correct GHL objects search endpoint
          while (skip < 1000) {
            const searchResp = await fetch(
              `https://services.leadconnectorhq.com/objects/${obj.objectKey}/records/search`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${GHL_API_KEY}`,
                  'Version': '2021-07-28',
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                body: JSON.stringify({
                  locationId: GHL_LOC_ID,
                  page: Math.floor(skip / limit) + 1,
                  pageLimit: limit
                })
              }
            );

            if (!searchResp.ok) {
              const errText = await searchResp.text();
              console.log(`${obj.type} fetch failed: ${searchResp.status} — ${errText.slice(0,100)}`);
              break;
            }

            const searchData = await searchResp.json();
            const records = searchData.data || searchData.records || [];
            allRecords = allRecords.concat(records);

            if (records.length < limit) break;
            skip += limit;
          }

          console.log(`${obj.type}: fetched ${allRecords.length} records`);

          // Process each record through the same upsert logic used by the POST handler
          let upserted = 0;
          for (const record of allRecords) {
            try {
              // Build a synthetic body matching what the POST handler expects
              const syntheticBody = {
                object_type: obj.type,
                ghl_record_id: record.id || '',
                ...record.properties
              };

              // Upsert directly to Supabase using same logic as POST handler
              const props = record.properties || {};
              const recId = record.id || '';
              const now2 = new Date().toISOString();
              const sbHeaders = {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'resolution=merge-duplicates,return=minimal'
              };

              let upsertRow = null;
              let upsertTable = '';

              if (obj.type === 'vendor_resources') {
                upsertTable = 'ghl_vendor_resources';
                upsertRow = {
                  ghl_record_id: recId,
                  company_name: props.company_name || '',
                  company_phone: props.company_phone || '',
                  company_email: props.company_email || '',
                  company_website: props.company_website || '',
                  company_address: props.company_address || '',
                  company_city: props.company_city || '',
                  company_state: props.company_state || '',
                  company_postal_code: props.company_postal_code || '',
                  business_description: props.business_description || '',
                  company_tagline: props.company_tagline || '',
                  company_logo: props.company_logo || '',
                  contractor_speciality: props.contractor_speciality || '',
                  deals_opportunities: parseArray(props.deals_opportunities),
                  funding_financial: parseArray(props.funding_financial),
                  team_vendors: parseArray(props.team_vendors),
                  attorney_subclass: parseArray(props.attorney_subclass),
                  operations: parseArray(props.operations),
                  development_land: parseArray(props.development_land),
                  education_tech_tools: parseArray(props.education_tech_tools),
                  social_facebook: props.social_profile_links_facebook || props.social_facebook || '',
                  social_instagram: props.social_profile_links_instagram || props.social_instagram || '',
                  social_youtube: props.social_profile_links_youtube || props.social_youtube || '',
                  social_linkedin: props.social_profile_links_linkedin || props.social_linkedin || '',
                  enroll_vendor_match: parseBool(props.enroll_vendor_match),
                  affiliate_partner: parseBool(props.affiliate_partner),
                  investor_types: parseArray(props.investor_types || props.which_types_of_investors),
                  is_active: true,
                  synced_at: now2
                };
              } else if (obj.type === 'educators_mentors') {
                upsertTable = 'ghl_educators_mentors';
                upsertRow = {
                  ghl_record_id: recId,
                  educators_name: props.educators_name || props.name || '',
                  educational_topics: parseArray(props.educational_topics),
                  educational_level: parseArray(props.educational_level),
                  educators_url: props.educators_url || '',
                  is_active: true,
                  synced_at: now2
                };
              } else if (obj.type === 'educational_courses') {
                upsertTable = 'ghl_educational_courses';
                upsertRow = {
                  ghl_record_id: recId,
                  // GHL stores course name in the 'educational_courses' field key
                  course_name: props.educational_courses || props.course_name || props.name || '',
                  // GHL stores topics in 'what_type_of_investing_are_you_most_interested_in'
                  educational_topics: parseArray(props.what_type_of_investing_are_you_most_interested_in || props.educational_topics),
                  educational_level: parseArray(props.educational_level),
                  video_url: props.video_url || '',
                  education_url: props.education_url || '',
                  // GHL stores these as arrays e.g. ["true"] -- parseBool handles both
                  paid_education: parseBool(Array.isArray(props.paid_education) ? props.paid_education[0] : props.paid_education),
                  membership_required: parseBool(Array.isArray(props.membership_required) ? props.membership_required[0] : props.membership_required),
                  is_active: true,
                  synced_at: now2
                };
              } else if (obj.type === 'tools_resources') {
                upsertTable = 'ghl_tools_resources';
                upsertRow = {
                  ghl_record_id: recId,
                  resource_title: props.resource_title || props.name || '',
                  educational_topics: parseArray(props.educational_topics),
                  educational_level: parseArray(props.educational_level),
                  resource_url: props.resource_url || '',
                  resource_url_nonmember: props.resource_url_nonmember || '',
                  membership_required: parseBool(props.membership_required),
                  paid_resource: parseBool(props.paid_resource),
                  is_active: true,
                  synced_at: now2
                };
              }

              if (upsertRow && upsertTable) {
                const upsertResp = await fetch(
                  `${SUPABASE_URL}/rest/v1/${upsertTable}?on_conflict=ghl_record_id`,
                  { method: 'POST', headers: sbHeaders, body: JSON.stringify(upsertRow) }
                );
                if (upsertResp.ok || upsertResp.status === 201) upserted++;
                else console.log(`${obj.type} upsert status: ${upsertResp.status}`);
              }
            } catch(e) {
              console.error(`${obj.type} record upsert error:`, e.message);
            }
          }

          objectResults[obj.type] = { fetched: allRecords.length, upserted };
        } catch(e) {
          console.error(`${obj.type} sync error:`, e.message);
          objectResults[obj.type] = { error: e.message };
        }
      }

      return res.status(200).json({
        ok: true,
        synced_at: new Date().toISOString(),
        events: eventsResult,
        objects: objectResults
      });
    } catch (e) {
      console.error('Event sync GET error:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // POST — GHL webhook receiver for individual object records
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'Supabase env vars missing' });
  }

  const body = req.body || {};

  // GHL workflow sends object_type to tell us which table to write to
  // This is a custom field we add to every GHL webhook action
  const objectType = body.object_type || '';
  const recordId = body.ghl_record_id || body.id || '';

  console.log('sync-ghl-objects received:', objectType, '| record:', recordId);

  if (!objectType || !recordId) {
    return res.status(200).json({
      ok: false,
      error: 'Missing object_type or ghl_record_id in payload',
      received_keys: Object.keys(body).join(', ')
    });
  }

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'resolution=merge-duplicates,return=minimal'
  };

  const now = new Date().toISOString();

  try {

    // ============================================================
    // EDUCATORS & MENTORS
    // ============================================================
    if (objectType === 'educators_mentors') {
      const row = {
        ghl_record_id:          recordId,
        educators_name:         body.educators_name || body.name || '',
        educational_topics:     parseArray(body.educational_topics),
        educational_level:      parseArray(body.educational_level),
        educators_url:          body.educators_url || body.educatorsUrl || '',
        commercial_asset_types: parseArray(body.commercial_asset_types),
        is_active:              true,
        ghl_created_at:         body.created_at || null,
        ghl_updated_at:         body.updated_at || null,
        synced_at:              now
      };

      if (!row.educators_name) {
        return res.status(200).json({ ok: false, error: 'educators_name is required' });
      }

      const resp = await fetch(`${SUPABASE_URL}/rest/v1/ghl_educators_mentors`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify(row)
      });

      const status = resp.status;
      console.log('Educator upsert status:', status, '| name:', row.educators_name);
      return res.status(200).json({ ok: true, table: 'ghl_educators_mentors', name: row.educators_name, status });
    }

    // ============================================================
    // EDUCATIONAL COURSES
    // ============================================================
    if (objectType === 'educational_courses') {
      const row = {
        ghl_record_id:          recordId,
        course_name:            body.educational_courses || body.course_name || body.name || '',
        educational_topics:     parseArray(body.what_type_of_investing_are_you_most_interested_in || body.educational_topics),
        commercial_asset_types: parseArray(body.commercial_asset_types),
        educational_level:      parseArray(body.educational_level),
        video_url:              body.video_url || body.videoUrl || '',
        education_url:          body.education_url || body.educationUrl || '',
        paid_education:         parseBool(Array.isArray(body.paid_education) ? body.paid_education[0] : body.paid_education),
        membership_required:    parseBool(Array.isArray(body.membership_required) ? body.membership_required[0] : body.membership_required),
        is_active:              true,
        ghl_created_at:         body.created_at || null,
        ghl_updated_at:         body.updated_at || null,
        synced_at:              now
      };

      if (!row.course_name) {
        return res.status(200).json({ ok: false, error: 'course_name is required' });
      }

      const resp = await fetch(`${SUPABASE_URL}/rest/v1/ghl_educational_courses`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify(row)
      });

      const status = resp.status;
      console.log('Course upsert status:', status, '| name:', row.course_name);
      return res.status(200).json({ ok: true, table: 'ghl_educational_courses', name: row.course_name, status });
    }

    // ============================================================
    // VENDOR RESOURCES
    // ============================================================
    if (objectType === 'vendor_resources') {
      const row = {
        ghl_record_id:          recordId,
        company_name:           body.company_name || body.name || '',
        company_phone:          body.company_phone || '',
        company_email:          body.company_email || '',
        business_description:   body.business_description || '',
        company_tagline:        body.company_tagline || '',
        company_website:        body.company_website || '',
        company_address:        body.company_address || '',
        company_city:           body.company_city || '',
        company_state:          body.company_state || '',
        company_postal_code:    body.company_postal_code || '',
        company_logo:           body.company_logo || '',
        contractor_speciality:  body.contractor_speciality || '',
        other_vendor_services:  body.other_vendor_services || '',
        deals_opportunities:    parseArray(body.deals_opportunities),
        funding_financial:      parseArray(body.funding_financial),
        team_vendors:           parseArray(body.team_vendors),
        attorney_subclass:      parseArray(body.attorney_subclass),
        operations:             parseArray(body.operations),
        development_land:       parseArray(body.development_land),
        education_tech_tools:   parseArray(body.education_tech_tools),
        other_contractor:       parseArray(body.other_contractor),
        social_facebook:        body.social_facebook || body.social_profile_links_facebook || '',
        social_instagram:       body.social_instagram || body.social_profile_links_instagram || '',
        social_youtube:         body.social_youtube || body.social_profile_links_youtube || '',
        social_linkedin:        body.social_linkedin || body.social_profile_links_linkedin || '',
        promotion_graphics:     body.promotion_graphics || '',
        member_promotions:      body.member_promotions || '',
        enroll_vendor_match:    parseBool(body.enroll_vendor_match),
        investor_types:         parseArray(body.investor_types || body.which_types_of_investors),
        affiliate_partner:      parseBool(body.affiliate_partner),
        is_active:              true,
        ghl_created_at:         body.created_at || null,
        ghl_updated_at:         body.updated_at || null,
        synced_at:              now
      };

      if (!row.company_name) {
        return res.status(200).json({ ok: false, error: 'company_name is required' });
      }

      const resp = await fetch(`${SUPABASE_URL}/rest/v1/ghl_vendor_resources`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify(row)
      });

      const status = resp.status;
      console.log('Vendor upsert status:', status, '| name:', row.company_name);
      return res.status(200).json({ ok: true, table: 'ghl_vendor_resources', name: row.company_name, status });
    }

    // Unknown object type
    return res.status(200).json({
      ok: false,
      error: `Unknown object_type: ${objectType}. Expected: vendor_resources, educators_mentors, or educational_courses`
    });

  } catch(e) {
    console.error('sync-ghl-objects error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// Helper: parse array values from GHL webhook
// GHL may send arrays as comma-separated strings or actual arrays
function parseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// Helper: parse boolean values from GHL webhook
// GHL may send booleans as true/false, "true"/"false", or "True"/"False"
function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
}

// ============================================================
// EVENT SYNC — pulls GHL custom value event slots (1-9)
// Auto-detects strategies from event title + subtitle
// ============================================================

const STRATEGY_KEYWORDS = {
  fix_and_flip:       ['fix and flip', 'fix & flip', 'flip', 'rehab', 'renovation', 'arv', 'after repair'],
  wholesale:          ['wholesale', 'wholesal', 'motivated seller', 'direct mail', 'deal finding', 'off-market', 'assignment'],
  buy_and_hold:       ['buy and hold', 'rental', 'landlord', 'tenant', 'cash flow', 'passive income', 'buy & hold'],
  brrrr:              ['brrrr', 'refinance', 'refi', 'cash out'],
  short_term_rental:  ['short term', 'str', 'airbnb', 'vrbo', 'vacation rental', 'short-term'],
  creative_financing: ['creative financing', 'seller finance', 'subject to', 'sub-to', 'wrap', 'owner finance', 'private money', 'note', 'creative'],
  development:        ['development', 'ground up', 'new construction', 'entitlement', 'townhome', 'subdivision', 'build'],
  multi_family:       ['multi', 'multifamily', 'multi-family', 'apartment', 'duplex', 'triplex', 'fourplex', 'syndication'],
  commercial:         ['commercial', 'industrial', 'office', 'retail', 'self storage', 'storage', 'hotel', 'hospitality'],
  raising_capital:    ['private money', 'raising capital', 'raise capital', 'investor', 'fund', 'equity', 'capital'],
  notes_lending:      ['note', 'lending', 'hard money', 'lender', 'loan'],
  house_hacking:      ['house hack', 'house hacking'],
  land:               ['land', 'lot', 'raw land', 'farm'],
  out_of_state:       ['out of state', 'remote', 'nationwide', 'national'],
  tax_deeds_liens:    ['tax deed', 'tax lien', 'tax sale'],
};

const EVENT_TYPE_KEYWORDS = {
  main:       ['main meeting', 'main monthly', 'monthly meeting'],
  mid_day:    ['mid-day', 'midday', 'mid day', 'lunch'],
  wreia:      ['wreia', "women's real estate", 'women'],
  virtual:    ['virtual', 'online', 'zoom', 'webinar'],
  latino:     ['latino', 'latina', 'hispanic', 'español', 'spanish'],
  true_wealth:['true wealth', 't.r.u.e', 'true'],
  meetup:     ['meetup', 'networking', 'social', 'hike', 'brunch'],
  commercial: ['commercial club', 'commercial'],
  workshop:   ['workshop', 'lab', 'walkthrough', 'onsite', 'on-site'],
};

function detectStrategies(title, subtitle) {
  const text = ((title || '') + ' ' + (subtitle || '')).toLowerCase();
  const matched = [];
  for (const [strategy, keywords] of Object.entries(STRATEGY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      matched.push(strategy);
    }
  }
  // Default to general if nothing matched
  if (matched.length === 0) matched.push('general');
  return matched;
}

function detectEventType(title, subtitle) {
  const text = ((title || '') + ' ' + (subtitle || '')).toLowerCase();
  for (const [type, keywords] of Object.entries(EVENT_TYPE_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return type;
  }
  return 'main';
}

async function syncEvents(customValues, supabaseUrl, supabaseKey) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Prefer': 'resolution=merge-duplicates,return=minimal'
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const events = [];

  for (let slot = 1; slot <= 9; slot++) {
    const slotKey = `${slot} Mtg`;
    const cv  = (name) => customValues.find(v => v.name === `${slotKey} ${name}`)?.value || '';
    const cvn = (name) => customValues.find(v => v.name === `${slotKey} ${name}`)?.value || null;

    const title    = cv('Title');
    const desc1    = cvn('Desc');
    const desc2    = cvn('Desc 2');
    // Clean malformed dates like "2026- 06- 17 06:30 PM" and normalize for parsing
    const rawDate2  = cv('Date 2');
    const date2     = rawDate2.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
    const location           = cv('Location Name');
    const locationAddressRaw = cv('Location Address');
    // Some slots have a URL mistakenly entered in Location Address (e.g. survey or Zoom links)
    // Filter those out so a URL never ends up in spoken event_location text
    const locationAddress = /^https?:\/\//i.test(locationAddressRaw.trim()) ? '' : locationAddressRaw;
    const times    = cv('Times') || cv('Time');
    const subtitle = cv('Subtitle');
    const speaker  = cv('Speaker Bio 1');
    // Slot 6 uses "Free- Event" (extra dash) instead of "Free Event" — handle both
    const link     = cv('Page Redirect (Free Event)') || cv('Page Redirect (Free- Event)') || cv('Registration Link') || cv('Link');

    if (!title || !date2) continue;

    // Parse date — GHL format is "2026-07-14 11:30 AM"
    // Convert to ISO-compatible format: replace space before time with T
    const dateForParsing = date2.slice(0, 10); // just YYYY-MM-DD is enough
    const eventDate = new Date(dateForParsing + 'T00:00:00');
    if (isNaN(eventDate.getTime())) {
      console.log(`Slot ${slot} — skipped, invalid date: "${date2}"`);
      continue;
    }

    const strategies = detectStrategies(title, subtitle);
    const eventType  = detectEventType(title, subtitle);

    // Extract speaker name from bio (first sentence or up to first period)
    const speakerName = speaker
      ? speaker.split(/[.!?]/)[0].replace(/^(featuring|with|speaker:|presented by)/i, '').trim()
      : '';

    events.push({
      slot,
      event_title:        title,
      event_subtitle:     subtitle,
      event_description:  desc1,
      event_description_2: desc2,
      event_date:         dateForParsing,
      event_time:         times,
      event_location:     locationAddress ? `${location}, ${locationAddress}` : location,
      speaker_name:       speakerName,
      speaker_bio:        speaker,
      registration_url:   link,
      strategies,
      event_type:         eventType,
      is_active:          eventDate >= today,
      ghl_slot_key:       `slot_${slot}`,
      synced_at:          new Date().toISOString()
    });
  }

  if (events.length === 0) {
    console.log('No events to sync');
    return { synced: 0, active: 0 };
  }

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/ghl_upcoming_events?on_conflict=ghl_slot_key`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(events)
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Event sync failed: ${err}`);
  }

  const active = events.filter(e => e.is_active).length;
  console.log(`Events synced: ${events.length} total, ${active} upcoming`);
  return { synced: events.length, active };
}

// ============================================================
// GET handler — called by Vercel cron and GitHub Actions nightly
// Fetches GHL custom values and syncs event slots to Supabase
// ============================================================

// Export for use in the main sync handler
if (typeof module !== 'undefined') {
  module.exports = { syncEvents };
}