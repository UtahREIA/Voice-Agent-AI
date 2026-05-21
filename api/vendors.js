// Map 2 Vendor Matching — all mapping logic from Supabase, no hardcoded knowledge
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { blocker, strategy } = req.body || {};
  console.log('Vendor match — blocker:', blocker, 'strategy:', strategy);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // 1. Get service types for this blocker and strategy from Supabase mapping table
    const searchTerms = new Set();

    if (blocker) {
      const blockerResp = await fetch(
        `${SUPABASE_URL}/rest/v1/blocker_service_mapping?blocker=eq.${encodeURIComponent(blocker.toLowerCase())}&strategy=is.null&select=service_types`,
        { headers: baseHeaders }
      );
      const blockerMappings = await blockerResp.json();
      blockerMappings.forEach(m => m.service_types?.forEach(t => searchTerms.add(t)));
    }

    if (strategy) {
      const stratKey = strategy.toLowerCase().replace(/ /g, '_').replace(/&/g, 'and');
      const stratResp = await fetch(
        `${SUPABASE_URL}/rest/v1/blocker_service_mapping?blocker=eq.strategy&strategy=eq.${encodeURIComponent(stratKey)}&select=service_types`,
        { headers: baseHeaders }
      );
      const stratMappings = await stratResp.json();
      stratMappings.forEach(m => m.service_types?.forEach(t => searchTerms.add(t)));
    }

    // Default if no terms found
    if (searchTerms.size === 0) {
      searchTerms.add('Real Estate Agent');
      searchTerms.add('General Education');
    }

    // 2. Query vendors matching those service types
    const vendorResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_profiles?select=service_types,contacts(full_name,company_name,membership_status,phone,email)&service_types=not.is.null&limit=100`,
      { headers: baseHeaders }
    );
    const vendors = await vendorResp.json();

    // Filter by matching service types and active membership
    const terms = Array.from(searchTerms).map(t => t.toLowerCase());
    const matched = vendors.filter(v => {
      if (v.contacts?.membership_status !== 'Active') return false;
      return v.service_types?.some(st => terms.some(t => st.toLowerCase().includes(t)));
    }).slice(0, 5);

    // Format result
    if (matched.length === 0) {
      return res.status(200).json({
        result: 'We have vendors in our directory for that need. Check the vendor directory on our website or ask us to make a direct introduction.'
      });
    }

    const names = matched.map(v => {
      const co = v.contacts?.company_name || v.contacts?.full_name || '';
      const contact = v.contacts?.company_name ? v.contacts?.full_name : null;
      const services = v.service_types?.slice(0, 2).join(', ') || '';
      return contact ? `${co} (${contact}) — ${services}` : `${co} — ${services}`;
    }).join('; ');

    const category = blocker || strategy || 'that need';
    const result = `Here are the best matches in our community for ${category}: ${names}. You can connect with any of them through the vendor directory on our website.`;

    console.log(`Vendor match — ${matched.length} vendors found for blocker: ${blocker}, strategy: ${strategy}`);
    return res.status(200).json({ result });

  } catch(e) {
    console.error('Vendor match error:', e.message);
    return res.status(200).json({
      result: 'Our vendor directory has matches for that need. Check the vendor section on our website or ask us to make a direct introduction.'
    });
  }
}