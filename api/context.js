// Utah REIA Live Context — fetches all knowledge dynamically from Supabase and GHL
// No hardcoded knowledge — everything comes from the live data sources
export default async function handler(req, res) {
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
      `${SUPABASE_URL}/rest/v1/vendor_profiles?select=service_types,contacts(full_name,company_name,membership_status)&service_types=not.is.null&limit=200`,
      { headers: baseHeaders }
    );
    const vendors = await vendorResp.json();
    const activeVendors = vendors.filter(v =>
      v.contacts?.membership_status === 'Active' &&
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

    // 3. UTAH REIA TOOLS & CALCULATORS from Supabase education_resources
    // These are platform tools available to investors — NOT external websites
    let tools = [];
    try {
      const toolsResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_resources?select=resource_name,resource_type,description,url,strategies,stages&resource_type=eq.tool&is_active=eq.true&limit=20`,
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
        const name = v.contacts?.company_name || v.contacts?.full_name || '';
        const contact = v.contacts?.company_name ? v.contacts?.full_name : null;
        const services = v.service_types?.slice(0, 2).join(', ') || '';
        const contactStr = contact ? ` (contact: ${contact})` : '';
        lines.push(`- ${name}${contactStr}: ${services}`);
      });
    } else {
      lines.push('- Data temporarily unavailable');
    }

    // Utah REIA tools and calculators
    lines.push('\nUTAH REIA TOOLS & CALCULATORS — mention these proactively when a caller asks about analyzing deals, running numbers, or needs a calculation tool. These are free and available to all Utah REIA investors:');
    if (tools.length > 0) {
      tools.forEach(t => {
        const strategies = t.strategies?.slice(0, 2).join(', ') || '';
        lines.push(`- ${t.resource_name}: ${t.description || ''}${strategies ? ' (for: ' + strategies + ')' : ''}`);
      });
    } else {
      // Hardcoded fallback if Supabase returns no tools
      // These are confirmed Utah REIA platform tools
      lines.push('- Fix and Flip Calculator: analyze deal numbers before making an offer');
      lines.push('- BRRRR Calculator: evaluate buy, rehab, rent, refinance, repeat deals');
      lines.push('- Rental Property Calculator: analyze cash flow and returns on rental investments');
      lines.push('- Wholesale Deal Analyzer: calculate maximum allowable offer for wholesale deals');
      lines.push('- Short Term Rental Estimator: project STR revenue and occupancy');
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