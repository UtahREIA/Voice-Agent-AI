export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  // Allow requests from utahreia.org and Vercel test URL
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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

    // Extract insights from past voice agent calls
    let lastBlocker = '';
    let lastRecommendation = '';
    let pastCallCount = 0;
    let lastCallDate = '';

    if (Array.isArray(surveys) && surveys.length > 0) {
      pastCallCount = surveys.length;
      try {
        const ans = typeof surveys[0].answers === 'string'
          ? JSON.parse(surveys[0].answers)
          : surveys[0].answers;
        lastBlocker = ans?.blocker || '';
        lastRecommendation = ans?.recommendedNextStep || '';
        lastCallDate = surveys[0].created_at
          ? new Date(surveys[0].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
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

    // Reference past calls if they exist
    if (pastCallCount > 0 && lastCallDate) {
      if (lastBlocker) {
        greeting += ' Last time you called on ' + lastCallDate + ' you were working through ' + lastBlocker + '.';
      } else if (lastRecommendation) {
        greeting += ' Last time you called we recommended ' + lastRecommendation.slice(0, 80) + '.';
      }
      greeting += ' How has that been going?';
    } else {
      greeting += ' What can I help you with today?';
    }

    // --- FETCH PAST VOICE AGENT CALL HISTORY ---
    let lastCallData = null;
    // Pull last 3 voice agent surveys for this contact to surface
    // what was discussed, recommended, and what they have already tried
    let historyBlock = '';
    try {
      // Read from voice_agent_calls — dedicated table for voice agent history
      const surveyResp = await fetch(
        SUPABASE_URL + '/rest/v1/voice_agent_calls?contact_id=eq.' + match.id +
        '&select=summary,blocker,recommended_next,educator_match,vendor_matches,stack_summary,created_at&order=created_at.desc&limit=5',
        { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      const surveys = await surveyResp.json();

      if (Array.isArray(surveys) && surveys.length > 0) {
        // Find the most recent call with a meaningful recommendation
        // Skip calls with no real recommendations
        const badPhrases = [
          'no recommendations', 'intake was in progress', 'ended before',
          'returning to utah', 'call ended', 'not delivered', 'unable to',
          'no result', 'did not complete', 'incomplete'
        ];

        const meaningfulCall = surveys.find(s => {
          const summary = (s.stack_summary || '').toLowerCase();
          const hasBadPhrase = badPhrases.some(p => summary.includes(p));
          if (hasBadPhrase) return false;

          const hasGoodSummary = s.stack_summary && s.stack_summary.length > 30;
          const hasEducator = s.educator_match && s.educator_match.length > 2;
          const hasVendor = Array.isArray(s.vendor_matches) && s.vendor_matches.length > 0;

          return hasGoodSummary || hasEducator || hasVendor;
        }) || null;

        if (meaningfulCall) {
          lastCallData = {
            stack_summary: meaningfulCall.stack_summary || '',
            recommended_next: meaningfulCall.recommended_next || '',
            educator_match: meaningfulCall.educator_match || '',
            vendor_matches: Array.isArray(meaningfulCall.vendor_matches)
              ? meaningfulCall.vendor_matches.join(', ')
              : (meaningfulCall.vendor_matches || ''),
            blocker: meaningfulCall.blocker || '',
            date: meaningfulCall.created_at
              ? new Date(meaningfulCall.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : ''
          };
        }

        const historyParts = surveys.map(s => {
          try {
            const date = s.created_at ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            return [
              date ? 'Call on ' + date : 'Previous call',
              s.summary ? 'Summary: ' + s.summary.slice(0, 100) : '',
              s.blocker ? 'Blocker was: ' + s.blocker : '',
              s.stack_summary ? 'Recommended: ' + s.stack_summary.slice(0, 120) : ''
            ].filter(Boolean).join('. ');
          } catch(e) { return null; }
        }).filter(Boolean);

        if (historyParts.length > 0) {
          historyBlock = ' PAST CALL HISTORY (' + historyParts.length + ' previous call' +
            (historyParts.length > 1 ? 's' : '') + '): ' + historyParts.join(' || ');
        }
      }
    } catch(e) {
      console.error('History fetch error:', e.message);
    }

    // Append history to greeting so Claude can reference it immediately
    const fullResult = greeting + (historyBlock ? ' ' + historyBlock : '');

    return res.status(200).json({
      result: fullResult,
      member_name: firstName,
      last_call: lastCallData   // exposed so index.html can build personalized firstMessage
    });

  } catch (e) {
    return res.status(200).json({
      result: 'Exception: ' + e.message + '. phone=' + last10
    });
  }
}