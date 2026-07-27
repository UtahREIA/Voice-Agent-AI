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

  // A call only counts as having DELIVERED a recommendation when one of the
  // real recommendation fields is populated with an ACTUAL recommendation.
  // Two traps this guards against, both seen live in the David Tester bug:
  //  1. stack_summary does NOT count — ghl-sync writes it as `stackSummary ||
  //     summary`, so a call cut off mid-intake still has a long stack_summary
  //     (usually the plain call summary, often starting with the caller's name).
  //  2. recommended_next is populated even on cut-off calls with a sentence
  //     SAYING no recommendation was made ("The AI did not reach the point of
  //     delivering a specific next step ... before the caller ended the call").
  //     Those sentinel sentences must be treated as empty.
  function looksIncomplete(text) {
    const t = (text || '').toLowerCase();
    if (!t) return false;
    return [
      'did not reach', 'did not deliver', 'did not provide', 'did not complete',
      'did not get to', 'was not able to', 'were not able to', 'unable to',
      'no recommendation', 'no specific next step', 'no next step', 'not deliver',
      'before the caller ended', 'ended the call', 'call ended', 'ended before',
      'intake was in progress', 'incomplete', 'no result'
    ].some(p => t.includes(p));
  }
  function recText(s) {
    if (!s) return '';
    const ven = Array.isArray(s.vendor_matches)
      ? s.vendor_matches.filter(Boolean).join(', ')
      : (s.vendor_matches || '');
    const rec = (s.recommended_next || '').trim();
    const cleanRec = looksIncomplete(rec) ? '' : rec;
    return (cleanRec || (s.educator_match || '').trim() || ven || '').trim();
  }
  // rows are most-recent-first. Prefer the most recent call that actually
  // delivered a recommendation; otherwise fall back to the most recent call so
  // the caller (a returning caller) is still recognized, with has_recommendation
  // false so the greeting acknowledges an unfinished call instead of inventing one.
  function pickLastCall(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const withRec = rows.find(s => recText(s).length > 2);
    const src = withRec || rows[0];
    const ven = Array.isArray(src.vendor_matches)
      ? src.vendor_matches.filter(Boolean).join(', ')
      : (src.vendor_matches || '');
    return {
      has_recommendation: !!withRec,
      // recommendation is the cleaned, ready-to-speak text (sentinel "did not
      // reach ..." strings already stripped). index.html should speak THIS, not
      // the raw recommended_next.
      recommendation: withRec ? recText(src) : '',
      recommended_next: src.recommended_next || '',
      educator_match: src.educator_match || '',
      vendor_matches: ven,
      stack_summary: src.stack_summary || '',
      blocker: src.blocker || '',
      date: src.created_at
        ? new Date(src.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : ''
    };
  }

  function computePriorProfileType(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const types = rows.map(r => (r.profile_type || '').toLowerCase()).filter(Boolean);
    if (!types.length) return '';
    const hasVendor   = types.some(t => t === 'vendor'   || t.includes('vendor')   || t === 'both');
    const hasInvestor = types.some(t => t === 'investor'  || t.includes('investor') || t === 'both');
    if (hasVendor && hasInvestor) return 'both';
    if (hasVendor)   return 'vendor';
    if (hasInvestor) return 'investor';
    return types[0];
  }

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

    // Fallback: try with +1 prefix (E.164)
    if (!Array.isArray(matches) || matches.length === 0) {
      const resp3 = await fetch(
        SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=eq.' + encodeURIComponent('+1' + last10) + '&limit=1',
        { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      matches = await resp3.json();
    }

    // Fallback: try "+1 (XXX) XXX-XXXX" format — how GHL often stores numbers
    if (!Array.isArray(matches) || matches.length === 0) {
      const ghlFormatted = '+1 ' + formatted;
      const resp4 = await fetch(
        SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=eq.' + encodeURIComponent(ghlFormatted) + '&limit=1',
        { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      matches = await resp4.json();
    }

    // Final fallback: fetch all and match by last 10 digits
    if (!Array.isArray(matches) || matches.length === 0) {
      const respAll = await fetch(
        SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&limit=5000',
        { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      const allContacts = await respAll.json();
      if (Array.isArray(allContacts)) {
        const found = allContacts.find(c => c.phone && c.phone.replace(/\D/g,'').slice(-10) === last10);
        if (found) matches = [found];
      }
    }

    // --- FALLBACK: search voice_agent_calls directly by caller_phone ---
    // This handles callers who have called before but are not yet in the contacts table
    if (!Array.isArray(matches) || matches.length === 0) {
      try {
        const vacHeaders = {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        };

        // Try multiple phone formats stored in caller_phone column
        // Format 1: +1XXXXXXXXXX (E.164)
        // Format 2: plain last 10 digits
        const vacUrl1 = SUPABASE_URL + '/rest/v1/voice_agent_calls?caller_phone=eq.%2B1' + last10 +
          '&select=caller_name,caller_phone,stack_summary,recommended_next,educator_match,vendor_matches,blocker,profile_type,created_at&order=created_at.desc&limit=3';
        const vacUrl2 = SUPABASE_URL + '/rest/v1/voice_agent_calls?caller_phone=like.*' + last10 +
          '&select=caller_name,caller_phone,stack_summary,recommended_next,educator_match,vendor_matches,blocker,profile_type,created_at&order=created_at.desc&limit=3';

        let vacRows = [];
        const vacResp1 = await fetch(vacUrl1, { headers: vacHeaders });
        const vacData1 = await vacResp1.json();
        if (Array.isArray(vacData1) && vacData1.length > 0) {
          vacRows = vacData1;
        } else {
          const vacResp2 = await fetch(vacUrl2, { headers: vacHeaders });
          const vacData2 = await vacResp2.json();
          if (Array.isArray(vacData2)) vacRows = vacData2;
        }
        const vacResp = { json: () => vacRows };
        // vacRows already populated above

        if (Array.isArray(vacRows) && vacRows.length > 0) {
          const lastCall = vacRows[0];
          const callerName = lastCall.caller_name || '';
          const firstName = callerName.split(' ')[0] || '';

          const lastCallData = pickLastCall(vacRows);

          const greeting = callerName
            ? 'RETURNING CALLER (not yet in contacts): ' + callerName + ' | phone: ' + last10 + ' | past calls: ' + vacRows.length
            : 'RETURNING CALLER (unnamed): phone: ' + last10 + ' | past calls: ' + vacRows.length;

          const historyBlock = lastCallData && lastCallData.has_recommendation
            ? ' LAST CALL RECOMMENDATION: ' + recText(lastCallData).slice(0, 150)
            : ' NOTE: the last call did not finish and no recommendation was made. Do not reference a past recommendation.';

          return res.status(200).json({
            result: 'RETURNING MEMBER PROFILE\n' + greeting + historyBlock,
            member_name: firstName,
            last_call: lastCallData,
            prior_profile_type: computePriorProfileType(vacRows)
          });
        }
      } catch(e) {
        console.error('voice_agent_calls fallback error:', e.message);
      }

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

    // Reference past calls only if we have something concrete to reference.
    // Do not claim a past recommendation from pastCallCount alone — an
    // unfinished call has a count but nothing was recommended.
    if (pastCallCount > 0 && lastBlocker) {
      greeting += ' Last time you called on ' + (lastCallDate || 'your last call') + ' you were working through ' + lastBlocker + '. How has that been going?';
    } else if (pastCallCount > 0 && lastRecommendation) {
      greeting += ' Last time you called we recommended ' + lastRecommendation.slice(0, 80) + '. How has that been going?';
    } else {
      greeting += ' What can I help you with today?';
    }

    // --- FETCH PAST VOICE AGENT CALL HISTORY ---
    let lastCallData = null;
    let priorProfileType = '';
    // Pull last 3 voice agent surveys for this contact to surface
    // what was discussed, recommended, and what they have already tried
    let historyBlock = '';
    try {
      // Read from voice_agent_calls — try contact_id first, fall back to caller_phone
      // Many records have null contact_id due to earlier bug — phone fallback catches those
      const histHeaders = { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };
      let surveys = [];

      const surveyResp = await fetch(
        SUPABASE_URL + '/rest/v1/voice_agent_calls?contact_id=eq.' + match.id +
        '&select=summary,blocker,recommended_next,educator_match,vendor_matches,stack_summary,profile_type,created_at&order=created_at.desc&limit=5',
        { headers: histHeaders }
      );
      const surveyData = await surveyResp.json();
      if (Array.isArray(surveyData) && surveyData.length > 0) {
        surveys = surveyData;
      } else {
        // Fallback — search by caller_phone for records with null contact_id
        const phoneE164 = encodeURIComponent('+1' + last10);
        const surveyResp2 = await fetch(
          SUPABASE_URL + '/rest/v1/voice_agent_calls?caller_phone=eq.' + phoneE164 +
          '&select=summary,blocker,recommended_next,educator_match,vendor_matches,stack_summary,profile_type,created_at&order=created_at.desc&limit=5',
          { headers: histHeaders }
        );
        const surveyData2 = await surveyResp2.json();
        if (Array.isArray(surveyData2)) {
          surveys = surveyData2;
          console.log('member-lookup: history found by caller_phone fallback:', last10, '— rows:', surveys.length);
        }
      }

      if (Array.isArray(surveys) && surveys.length > 0) {
        priorProfileType = computePriorProfileType(surveys);
        // last_call feeds the spoken firstMessage in index.html. Base it on the
        // real recommendation fields (recommended_next / educator / vendor), not
        // stack_summary — see pickLastCall. has_recommendation false means the
        // caller is recognized but no recommendation was ever delivered.
        lastCallData = pickLastCall(surveys);

        const historyParts = surveys.map(s => {
          try {
            const date = s.created_at ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            const rec = recText(s);
            return [
              date ? 'Call on ' + date : 'Previous call',
              s.summary ? 'Summary: ' + s.summary.slice(0, 100) : '',
              s.blocker ? 'Blocker was: ' + s.blocker : '',
              rec ? 'Recommended: ' + rec.slice(0, 120) : 'No recommendation was delivered on this call.'
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
      last_call: lastCallData,
      prior_profile_type: priorProfileType
    });

  } catch (e) {
    return res.status(200).json({
      result: 'Exception: ' + e.message + '. phone=' + last10
    });
  }
}