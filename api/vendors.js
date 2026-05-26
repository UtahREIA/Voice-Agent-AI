// Map 2 Vendor Matching — queries vendor_routing_matrix from Supabase
// Accepts all diagnostic dimensions, returns matched vendor categories and specific vendors

/**
 * Vendor-matching tool called by the voice agent mid-call. Returns a single
 * `result` string the agent speaks aloud — up to 4 named active vendors with
 * their company, contact, and primary services.
 *
 * Inputs (all optional):
 *   - blocker        The caller's stated blocker (capital/deals/team/…)
 *   - investor_need  More specific need keyword; takes precedence over blocker
 *   - strategy       Investing strategy for tighter routing (Fix & Flip, BRRRR…)
 *   - stage          (accepted but currently unused in matching)
 *   - already_tried  Comma-separated company-name fragments to exclude
 *
 * Two-stage match:
 *   1) vendor_routing_matrix lookup. Tries the exact (need, strategy) row
 *      first; falls back to a need-only row with strategy=NULL when nothing
 *      matches. Yields a set of vendor_categories (service-type search terms)
 *      and vendor_subtypes used for the "who specialize in …" voice clause.
 *   2) vendor_profiles fan-out filtered to active members whose service_types
 *      include any of the matrix-derived terms (case-insensitive substring),
 *      capped at 4.
 *
 * Defaults: if step 1 produces no categories, falls back to ["Real Estate
 * Agent", "General Education"] so the agent always has something to suggest.
 *
 * Always returns 200 — generic fallback string on zero matches or any throw.
 *
 * @param {import('http').IncomingMessage & { body: any, method: string }} req - POST with diagnostic fields
 * @param {import('http').ServerResponse & { status: Function, json: Function, end: Function }} res
 * @returns {Promise<void>} 200 `{ result: <spoken response string> }`
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const {
    blocker,
    strategy,
    investor_need,
    stage,
    already_tried
  } = req.body || {};

  console.log('Vendor match — blocker:', blocker, 'strategy:', strategy, 'need:', investor_need);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Normalize inputs
    const needKey = (investor_need || blocker || '').toLowerCase().replace(/ /g, '_');
    const strategyKey = (strategy || '').toLowerCase().replace(/ /g, '_').replace(/ and /g, '_and_');

    // Step 1 — query vendor_routing_matrix for need x strategy match
    let matrixRows = [];

    // Try exact need + strategy match first
    if (needKey && strategyKey) {
      const exactResp = await fetch(
        `${SUPABASE_URL}/rest/v1/vendor_routing_matrix?investor_need=eq.${encodeURIComponent(needKey)}&strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&select=vendor_categories,vendor_subtypes,connection_methods&order=priority.asc&limit=2`,
        { headers: baseHeaders }
      );
      matrixRows = await exactResp.json();
    }

    // Fall back to need only if no strategy match
    if (matrixRows.length === 0 && needKey) {
      const needResp = await fetch(
        `${SUPABASE_URL}/rest/v1/vendor_routing_matrix?investor_need=eq.${encodeURIComponent(needKey)}&strategy=is.null&is_active=eq.true&select=vendor_categories,vendor_subtypes,connection_methods&order=priority.asc&limit=2`,
        { headers: baseHeaders }
      );
      matrixRows = await needResp.json();
    }

    // Extract service types from matrix
    const searchTerms = new Set();
    matrixRows.forEach(row => {
      row.vendor_categories?.forEach(c => searchTerms.add(c));
    });

    // Default if nothing matched
    if (searchTerms.size === 0) {
      searchTerms.add('Real Estate Agent');
      searchTerms.add('General Education');
    }

    // Step 2 — query vendor_profiles filtered by matched service types
    const vendorResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_profiles?select=service_types,contacts(full_name,company_name,membership_status,phone)&service_types=not.is.null&limit=200`,
      { headers: baseHeaders }
    );
    const vendors = await vendorResp.json();

    // Filter by service type match and active membership
    const alreadyTriedList = already_tried
      ? already_tried.toLowerCase().split(',').map(s => s.trim())
      : [];

    const terms = Array.from(searchTerms).map(t => t.toLowerCase());
    const matched = vendors
      .filter(v => {
        if (v.contacts?.membership_status !== 'Active') return false;
        // Filter out already tried vendors
        const vendorName = (v.contacts?.company_name || v.contacts?.full_name || '').toLowerCase();
        if (alreadyTriedList.some(tried => vendorName.includes(tried))) return false;
        return v.service_types?.some(st => terms.some(t => st.toLowerCase().includes(t)));
      })
      .slice(0, 4);

    // Build natural spoken response
    if (matched.length === 0) {
      return res.status(200).json({
        result: `We have vendors in our community for that need. I will make sure someone from our team follows up with specific names based on your situation.`
      });
    }

    const names = matched.map(v => {
      const co = v.contacts?.company_name || v.contacts?.full_name || '';
      const contact = v.contacts?.company_name ? v.contacts?.full_name : null;
      const services = v.service_types?.slice(0, 2).join(', ') || '';
      return contact ? `${co} — contact ${contact} — ${services}` : `${co} — ${services}`;
    }).join('; ');

    // Include subtype context in response
    const subtypes = matrixRows.flatMap(r => r.vendor_subtypes || []).slice(0, 2).join(' and ');
    const context = subtypes ? ` who specialize in ${subtypes}` : '';

    const result = `Here are the best matches in our community${context}: ${names}. These are all active Utah REIA members.`;

    console.log(`Vendor match — ${matched.length} vendors found, categories: ${Array.from(searchTerms).join(', ')}`);
    return res.status(200).json({ result });

  } catch(e) {
    console.error('Vendor match error:', e.message);
    return res.status(200).json({
      result: 'We have vendors in our community for that need. Our team will follow up with specific recommendations based on your situation.'
    });
  }
}