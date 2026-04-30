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

const BLOCKER_SERVICES = {
  capital:     ['Money Lender', 'Mortgage Broker', 'Investment Advisor'],
  deals:       ['Wholesaler', 'Bird Dog', 'Real Estate Agent'],
  team:        ['Contractors', 'Property Manager', 'HVAC', 'Home Inspector', 'Engineer', 'Building Supplies'],
  education:   ['General Education', 'Investment Advisor'],
  numbers:     ['Accountant', 'Accountant & Tax Specialist', 'Appraiser'],
  connections: [],
};

// Recent event titles parsed from GHL custom field names
// These are the actual events Utah REIA has run — ordered most recent first
const RECENT_EVENTS = [
  { date: '04/28/2026', title: 'How Deals Are Found, Structured, and Funded' },
  { date: '04/23/2026', title: 'Escalar con intención: de house hack a 36 unidades' },
  { date: '04/14/2026', title: 'From Entitlement to Exit: How These Townhomes Beat the Market' },
  { date: '04/11/2026', title: "Women's Real Estate Investor Hike and Brunch" },
  { date: '04/09/2026', title: 'The Impact Of Your Credit Score as a RE Investor' },
  { date: '03/24/2026', title: 'Practical AI for Investors and Real Estate Pros' },
  { date: '03/19/2026', title: 'How Credit Impacts Your Investing Power' },
  { date: '03/12/2026', title: 'Structuring Deals Beyond the Bank' },
  { date: '03/10/2026', title: 'On-Site Flip Analysis and Execution Lab' },
  { date: '02/26/2026', title: 'Cómo Usar IA para Generar Leads Inmobiliarios' },
  { date: '02/24/2026', title: 'Navigating Market Cycles in Ground-Up Development' },
  { date: '02/19/2026', title: 'Seller Negotiation Strategies That Close Deals' },
  { date: '02/12/2026', title: 'Smarter Renovations That Drive Flip Profits' },
  { date: '02/10/2026', title: 'Inside a Real Fix and Flip Project' },
  { date: '01/27/2026', title: "Inside the 2026 Playbook of Utah's Leading Wholesalers" },
  { date: '01/22/2026', title: 'What Makes a Real Estate Deal Work Today?' },
  { date: '01/15/2026', title: 'From Vision to Action: Your 2026 Plan' },
  { date: '01/13/2026', title: "2026 Isn't Killing Deals. Old Strategies Are." },
  { date: '12/10/2025', title: 'A Holiday Event With A Twist Investors Wont Expect' },
  { date: '11/25/2025', title: 'Real Estate Investing & Infinite Banking - A Strategy for Cash Flow and Control' },
  { date: '11/12/2025', title: 'Holiday Investor Social - Music, Mingling & Momentum' },
  { date: '11/11/2025', title: 'Note Investing 101 - Turn Paper into Profit' },
  { date: '10/28/2025', title: 'EXPO 2025 - Real Estate, AI & Wealth Strategies That Work Now' },
  { date: '10/14/2025', title: 'From Stale to SOLD: Staging Strategies That Work' },
  { date: '10/10/2025', title: 'No money? No problem. Get funded by the end of the day.' },
  { date: '09/23/2025', title: 'Flip That Land, From Raw Land to Cashflow' },
  { date: '09/09/2025', title: 'Flip Like a Pro: Live Property Walkthrough & Inspector Secrets' },
  { date: '08/26/2025', title: 'The One, Big, Beautiful Tax Update!' },
  { date: '08/22/2025', title: 'Raise Private Money Like a Pro (No Banks, No Credit Checks!)' },
  { date: '08/12/2025', title: 'Money in the Mess: A Live Flip Case Study + Construction & Insurance Secrets' },
];

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

    // ── CONTEXT: pull live knowledge package for Claude at call start ─────────
    if (action === 'context') {

      // 1. Board members with their specialties
      const boardRaw = await db(
        `contacts?membership_type=eq.Board Member&membership_status=eq.Active&select=full_name,investor_profiles(investing_types,topics_interested_in),vendor_profiles(service_types)&limit=30`
      );

      const boardMembers = boardRaw.map(c => {
        const investing = c.investor_profiles?.investing_types || [];
        const topics = c.investor_profiles?.topics_interested_in || null;
        const services = c.vendor_profiles?.service_types || [];
        const details = [
          ...investing,
          ...(topics ? [topics] : []),
          ...services
        ].filter(Boolean);
        return {
          name: c.full_name,
          specialties: details.length > 0 ? details.join(', ') : null
        };
      }).filter(b => b.name);

      // 2. Active vendors with service types and company names
      const vendorRaw = await db(
        `vendor_profiles?select=service_types,contractor_specialties,contacts(full_name,company_name,membership_status)&limit=50`
      );

      const vendors = vendorRaw
        .filter(v =>
          v.contacts?.membership_status === 'Active' &&
          v.service_types &&
          v.service_types.length > 0
        )
        .map(v => ({
          name: v.contacts?.company_name || v.contacts?.full_name,
          contact: v.contacts?.company_name ? v.contacts?.full_name : null,
          services: v.service_types,
          specialties: v.contractor_specialties || []
        }))
        .filter(v => v.name);

      // 3. Most recent 15 events
      const recentEvents = RECENT_EVENTS.slice(0, 15);

      // 4. Membership tiers summary
      const membershipTiers = [
        { tier: 'Board Member', description: 'Core leadership — educators, mentors, and operators who run Utah Ria' },
        { tier: 'Platinum Annual', description: 'Most committed investors — full access to all resources, deal flow, and community' },
        { tier: 'Couples Annual', description: 'Annual membership for two investors — full community access' },
        { tier: 'Individual Annual', description: 'Full annual membership — events, tools, vendor directory, and community' },
        { tier: 'Vendor Annual', description: 'Service provider membership — listed in vendor directory, connected to investors' },
        { tier: 'Individual Monthly', description: 'Month-to-month membership — all core benefits' },
        { tier: 'Online Membership', description: 'Digital access — event replays, Investor Academy, and online resources' },
      ];

      return res.status(200).json({
        boardMembers,
        vendors,
        recentEvents,
        membershipTiers
      });
    }

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

      const existing = await db(
        `contacts?email=eq.${encodeURIComponent(contact.email)}&select=id&limit=1`
      );

      let contactId;

      if (existing.length > 0) {
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

      const dbStage = STAGE_MAP[profile.stage] || null;
      const dbStrategies = (profile.strategies || []).map(s => STRATEGY_MAP[s] || s);
      const blocker = profile.blocker || '';

      const investorProfileData = {
        contact_id: contactId,
        where_in_journey: dbStage,
        investing_types: dbStrategies.length ? dbStrategies : null,
        goals_6_to_12_months: profile.goals ? [profile.goals] : null,
        updated_at: new Date().toISOString(),
        ...(blocker === 'capital'     && { funding_financial:   ['Needs funding / capital'] }),
        ...(blocker === 'deals'       && { deals_opportunities: ['Looking for deals'] }),
        ...(blocker === 'team'        && { team_vendors:        ['Needs team / vendors'] }),
        ...(blocker === 'education'   && { education_tools:     ['Needs education'] }),
        ...(blocker === 'connections' && { growth_network:      ['Looking for peer connections'] }),
      };

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
      const blocker    = profile.blocker || '';
      const stage      = profile.stage || '';
      const strategies = (profile.strategies || []).map(s => STRATEGY_MAP[s] || s);

      const targetServices = BLOCKER_SERVICES[blocker] || [];
      const dbStage = STAGE_MAP[stage] || null;

      let vendorRows = [];
      if (targetServices.length > 0) {
        vendorRows = await db(
          `vendor_profiles?service_types=ov.{${encodeURIComponent(targetServices.join(','))}}&select=contact_id,service_types,contractor_specialties,contacts(full_name,company_name,email)&limit=5`
        );
      }

      let peerRows = [];
      if (dbStage && strategies.length > 0) {
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