const STAGE_MAP = {
  exploring:       'Exploring / New',
  getting_started: 'Getting Started',
  active:          'Active Investor',
  experienced:     'Experienced Investor',
  veteran:         'Experienced Investor',
};

const STRATEGY_MAP = {
  fix_and_flip:      'Fix & Flip',
  buy_and_hold:      'Buy & Hold',
  wholesaling:       'Wholesaling',
  brrrr:             'BRRRR',
  short_term_rental: 'Short Term Rental',
  creative_financing:'Creative Financing',
  notes_and_lending: 'Notes & Lending',
  commercial:        'Commercial',
  development:       'Development',
  land:              'Land / Entitlement',
  passive_investing: 'Passive Investing',
  raising_capital:   'Raising Capital',
  tax_deeds:         'Tax Deeds & Liens',
  out_of_state:      'Out of State',
};

// Maps caller's blocker to the service types in vendor_profiles that resolve it
const BLOCKER_SERVICES = {
  capital:     ['Money Lender', 'Mortgage Broker', 'Investment Advisor'],
  deals:       ['Wholesaler', 'Bird Dog', 'Real Estate Agent'],
  team:        ['Contractors', 'Property Manager', 'HVAC', 'Home Inspector', 'Engineer', 'Building Supplies'],
  education:   ['General Education', 'Investment Advisor'],
  numbers:     ['Accountant', 'Accountant & Tax Specialist', 'Appraiser'],
  connections: [],
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured.' });
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
  };

  const db = async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { ...baseHeaders, ...(opts.headers || {}) },
      ...opts,
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  };

  const { action } = req.body;

  try {
    // ── LOOKUP: find existing contact + investor profile by email ─────────────
    if (action === 'lookup') {
      const { email } = req.body;
      const contacts = await db(
        `contacts?email=eq.${encodeURIComponent(email)}&select=*,investor_profiles(*)&limit=1`
      );
      return res.status(200).json(contacts[0] || null);
    }

    // ── UPSERT: save contact + investor profile from voice call ───────────────
    if (action === 'upsert') {
      const { contact, profile } = req.body;

      // Check if contact already exists by email
      const existing = await db(
        `contacts?email=eq.${encodeURIComponent(contact.email)}&select=id&limit=1`
      );

      let contactId;

      if (existing.length > 0) {
        // Update existing contact
        contactId = existing[0].id;
        await db(`contacts?id=eq.${contactId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            full_name: contact.name,
            phone: contact.phone,
            updated_at: new Date().toISOString(),
          }),
        });
      } else {
        // Insert new contact (voice agent lead — no ghl_contact_id yet)
        const [created] = await db('contacts', {
          method: 'POST',
          body: JSON.stringify({
            full_name: contact.name,
            email: contact.email,
            phone: contact.phone,
            profile_type: profile.role === 'vendor' ? 'Service Provider' : 'Investor',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });
        if (!created?.id) throw new Error('Contact insert returned no id');
        contactId = created.id;
      }

      // Map AI values to DB column names
      const dbStage = STAGE_MAP[profile.stage] || null;
      const dbStrategies = (profile.strategies || []).map(s => STRATEGY_MAP[s] || s);

      // Map blocker to the relevant need buckets
      const blocker = profile.blocker || '';
      const investorProfileData = {
        contact_id: contactId,
        where_in_journey: dbStage,
        investing_types: dbStrategies.length ? dbStrategies : null,
        goals_6_to_12_months: profile.goals ? [profile.goals] : null,
        updated_at: new Date().toISOString(),
        // Populate the relevant need bucket based on stated blocker
        ...(blocker === 'capital'     && { funding_financial:   ['Needs funding / capital'] }),
        ...(blocker === 'deals'       && { deals_opportunities: ['Looking for deals'] }),
        ...(blocker === 'team'        && { team_vendors:        ['Needs team / vendors'] }),
        ...(blocker === 'education'   && { education_tools:     ['Needs education'] }),
        ...(blocker === 'connections' && { growth_network:      ['Looking for peer connections'] }),
      };

      // Check if investor_profile exists
      const existingProfile = await db(
        `investor_profiles?contact_id=eq.${contactId}&select=id&limit=1`
      );

      if (existingProfile.length > 0) {
        await db(`investor_profiles?contact_id=eq.${contactId}`, {
          method: 'PATCH',
          body: JSON.stringify(investorProfileData),
        });
      } else {
        await db('investor_profiles', {
          method: 'POST',
          body: JSON.stringify({ ...investorProfileData, created_at: new Date().toISOString() }),
        });
      }

      return res.status(200).json({ ok: true, contact_id: contactId });
    }

    // ── MATCHES: find relevant vendors + peer investors ───────────────────────
    if (action === 'matches') {
      const { profile } = req.body;
      const blocker   = profile.blocker || '';
      const stage     = profile.stage || '';
      const strategies = (profile.strategies || []).map(s => STRATEGY_MAP[s] || s);

      const targetServices = BLOCKER_SERVICES[blocker] || [];
      const dbStage = STAGE_MAP[stage] || null;

      // Fetch vendors with matching service_types — use Postgres overlap operator
      let vendorRows = [];
      if (targetServices.length > 0) {
        const serviceFilter = targetServices.map(s => `"${s}"`).join(',');
        vendorRows = await db(
          `vendor_profiles?service_types=ov.{${encodeURIComponent(targetServices.join(','))}}&select=contact_id,service_types,contractor_specialties,contacts(full_name,company_name,email)&limit=5`
        );
      }

      // Fetch peer investors at the same journey stage who share at least one strategy
      let peerRows = [];
      if (dbStage && strategies.length > 0) {
        // Get investors at same stage, filter by strategy overlap in JS
        const allAtStage = await db(
          `investor_profiles?where_in_journey=eq.${encodeURIComponent(dbStage)}&select=contact_id,where_in_journey,investing_types,contacts(full_name)&limit=50`
        );
        peerRows = allAtStage
          .filter(p => (p.investing_types || []).some(t => strategies.includes(t)))
          .slice(0, 3);
      }

      return res.status(200).json({ vendors: vendorRows, investors: peerRows });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('Supabase handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
