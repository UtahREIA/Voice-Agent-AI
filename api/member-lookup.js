// Vercel route config — explicitly enable the body parser because Vapi sends
// JSON and the function below relies on `req.body` being a parsed object.
export const config = { api: { bodyParser: true } };

/**
 * Vapi tool endpoint: looks up an existing Utah REIA member by phone number
 * and returns a pre-built spoken greeting the agent can read verbatim.
 *
 * Unlike ghl-sync.js's conversation-update handler (which scans the transcript
 * and injects a system message), this endpoint is wired as a regular Vapi tool
 * call. Because Vapi has multiple request shapes depending on how the tool is
 * defined, we accept the phone from any of four payload formats:
 *   1) `body.phone`                                       (direct)
 *   2) `body.message.toolCallList[0].function.arguments`  (Vapi current)
 *   3) `body.message.toolCalls[0].function.arguments`     (Vapi legacy)
 *   4) `body.toolCallList[0].function.arguments`          (top-level variant)
 * Arguments may arrive as a JSON string or an already-parsed object.
 *
 * Phone matching strategy — Supabase's `phone` column has inconsistent
 * formatting across imports, so we try three exact-match variants in order:
 *   a) "(801) 555-1234"  (US-formatted, most common in this database)
 *   b) "8015551234"      (10-digit raw)
 *   c) "+18015551234"    (E.164)
 * This avoids a full-table scan over 4,929 contacts.
 *
 * On hit, fetches investor_profile, recent event_attendance, and the most
 * recent voice_agent readiness_survey, then assembles a personalized greeting
 * built from up to 3 known facts about the caller. On miss, returns a
 * diagnostic string so Vapi can fall back to the normal qualifying flow.
 *
 * Always returns 200 (even on internal errors, returned in `result`) so a
 * failing lookup never breaks the call.
 *
 * @param {import('http').IncomingMessage & { body: any, method: string }} req - Vapi tool POST
 * @param {import('http').ServerResponse & { status: Function, json: Function }} res
 * @returns {Promise<void>} 200 `{ result: <greeting>, member_name?: <firstName> }`
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const body = req.body || {};

  // Extract phone from all possible Vapi request formats
  let phone = null;

  // Format 1: direct body.phone (our expected format)
  if (body.phone) {
    phone = String(body.phone);
  }

  // Format 2: Vapi toolCallList with arguments as JSON string
  if (!phone) {
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments;
      if (args) {
        const parsed = typeof args === 'string' ? JSON.parse(args) : args;
        if (parsed?.phone) phone = String(parsed.phone);
      }
    } catch(e) {}
  }

  // Format 3: Vapi toolCalls array
  if (!phone) {
    try {
      const args = body?.message?.toolCalls?.[0]?.function?.arguments;
      if (args) {
        const parsed = typeof args === 'string' ? JSON.parse(args) : args;
        if (parsed?.phone) phone = String(parsed.phone);
      }
    } catch(e) {}
  }

  // Format 4: top-level toolCallList
  if (!phone) {
    try {
      const args = body?.toolCallList?.[0]?.function?.arguments;
      if (args) {
        const parsed = typeof args === 'string' ? JSON.parse(args) : args;
        if (parsed?.phone) phone = String(parsed.phone);
      }
    } catch(e) {}
  }

  const last10 = phone ? phone.replace(/\D/g, '').slice(-10) : null;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({
      result: 'Member profile lookup unavailable. phone_received=' + (phone || 'null')
    });
  }

  if (!phone || !last10) {
    return res.status(200).json({
      result: 'No phone received. body_keys=' + Object.keys(body).join(',')
    });
  }

  try {
    // Use Supabase RPC to search by phone digits directly
    // This avoids fetching all 4929 contacts and handles any format
    const area = last10.slice(0, 3);
    const mid = last10.slice(3, 6);
    const end = last10.slice(6);
    const formatted = '(' + area + ') ' + mid + '-' + end;

    // Try formatted phone match first (most common format in Supabase)
    const resp = await fetch(
      SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=eq.' + encodeURIComponent(formatted) + '&limit=1',
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        }
      }
    );

    let matches = await resp.json();

    // Fallback: try exact digits match
    if (!Array.isArray(matches) || matches.length === 0) {
      const resp2 = await fetch(
        SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=eq.' + encodeURIComponent(last10) + '&limit=1',
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY
          }
        }
      );
      matches = await resp2.json();
    }

    // Fallback: try with +1 prefix
    if (!Array.isArray(matches) || matches.length === 0) {
      const resp3 = await fetch(
        SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=eq.' + encodeURIComponent('+1' + last10) + '&limit=1',
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY
          }
        }
      );
      matches = await resp3.json();
    }

    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(200).json({
        result: 'not_found. searched=' + formatted + ' and ' + last10
      });
    }

    const match = matches[0];

    if (!match) {
      return res.status(200).json({
        result: 'not_found. phone=' + last10 + ' total=' + all.length + ' samples=' + all.slice(0,3).map(c => c.phone.replace(/\D/g,'').slice(-10)).join('|')
      });
    }

    // Fetch investor profile
    const profileResp = await fetch(
      SUPABASE_URL + '/rest/v1/investor_profiles?contact_id=eq.' + match.id + '&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months&limit=1',
      { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    const profiles = await profileResp.json();
    const profile = Array.isArray(profiles) ? profiles[0] : null;

    // Fetch event attendance
    const eventResp = await fetch(
      SUPABASE_URL + '/rest/v1/event_attendance?contact_id=eq.' + match.id + '&select=event_name&order=attended_at.desc&limit=3',
      { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    const events = await eventResp.json();

    // Fetch last voice survey
    const surveyResp = await fetch(
      SUPABASE_URL + '/rest/v1/readiness_surveys?contact_id=eq.' + match.id + '&source=eq.voice_agent&select=answers&order=created_at.desc&limit=1',
      { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    const surveys = await surveyResp.json();

    const firstName = match.full_name?.split(' ')[0] || 'there';
    const status = match.membership_status || '';
    const memberType = match.membership_type || '';
    const isBoard = match.is_board_member || false;
    const lastEvent = match.last_reia_event || '';
    const stage = profile?.investing_journey_stage || '';
    const strategies = profile?.investing_interests || [];
    const eventNames = Array.isArray(events) ? events.map(e => e.event_name).filter(Boolean) : [];

    let lastBlocker = '';
    if (Array.isArray(surveys) && surveys[0]?.answers) {
      try {
        const ans = typeof surveys[0].answers === 'string' ? JSON.parse(surveys[0].answers) : surveys[0].answers;
        lastBlocker = ans?.blocker || '';
      } catch(e) {}
    }

    let greeting = status === 'Active'
      ? 'Welcome back ' + firstName + ', great to hear from you again.'
      : 'Hey ' + firstName + ', good to connect with you.';

    const facts = [];
    if (stage) facts.push('you are at the ' + stage + ' stage');
    if (Array.isArray(strategies) && strategies.length > 0) facts.push('you have been focused on ' + strategies.slice(0,2).join(' and '));
    if (memberType) facts.push('you are a ' + memberType + ' member');
    if (eventNames.length > 0) facts.push('you attended ' + eventNames.slice(0,2).join(' and '));
    else if (lastEvent) facts.push('you attended ' + lastEvent);
    if (isBoard) facts.push('you are one of our board members');
    if (lastBlocker) facts.push('last time your main challenge was ' + lastBlocker);

    if (facts.length > 0) {
      greeting += ' I can see ' + facts.slice(0, 3).join(', and ') + '.';
    }

    greeting += ' What can I help you with today?';

    return res.status(200).json({ result: greeting, member_name: firstName });

  } catch (e) {
    return res.status(200).json({
      result: 'Exception: ' + e.message + '. phone=' + last10
    });
  }
}