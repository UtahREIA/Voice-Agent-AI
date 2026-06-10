/**
 * caller-history.js — Utah REIA Caller History Lookup
 *
 * Called by Vapi tool: getCallerHistory
 *
 * Queries Supabase to build a complete history profile for a caller
 * including past voice agent calls, education/resource requests,
 * investor profile, tool access, and event attendance.
 *
 * This allows the voice agent to reference past conversations and
 * avoid repeating recommendations already made. It also lets the
 * agent acknowledge progress and build on previous interactions.
 *
 * Request body (from Vapi tool call):
 *   phone      {string} — caller phone number (digits only)
 *   contact_id {string} — Supabase contact ID (optional, faster lookup)
 *
 * Response:
 *   result     {string} — voice-ready history summary for Claude
 *   has_history {boolean} — whether any past interactions were found
 *   profile    {object} — structured data for Claude to reference
 */

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ result: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ result: 'History lookup unavailable.', has_history: false });
  }

  // Extract args from all possible Vapi request formats
  function extractArgs(body) {
    if (body && (body.phone !== undefined || body.contact_id !== undefined)) return body;
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (args) return typeof args === 'string' ? JSON.parse(args) : args;
    } catch(e) {}
    return body || {};
  }

  const args = extractArgs(req.body);
  const rawPhone = args.phone || '';
  const passedContactId = args.contact_id || '';
  const last10 = rawPhone.replace(/\D/g, '').slice(-10);

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  try {
    // --- STEP 1: Resolve contact ID ---
    let contactId = passedContactId;
    let contactName = '';
    let contactPhone = '';

    if (!contactId && last10) {
      // Look up by formatted phone — try (XXX) XXX-XXXX format first
      const area = last10.slice(0,3);
      const mid = last10.slice(3,6);
      const end = last10.slice(6);
      const formatted = '(' + area + ') ' + mid + '-' + end;

      const contactResp = await fetch(
        SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone&phone=eq.' + encodeURIComponent(formatted) + '&limit=1',
        { headers }
      );
      const contacts = await contactResp.json();

      if (Array.isArray(contacts) && contacts.length > 0) {
        contactId = contacts[0].id;
        contactName = contacts[0].full_name || '';
        contactPhone = contacts[0].phone || '';
      }

      // Fallback: try +1 E.164 format
      if (!contactId) {
        const e164Resp = await fetch(
          SUPABASE_URL + '/rest/v1/contacts?select=id,full_name,phone&phone=eq.' + encodeURIComponent('+1' + last10) + '&limit=1',
          { headers }
        );
        const e164Contacts = await e164Resp.json();
        if (Array.isArray(e164Contacts) && e164Contacts.length > 0) {
          contactId = e164Contacts[0].id;
          contactName = e164Contacts[0].full_name || '';
        }
      }
    }

    if (!contactId) {
      return res.status(200).json({
        result: 'No history found for this caller.',
        has_history: false
      });
    }

    const firstName = contactName.split(' ')[0] || 'this caller';

    // --- STEP 2: Fetch all history in parallel ---
    const [
      profileData,
      surveyData,
      toolData,
      eventData
    ] = await Promise.all([

      // Investor profile — stage, strategies, goals
      fetch(
        SUPABASE_URL + '/rest/v1/investor_profiles?contact_id=eq.' + contactId +
        '&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months,what_best_describes_you_now,wants_mentor_connection&limit=1',
        { headers }
      ).then(r => r.json()).catch(() => []),

      // Past voice agent calls from voice_agent_calls table
      // This is the dedicated table for voice agent history
      fetch(
        SUPABASE_URL + '/rest/v1/voice_agent_calls?contact_id=eq.' + contactId +
        '&select=summary,blocker,goals,strategies,educator_match,vendor_matches,tool_matches,booking_url,recommended_next,stack_summary,created_at&order=created_at.desc&limit=5',
        { headers }
      ).then(r => r.json()).catch(() => []),

      // Tool access — which calculators they have used
      fetch(
        SUPABASE_URL + '/rest/v1/tool_access?contact_id=eq.' + contactId +
        '&select=tool_name,accessed_at&order=accessed_at.desc&limit=10',
        { headers }
      ).then(r => r.json()).catch(() => []),

      // Event attendance — last 3 events
      fetch(
        SUPABASE_URL + '/rest/v1/event_attendance?contact_id=eq.' + contactId +
        '&select=event_name,attended_at&order=attended_at.desc&limit=3',
        { headers }
      ).then(r => r.json()).catch(() => [])
    ]);

    const profile = Array.isArray(profileData) ? profileData[0] : null;
    const surveys = Array.isArray(surveyData) ? surveyData : [];
    const tools = Array.isArray(toolData) ? toolData : [];
    const events = Array.isArray(eventData) ? eventData : [];

    // --- STEP 3: Parse past voice agent call data ---
    // voice_agent_calls has flat columns — no JSON parsing needed
    const pastCalls = surveys.map(s => {
      try {
        return {
          date: s.created_at ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
          strategies: Array.isArray(s.strategies) ? s.strategies.join(', ') : (s.strategies || ''),
          blocker: s.blocker || '',
          goals: s.goals || '',
          summary: s.summary || '',
          recommendedNext: s.recommended_next || '',
          educatorMatch: s.educator_match || '',
          vendorMatches: s.vendor_matches || '',
          bookingUrl: s.booking_url || '',
          stackSummary: s.stack_summary || ''
        };
      } catch(e) {
        return null;
      }
    }).filter(Boolean);

    const hasHistory = pastCalls.length > 0 || tools.length > 0 || events.length > 0;

    if (!hasHistory && !profile) {
      return res.status(200).json({
        result: firstName + ' has no prior interaction history in our system.',
        has_history: false
      });
    }

    // --- STEP 4: Build voice-ready history summary ---
    const parts = [];

    // Investor profile summary
    if (profile) {
      const stage = profile.investing_journey_stage || '';
      const strategies = Array.isArray(profile.investing_interests)
        ? profile.investing_interests.slice(0, 3).join(', ')
        : (profile.investing_interests || '');
      const goal = Array.isArray(profile.accomplish_next_6_to_12_months)
        ? profile.accomplish_next_6_to_12_months[0]
        : (profile.accomplish_next_6_to_12_months || '');
      const wantsMentor = profile.wants_mentor_connection;

      if (stage) parts.push('Stage: ' + stage);
      if (strategies) parts.push('Strategies: ' + strategies);
      if (goal) parts.push('Goal: ' + goal);
      if (wantsMentor) parts.push('Has expressed interest in a mentor connection');
    }

    // Past voice agent calls
    if (pastCalls.length > 0) {
      const lastCall = pastCalls[0];
      parts.push('Last voice agent call (' + (lastCall.date || 'recent') + '): ' +
        (lastCall.summary || 'Discussed ' + (lastCall.strategies || lastCall.stage || 'investing topics')));

      if (lastCall.blocker) parts.push('Previous blocker: ' + lastCall.blocker);
      if (lastCall.recommendedNext) parts.push('Previously recommended: ' + lastCall.recommendedNext);

      if (pastCalls.length > 1) {
        parts.push('Total past voice agent calls: ' + pastCalls.length);
      }
    }

    // Tools accessed
    if (tools.length > 0) {
      const toolNames = tools.map(t => t.tool_name).filter(Boolean).slice(0, 3);
      if (toolNames.length > 0) {
        parts.push('Tools already accessed: ' + toolNames.join(', '));
      }
    }

    // Events attended
    if (events.length > 0) {
      const eventNames = events.map(e => e.event_name).filter(Boolean).slice(0, 2);
      if (eventNames.length > 0) {
        parts.push('Recent events attended: ' + eventNames.join(', '));
      }
    }

    const historyBlock = parts.join(' | ');

    // Build the instruction for Claude
    const result = 'CALLER HISTORY for ' + firstName + ': ' + historyBlock +
      '. Use this to avoid repeating past recommendations, acknowledge their progress, ' +
      'and build on what they already know. Reference their previous interactions naturally ' +
      'without reading the data back verbatim.';

    console.log('Caller history loaded for:', contactName, '| past calls:', pastCalls.length, '| tools:', tools.length);

    return res.status(200).json({
      result,
      has_history: hasHistory,
      past_calls: pastCalls.length,
      profile: {
        stage: profile?.investing_journey_stage || '',
        strategies: profile?.investing_interests || [],
        tools_used: tools.map(t => t.tool_name).filter(Boolean)
      }
    });

  } catch(e) {
    console.error('Caller history error:', e.message);
    return res.status(200).json({
      result: 'History lookup failed. Proceed normally.',
      has_history: false
    });
  }
}