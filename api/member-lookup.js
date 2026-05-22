// Member Recognition — looks up caller by phone number in Supabase
// Called after caller confirms their phone number
// Returns personalized member profile if found, or not_found signal
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const { phone } = req.body || {};

  if (!phone) {
    return res.status(200).json({ found: false, result: 'not_found' });
  }

  // Normalize phone — strip everything except digits
  const normalized = phone.replace(/\D/g, '');
  const last10 = normalized.slice(-10);

  console.log('Member lookup — phone:', last10);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Search contacts by phone — try multiple formats
    const phoneVariants = [
      last10,
      `+1${last10}`,
      `1${last10}`,
      `(${last10.slice(0,3)}) ${last10.slice(3,6)}-${last10.slice(6)}`,
      `${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}`
    ].map(v => encodeURIComponent(v)).join(',');

    // Build all phone format variants to try
    const area = last10.slice(0, 3);
    const mid = last10.slice(3, 6);
    const end = last10.slice(6);
    const formattedPhone = `(${area}) ${mid}-${end}`;

    console.log('Trying phone formats:', formattedPhone, last10, '+1'+last10);

    // Use Supabase RPC or fetch all and filter in JS
    // Fetch contacts and filter by phone digits in application layer
    const allContactsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,profile_type,is_board_member,member_role,last_reia_event,first_meeting_date&phone=not.is.null&limit=500`,
      { headers: baseHeaders }
    );
    const allContacts = await allContactsResp.json();

    // Filter in JS by stripping non-digits and comparing last 10
    const contacts = allContacts.filter(c => {
      if (!c.phone) return false;
      const digits = c.phone.replace(/\D/g, '');
      return digits.slice(-10) === last10;
    });

    console.log(`Found ${allContacts.length} contacts total, ${contacts.length} matching phone ${last10}`);

    if (!contacts || contacts.length === 0) {
      console.log('Member not found for phone:', last10);
      return res.status(200).json({ found: false, result: 'not_found' });
    }

    const contact = contacts[0];
    const contactId = contact.id;
    const memberName = contact.full_name?.split(' ')[0] || 'there';
    const status = contact.membership_status || 'Unknown';
    const memberType = contact.membership_type || null;
    const profileType = contact.profile_type || null;
    const isBoard = contact.is_board_member;
    const lastEvent = contact.last_reia_event || null;
    const firstMeeting = contact.first_meeting_date || null;

    // Fetch investor profile
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months,what_best_describes_you_now&limit=1`,
      { headers: baseHeaders }
    );
    const profiles = await profileResp.json();
    const profile = profiles?.[0] || null;

    // Fetch recent event attendance
    const eventResp = await fetch(
      `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${contactId}&select=event_name,attended_at&order=attended_at.desc&limit=3`,
      { headers: baseHeaders }
    );
    const events = await eventResp.json();

    // Fetch most recent voice agent survey
    const surveyResp = await fetch(
      `${SUPABASE_URL}/rest/v1/readiness_surveys?contact_id=eq.${contactId}&source=eq.voice_agent&select=answers,created_at&order=created_at.desc&limit=1`,
      { headers: baseHeaders }
    );
    const surveys = await surveyResp.json();
    const lastSurvey = surveys?.[0] || null;

    // Build personalized greeting
    const parts = [];

    // Member status intro
    if (status === 'Active') {
      parts.push(`Welcome back ${memberName} — good to hear from you again.`);
    } else if (status === 'Inactive') {
      parts.push(`Hey ${memberName}, welcome back — looks like you have been with us before.`);
    } else {
      parts.push(`Hey ${memberName}, I found your profile.`);
    }

    // What we know about them
    const knownFacts = [];

    // Investing stage
    const stage = profile?.investing_journey_stage;
    if (stage) knownFacts.push(`you are at the ${stage} stage`);

    // Strategies from investor profile
    const strategyList = profile?.investing_interests;
    if (strategyList && strategyList.length > 0) {
      const stratStr = Array.isArray(strategyList)
        ? strategyList.slice(0, 2).join(' and ')
        : strategyList;
      knownFacts.push(`you have been focused on ${stratStr}`);
    }

    // Membership type
    if (memberType) {
      knownFacts.push(`you are a ${memberType} member`);
    }

    // Last event from contacts table
    if (lastEvent && events.length === 0) {
      knownFacts.push(`you attended ${lastEvent}`);
    }

    // Goal
    const goal = profile?.accomplish_next_6_to_12_months;
    if (goal && Array.isArray(goal) && goal.length > 0) {
      knownFacts.push(`your goal has been to ${goal[0]}`);
    }

    // Recent events
    if (events && events.length > 0) {
      const eventNames = events.map(e => e.event_name).filter(Boolean).slice(0, 2);
      if (eventNames.length > 0) {
        knownFacts.push(`you attended ${eventNames.join(' and ')}`);
      }
    }

    // Last voice agent call context
    if (lastSurvey?.answers) {
      try {
        const answers = typeof lastSurvey.answers === 'string'
          ? JSON.parse(lastSurvey.answers)
          : lastSurvey.answers;
        if (answers.blocker) {
          knownFacts.push(`last time you mentioned ${answers.blocker} was your main blocker`);
        }
      } catch(e) {}
    }

    // Board member acknowledgment
    if (isBoard) {
      knownFacts.push(`you are one of our board members`);
    }

    // Build the recognition sentence
    if (knownFacts.length > 0) {
      const factsStr = knownFacts.slice(0, 3).join(', and ');
      parts.push(`I can see ${factsStr}.`);
    }

    parts.push(`What can I help you with today?`);

    const result = parts.join(' ');

    console.log(`Member found: ${memberName} | status: ${status} | stage: ${stage}`);

    return res.status(200).json({
      found: true,
      member_name: memberName,
      membership_status: status,
      stage: profile?.investing_journey_stage || null,
      strategies: strategyList || null,
      is_board: isBoard || false,
      result
    });

  } catch(e) {
    console.error('Member lookup error:', e.message);
    return res.status(200).json({ found: false, result: 'not_found' });
  }
}