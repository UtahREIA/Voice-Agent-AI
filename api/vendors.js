// Map 2 Vendor Matching — Vapi Tool Call endpoint
// Accepts blocker and strategy, returns matching vendors from Supabase
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { blocker, strategy } = req.body || {};
  console.log('Vendor match request — blocker:', blocker, 'strategy:', strategy);

  // Map blocker and strategy to service_type search terms
  const blockerServiceMap = {
    'capital':     ['Money Lender', 'Hard Money', 'Private Lender', 'Mortgage'],
    'deals':       ['Bird Dog', 'Real Estate Agent', 'Wholesaler'],
    'team':        ['Contractors', 'General Contractor', 'Property Manager'],
    'education':   ['General Education', 'Coach', 'Educator'],
    'connections': ['Real Estate Agent', 'Bird Dog'],
    'numbers':     ['Accountant', 'CPA', 'General Education'],
    'legal':       ['Attorney', 'Legal'],
    'management':  ['Property Manager']
  };

  const strategyServiceMap = {
    'fix_and_flip':        ['Contractors', 'General Contractor', 'Hard Money', 'Money Lender'],
    'buy_and_hold':        ['Property Manager', 'Money Lender', 'Real Estate Agent'],
    'wholesaling':         ['Bird Dog', 'Real Estate Agent', 'Contractors'],
    'brrrr':               ['Contractors', 'Property Manager', 'Money Lender'],
    'short_term_rental':   ['Property Manager', 'Real Estate Agent'],
    'commercial':          ['Commercial', 'Attorney', 'Real Estate Agent'],
    'creative_financing':  ['Attorney', 'Money Lender'],
    'notes_and_lending':   ['Money Lender', 'Attorney'],
    'development':         ['Contractors', 'General Contractor', 'Attorney'],
    'land':                ['Real Estate Agent', 'Attorney']
  };

  // Build search terms from blocker and strategy
  const searchTerms = new Set();
  if (blocker && blockerServiceMap[blocker.toLowerCase()]) {
    blockerServiceMap[blocker.toLowerCase()].forEach(t => searchTerms.add(t));
  }
  if (strategy) {
    const stratKey = strategy.toLowerCase().replace(/ /g, '_').replace(/&/g, 'and');
    if (strategyServiceMap[stratKey]) {
      strategyServiceMap[stratKey].forEach(t => searchTerms.add(t));
    }
  }

  // Default to broad search if no terms matched
  if (searchTerms.size === 0) {
    searchTerms.add('Real Estate Agent');
    searchTerms.add('General Education');
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Query vendors with service_types populated — filter by search terms
    const vendorResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_profiles?select=service_types,contractor_specialties,contacts(full_name,company_name,membership_status)&service_types=not.is.null&limit=50`,
      { headers: baseHeaders }
    );
    const vendors = await vendorResp.json();

    // Filter vendors whose service_types overlap with search terms
    const terms = Array.from(searchTerms).map(t => t.toLowerCase());
    const matched = vendors.filter(v => {
      if (!v.service_types || !Array.isArray(v.service_types)) return false;
      if (v.contacts?.membership_status !== 'Active') return false;
      return v.service_types.some(st => terms.some(t => st.toLowerCase().includes(t)));
    });

    // Format results for Vapi
    const results = matched.slice(0, 5).map(v => {
      const name = v.contacts?.company_name || v.contacts?.full_name || 'Unknown';
      const contact = v.contacts?.company_name ? v.contacts?.full_name : null;
      const services = v.service_types?.join(', ') || '';
      return contact ? `${name} (${contact}) — ${services}` : `${name} — ${services}`;
    });

    let resultText = '';
    if (results.length > 0) {
      resultText = `Based on what you need, here are the best matches in the Utah REIA community: ${results.join('; ')}. You can connect with any of these through the vendor directory on our website.`;
    } else {
      resultText = `We have vendors in our directory for that need. Check the vendor directory on our website and our team can make a direct introduction based on what you are looking for.`;
    }

    console.log('Vendor match results:', results.length, 'found');
    return res.status(200).json({ result: resultText });

  } catch(e) {
    console.error('Vendor match error:', e.message);
    return res.status(200).json({
      result: 'Our vendor directory has matches for that need. Check the vendor section on our website or ask us to make a direct introduction.'
    });
  }
}
