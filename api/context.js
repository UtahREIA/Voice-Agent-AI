// Utah REIA Live Context — fetches all knowledge dynamically from Supabase and GHL
// No hardcoded knowledge — everything comes from the live data sources
export default async function handler(req, res) {
  // Allow requests from utahreia.org and Vercel test URL
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GHL_API_KEY  = process.env.GHL_API_KEY;
  const GHL_LOCATION = 'DNirEjy0ejVwbHsaBYrn';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // 1. ACTIVE VENDORS from Supabase — with service_types populated
    const vendorResp = await fetch(
      // vendor_profiles joins to contacts via contact_id
// Use ghl_vendor_resources instead which has company_name directly
`${SUPABASE_URL}/rest/v1/ghl_vendor_resources?select=company_name,company_phone,funding_financial,business_description,enroll_vendor_match&is_active=eq.true&limit=50`,
      { headers: baseHeaders }
    );
    const vendors = await vendorResp.json();
    const activeVendors = vendors.filter(v =>
      v.company_name &&
      v.service_types?.length > 0
    ).slice(0, 20);

    // 3. UPCOMING EVENTS from GHL custom values
    let events = [];
    if (GHL_API_KEY) {
      try {
        const ghlResp = await fetch(
          `https://services.leadconnectorhq.com/locations/${GHL_LOCATION}/customValues`,
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            }
          }
        );
        const ghlData = await ghlResp.json();
        const customValues = ghlData.customValues || [];

        // Extract event slots 1-9 from GHL custom values
        const today = new Date();
        for (let slot = 1; slot <= 9; slot++) {
          const title    = customValues.find(v => v.name === `${slot} Mtg Title`)?.value;
          const date2    = customValues.find(v => v.name === `${slot} Mtg Date 2`)?.value;
          const location = customValues.find(v => v.name === `${slot} Mtg Location Name`)?.value;
          const times    = customValues.find(v => v.name === `${slot} Mtg Times`)?.value;
          const link     = customValues.find(v => v.name === `${slot} Mtg Monthly Link`)?.value;

          if (title && date2) {
            const eventDate = new Date(date2);
            if (!isNaN(eventDate) && eventDate >= today) {
              events.push({ title, date: date2, location, times, link });
            }
          }
        }
        // Sort by date ascending
        events.sort((a, b) => new Date(a.date) - new Date(b.date));
      } catch(e) {
        console.error('GHL events fetch error:', e.message);
      }
    }

    // 3. EDUCATORS & MENTORS from ghl_educators_mentors (synced from GHL)
    let ghlEducators = [];
    try {
      const eduResp = await fetch(
        `${SUPABASE_URL}/rest/v1/ghl_educators_mentors?select=educators_name,educational_topics,educational_level,educators_url&is_active=eq.true&limit=20`,
        { headers: baseHeaders }
      );
      const eduData = await eduResp.json();
      if (Array.isArray(eduData)) ghlEducators = eduData;
    } catch(e) { console.error('GHL educators fetch error:', e.message); }

    // 4. VENDOR RESOURCES from ghl_vendor_resources (synced from GHL)
    let ghlVendors = [];
    try {
      const vendResp = await fetch(
        `${SUPABASE_URL}/rest/v1/ghl_vendor_resources?select=company_name,company_phone,business_description,funding_financial,deals_opportunities,team_vendors,investor_types&is_active=eq.true&enroll_vendor_match=eq.true&limit=50`,
        { headers: baseHeaders }
      );
      const vendData = await vendResp.json();
      if (Array.isArray(vendData)) ghlVendors = vendData;
    } catch(e) { console.error('GHL vendors fetch error:', e.message); }

    // 5. EDUCATIONAL COURSES from ghl_educational_courses (synced from GHL)
    let ghlCourses = [];
    try {
      const courseResp = await fetch(
        `${SUPABASE_URL}/rest/v1/ghl_educational_courses?select=course_name,educational_topics,educational_level,video_url,education_url,paid_education&is_active=eq.true&limit=20`,
        { headers: baseHeaders }
      );
      const courseData = await courseResp.json();
      if (Array.isArray(courseData)) ghlCourses = courseData;
    } catch(e) { console.error('GHL courses fetch error:', e.message); }

    // 6. UTAH REIA TOOLS & CALCULATORS from ghl_tools_resources
    // Synced from GHL custom object: custom_objects.tools_resources
    // This is now the source of truth for tools — replaces education_resources tool lookup
    // Includes member URL, non-member URL, membership_required, and paid_resource flags
    let tools = [];
    try {
      const toolsResp = await fetch(
        `${SUPABASE_URL}/rest/v1/ghl_tools_resources?select=resource_title,educational_topics,educational_level,resource_url,resource_url_nonmember,membership_required,paid_resource&is_active=eq.true&order=resource_title.asc&limit=20`,
        { headers: baseHeaders }
      );
      const toolsData = await toolsResp.json();
      if (Array.isArray(toolsData)) tools = toolsData;
    } catch(e) {
      console.error('Tools fetch error:', e.message);
    }

    // BUILD CONTEXT STRING
    const lines = ['LIVE UTAH REIA KNOWLEDGE — updated at call start:'];

    // Active vendors grouped by service type
    lines.push('\nACTIVE VENDORS & SERVICE PROVIDERS:');
    if (activeVendors.length > 0) {
      activeVendors.forEach(v => {
        const name = v.company_name || '';
        const contact = null;
        const services = (v.funding_financial || []).slice(0, 2).join(', ') || v.business_description?.slice(0,50) || '';
        const contactStr = '';
        lines.push(`- ${name}${contactStr}: ${services}`);
      });
    } else {
      lines.push('- Data temporarily unavailable');
    }

    // Utah REIA tools and calculators
    // PROPERTY LISTINGS
  lines.push('\nPROPERTY LISTINGS & DEALS MARKETPLACE — If a caller wants to find off-market deals, wholesale properties, or notes, OR if they want to list a property or note for sale, direct them to: https://utahreia.org/property-listing — This is the Utah REIA property and note listing marketplace where investors can browse available deals or post their own listings. Mention this proactively when the caller mentions deal flow, finding deals, listing a property, selling a note, or looking for wholesale opportunities.');

  lines.push('\nUTAH REIA TOOLS & CALCULATORS — mention these proactively when a caller asks about analyzing deals, running numbers, or needs a calculation tool. These are free and available to all Utah REIA investors:');
    if (tools.length > 0) {
      tools.forEach(t => {
        const topics = Array.isArray(t.educational_topics) ? t.educational_topics.slice(0,2).join(', ') : '';
        // Show member URL for recognized members, non-member URL for guests
        // The voice agent should use resource_url for members and resource_url_nonmember for non-members
        const memberNote = t.membership_required ? ' (membership required)' : ' (free)';
        const paidNote = t.paid_resource ? ' (paid add-on)' : '';
        lines.push(`- ${t.resource_title}${topics ? ' — for: ' + topics : ''}${memberNote}${paidNote} | Member URL: ${t.resource_url || ''} | Guest URL: ${t.resource_url_nonmember || t.resource_url || ''}`);
      });
    } else {
      // Hardcoded fallback if ghl_tools_resources is empty
      lines.push('- BRRRR Calculator: evaluate buy, rehab, rent, refinance, repeat deals (membership required)');
      lines.push('- Build Scope AI Rehab Estimator: estimate rehab and new build costs (paid add-on)');
    }

    // GHL Educators & Mentors
    if (ghlEducators.length > 0) {
      lines.push('\nEDUCATORS & MENTORS (available for booking — mention proactively when relevant):');
      ghlEducators.forEach(e => {
        const topics = Array.isArray(e.educational_topics) ? e.educational_topics.join(', ') : '';
        const levels = Array.isArray(e.educational_level) ? e.educational_level.join(', ') : '';
        lines.push(`- ${e.educators_name}: ${topics}${levels ? ' | Level: ' + levels : ''}${e.educators_url ? ' | Book: ' + e.educators_url : ''}`);
      });
    }

    // GHL Vendor Resources (opted in to vendor match)
    if (ghlVendors.length > 0) {
      lines.push('\nVENDOR PARTNERS (actively enrolled for investor connections):');
      ghlVendors.forEach(v => {
        const services = [
          ...(v.funding_financial || []),
          ...(v.deals_opportunities || []),
          ...(v.team_vendors || [])
        ].slice(0, 3).join(', ');
        lines.push(`- ${v.company_name}: ${v.business_description || services || 'Real estate vendor partner'}`);
      });
    }

    // GHL Educational Courses
    if (ghlCourses.length > 0) {
      lines.push('\nEDUCATIONAL COURSES (available to investors):');
      ghlCourses.forEach(course => {
        const topics = Array.isArray(course.educational_topics) ? course.educational_topics.join(', ') : '';
        const url = course.education_url || course.video_url || '';
        lines.push(`- ${course.course_name}: ${topics}${url ? ' | ' + url : ''}${course.paid_education ? ' (paid)' : ' (free)'}`);
      });
    }

    // Upcoming events from GHL
    lines.push('\nUPCOMING EVENTS:');
    if (events.length > 0) {
      events.slice(0, 5).forEach(e => {
        const loc = e.location ? ` at ${e.location}` : '';
        const time = e.times ? `, ${e.times}` : '';
        lines.push(`- ${e.title} (${e.date}${time}${loc})`);
      });
    } else {
      lines.push('- Check our website for the full events calendar');
    }

    const result = lines.join('\n');
    console.log(`Context built — vendors: ${activeVendors.length} events: ${events.length}`);
    return res.status(200).json({ result });

  } catch(e) {
    console.error('Context error:', e.message);
    console.error('Context error stack:', e.stack);
    return res.status(200).json({
      result: 'Live community data temporarily unavailable. Use the knowledge in your system prompt.',
      error: e.message
    });
  }
}