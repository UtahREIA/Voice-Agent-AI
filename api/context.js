// Vapi Tool endpoint — called at the start of every conversation
// Returns live Utah REIA knowledge: board members, vendors, recent events
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  const db = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: baseHeaders });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  };

  try {
    // Fetch board members with their specialties
    const boardRaw = await db(
      `contacts?membership_type=eq.Board Member&membership_status=eq.Active&select=full_name,investor_profiles(investing_types,topics_interested_in),vendor_profiles(service_types)&limit=30`
    );

    const boardMembers = boardRaw.map(c => {
      const investing = c.investor_profiles?.investing_types || [];
      const topics    = c.investor_profiles?.topics_interested_in || null;
      const services  = c.vendor_profiles?.service_types || [];
      const details   = [...investing, ...(topics ? [topics] : []), ...services].filter(Boolean);
      return {
        name: c.full_name,
        specialties: details.length > 0 ? details.join(', ') : null
      };
    }).filter(b => b.name);

    // Fetch active vendors
    const vendorRaw = await db(
      `vendor_profiles?select=service_types,contractor_specialties,contacts(full_name,company_name,membership_status)&limit=50`
    );

    const vendors = vendorRaw
      .filter(v => v.contacts?.membership_status === 'Active' && v.service_types?.length > 0)
      .map(v => ({
        name: v.contacts?.company_name || v.contacts?.full_name,
        contact: v.contacts?.company_name ? v.contacts?.full_name : null,
        services: v.service_types,
        specialties: v.contractor_specialties || []
      }))
      .filter(v => v.name);

    // Build context string for Vapi
    let context = 'LIVE UTAH REIA KNOWLEDGE — updated at call start:\n\n';

    if (boardMembers.length > 0) {
      context += 'BOARD MEMBERS & LEADERSHIP:\n';
      boardMembers.forEach(b => {
        context += '- ' + b.name + (b.specialties ? ' — ' + b.specialties : '') + '\n';
      });
      context += '\n';
    }

    if (vendors.length > 0) {
      context += 'ACTIVE VENDORS & SERVICE PROVIDERS:\n';
      vendors.forEach(v => {
        const who  = v.contact && v.contact !== v.name ? v.name + ' (contact: ' + v.contact + ')' : v.name;
        const svcs = v.services.join(', ');
        const specs = v.specialties?.length > 0 ? ' — specialties: ' + v.specialties.join(', ') : '';
        context += '- ' + who + ': ' + svcs + specs + '\n';
      });
      context += '\n';
    }

    context += 'RECENT EVENTS:\n';
    context += '- How Deals Are Found, Structured, and Funded (April 2026)\n';
    context += '- Practical AI for Investors and Real Estate Pros (March 2026)\n';
    context += '- How Credit Impacts Your Investing Power (March 2026)\n';
    context += '- Structuring Deals Beyond the Bank (March 2026)\n';
    context += '- Inside a Real Fix and Flip Project (February 2026)\n';
    context += '- Smarter Renovations That Drive Flip Profits (February 2026)\n';
    context += '- Note Investing 101 — Turn Paper into Profit (November 2025)\n';
    context += '- Raise Private Money Like a Pro (August 2025)\n';

    console.log('Context built — board:', boardMembers.length, 'vendors:', vendors.length);

    // Return in Vapi tool response format
    return res.status(200).json({
      result: context.trim()
    });

  } catch(e) {
    console.error('Context error:', e.message);
    // Return a fallback so the call still works even if Supabase is down
    return res.status(200).json({
      result: 'Live community data temporarily unavailable. Use the knowledge in your system prompt.'
    });
  }
}
