// Member Recognition — looks up caller by phone number in Supabase
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  console.log('--- member-lookup called ---');
  console.log('SUPABASE_URL set:', !!SUPABASE_URL);
  console.log('SUPABASE_KEY set:', !!SUPABASE_KEY);
  console.log('Request body:', JSON.stringify(req.body));

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase env vars');
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { phone } = req.body || {};

  if (!phone) {
    console.log('No phone provided');
    return res.status(200).json({ found: false, result: 'No phone number provided.' });
  }

  const normalized = phone.replace(/\D/g, '');
  const last10 = normalized.slice(-10);
  console.log('Phone received:', phone, '| normalized last10:', last10);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Fetch all contacts with phones and filter in JS
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,profile_type,is_board_member,member_role,last_reia_event&phone=not.is.null&limit=500`,
      { headers: baseHeaders }
    );

    console.log('Supabase contacts fetch status:', resp.status);
    const allContacts = await resp.json();
    console.log('Total contacts fetched:', allContacts.length);

    if (!Array.isArray(allContacts)) {
      console.error('Unexpected contacts response:', JSON.stringify(allContacts));
      return res.status(200).json({ found: false, result: 'Database error. Please continue.' });
    }

    // Filter by last 10 digits
    const contacts = allContacts.filter(c => {
      if (!c.phone) return false;
      const digits = c.phone.replace(/\D/g, '');
      const match = digits.slice(-10) === last10;
      if (match) console.log('MATCH FOUND:', c.full_name, c.phone);
      return match;
    });

    console.log('Matching contacts:', contacts.length);

    if (contacts.length === 0) {
      console.log('No member found for phone:', last10);
      return res.status(200).json({ found: false, result: 'not_found' });
    }

    const contact = contacts[0];
    const contactId = contact.id;
    const memberName = contact.full_name?.split(' ')[0] || 'there';
    const status = contact.membership_status || 'Unknown';
    const memberType = contact.membership_type || null;
    const isBoard = contact.is_board_member;

    console.log('Contact found:', memberName, '| status:', status, '| id:', contactId);

    // Fetch investor profile
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months&limit=1`,
      { headers: baseHeaders }
    );
    const profiles = await profileResp.json();
    const profile = profiles?.[0] || null;
    console.log('Investor profile found:', !!profile);

    // Fetch event attendance
    const eventResp = await fetch(
      `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${contactId}&select=event_name,attended_at&order=attended_at.desc&limit=3`,
      { headers: baseHeaders }
    );
    const events = await eventResp.json();
    console.log('Events attended:', events?.length || 0);

    // Fetch last voice agent survey
    const surveyResp = await fetch(
      `${SUPABASE_URL}/rest/v1/readiness_surveys?contact_id=eq.${contactId}&source=eq.voice_agent&select=answers,created_at&order=created_at.desc&limit=1`,
      { headers: baseHeaders }
    );
    const surveys = await surveyResp.json();
    const lastSurvey = surveys?.[0] || null;

    // Build personalized greeting
    const parts = [];

    if (status === 'Active') {
      parts.push(`Welcome back ${memberName}, good to hear from you again.`);
    } else if (status === 'Inactive') {
      parts.push(`Hey ${memberName}, welcome back, looks like you have been with us before.`);
    } else {
      parts.push(`Hey ${memberName}, good to connect with you.`);
    }

    const knownFacts = [];

    const stage = profile?.investing_journey_stage;
    if (stage) knownFacts.push(`you are at the ${stage} stage`);

    const strategyList = profile?.investing_interests;
    if (strategyList?.length > 0) {
      const stratStr = Array.isArray(strategyList)
        ? strategyList.slice(0, 2).join(' and ')
        : strategyList;
      knownFacts.push(`you have been focused on ${stratStr}`);
    }

    if (memberType) knownFacts.push(`you are a ${memberType} member`);

    if (contact.last_reia_event && events?.length === 0) {
      knownFacts.push(`you attended ${contact.last_reia_event}`);
    }

    if (events?.length > 0) {
      const names = events.map(e => e.event_name).filter(Boolean).slice(0, 2);
      if (names.length > 0) knownFacts.push(`you attended ${names.join(' and ')}`);
    }

    if (lastSurvey?.answers) {
      try {
        const answers = typeof lastSurvey.answers === 'string'
          ? JSON.parse(lastSurvey.answers)
          : lastSurvey.answers;
        if (answers.blocker) knownFacts.push(`last time your main blocker was ${answers.blocker}`);
      } catch(e) {}
    }

    if (isBoard) knownFacts.push(`you are one of our board members`);

    if (knownFacts.length > 0) {
      parts.push(`I can see ${knownFacts.slice(0, 3).join(', and ')}.`);
    }

    parts.push(`What can I help you with today?`);

    const result = parts.join(' ');
    console.log('Final greeting:', result);

    return res.status(200).json({
      found: true,
      member_name: memberName,
      membership_status: status,
      stage: stage || null,
      strategies: strategyList || null,
      is_board: isBoard || false,
      result
    });

  } catch(e) {
    console.error('Member lookup EXCEPTION:', e.message, e.stack);
    return res.status(200).json({ found: false, result: 'not_found' });
  }
}