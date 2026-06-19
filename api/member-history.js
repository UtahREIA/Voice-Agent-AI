/**
 * member-history.js — Utah REIA Member History Lookup
 *
 * Called by the Vapi tool getMemberHistory during a live call.
 * Returns a comprehensive history of the member's past interactions,
 * education requests, vendor connections, and investor profile so the
 * voice agent can reference them and improve recommendations.
 *
 * Data sources queried:
 *   - contacts                — base profile, membership, stage
 *   - investor_profiles       — strategies, goals, resources
 *   - readiness_surveys       — all past voice agent calls and what was recommended
 *   - event_attendance        — which Utah REIA events they attended
 *   - tool_access             — which calculators they have used
 *
 * Request body (from Vapi tool arguments):
 *   phone    {string} — caller phone number (digits only)
 *   contact_id {string} — optional Supabase contact ID if already known
 *
 * Response:
 *   result   {string} — voice-ready summary Claude can speak from directly
 */

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  // CORS headers — required since this endpoint is called from utahreia.org
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ result: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json(vapiResult('Member history unavailable — Supabase not configured.'));
  }

  // Extract arguments from all Vapi request formats
  function extractArgs(body) {
    if (body && (body.phone !== undefined || body.contact_id !== undefined)) return body;
    try {

  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id
    || req.body?.message?.toolCalls?.[0]?.id
    || req.body?.toolCallList?.[0]?.id
    || null;

  function vapiResult(resultOrObj) {
    const resultStr = typeof resultOrObj === 'object' && resultOrObj !== null
      ? (resultOrObj.result || JSON.stringify(resultOrObj))
      : String(resultOrObj);
    if (toolCallId) return { results: [{ toolCallId, result: resultStr }] };
    return { result: resultStr };
  }
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

  if (!last10 && !passedContactId) {
    return res.status(200).json(vapiResult('No phone or contact ID provided — cannot retrieve history.'));
  }

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  try {
    // --- STEP 1: Find the contact ---
    let contact = null;
    let contactId = passedContactId;

    if (!contactId && last10) {
      // Build formatted phone variants to try
      const area = last10.slice(0,3);
      const mid = last10.slice(3,6);
      const end = last10.slice(6);
      const formatted = '(' + area + ') ' + mid + '-' + end;
      const e164 = '+1' + last10;

      // Try formatted, E.164, and raw digits
      for (const phone of [formatted, e164, last10]) {
        const resp = await fetch(
          `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event,ghl_contact_id&phone=eq.${encodeURIComponent(phone)}&limit=1`,
          { headers }
        );
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          contact = data[0];
          contactId = contact.id;
          break;
        }
      }
    } else if (contactId) {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&id=eq.${contactId}&limit=1`,
        { headers }
      );
      const data = await resp.json();
      contact = Array.isArray(data) && data.length > 0 ? data[0] : null;
    }

    if (!contact || !contactId) {
      return res.status(200).json(vapiResult('No member record found for this caller. Treat this as a new caller and run the full intake.'));
    }

    // --- STEP 2: Fetch all data sources in parallel ---
    const [profileData, surveysData, eventsData, toolData] = await Promise.all([

      // Investor profile — stage, strategies, goals, resources
      fetch(
        `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months,what_best_describes_you_now,wants_mentor_connection,other_resources&limit=1`,
        { headers }
      ).then(r => r.json()).catch(() => []),

      // Past voice agent call surveys — what was asked, recommended, and attempted
      fetch(
        `${SUPABASE_URL}/rest/v1/readiness_surveys?contact_id=eq.${contactId}&source=eq.voice_agent&select=answers,created_at&order=created_at.desc&limit=5`,
        { headers }
      ).then(r => r.json()).catch(() => []),

      // Event attendance — which events they attended
      fetch(
        `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${contactId}&select=event_name,event_date&order=event_date.desc&limit=5`,
        { headers }
      ).then(r => r.json()).catch(() => []),

      // Tool access — which calculators they have used
      fetch(
        `${SUPABASE_URL}/rest/v1/tool_access?contact_id=eq.${contactId}&select=fix_flip_calculator_access,brrrr_calculator_access,wholesale_calculator_access,rentals_calculator_access,short_term_calculator_access,rehab_estimator_access&order=last_accessed.desc&limit=5`,
        { headers }
      ).then(r => r.json()).catch(() => [])
    ]);

    // --- STEP 3: Extract and structure the data ---
    const profile = Array.isArray(profileData) && profileData.length > 0 ? profileData[0] : null;
    const surveys = Array.isArray(surveysData) ? surveysData : [];
    const events = Array.isArray(eventsData) ? eventsData : [];
    const tools = Array.isArray(toolData) ? toolData : [];

    const firstName = contact.full_name?.split(' ')[0] || 'this member';
    const memberStatus = contact.membership_status || 'unknown';
    const memberType = contact.membership_type || '';
    const isBoard = contact.is_board_member;

    // Build past calls summary from readiness surveys
    const pastCalls = surveys.map(s => {
      try {
        const ans = typeof s.answers === 'string' ? JSON.parse(s.answers) : s.answers;
        const date = s.created_at ? new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown date';
        return {
          date,
          stage: ans.investorStage || ans.stage || '',
          strategies: ans.strategies || [],
          blocker: ans.blocker || '',
          goals: ans.goals || '',
          summary: ans.summary || '',
          recommendedNextStep: ans.recommendedNextStep || '',
          alreadyTried: ans.alreadyTried || ''
        };
      } catch(e) {
        return null;
      }
    }).filter(Boolean);

    // Build event names list
    const eventNames = events.map(e => e.event_name).filter(Boolean);

    // Build tool names list
    const toolNames = tools.map(t => Object.keys(t).find(k => k.includes('_access') && t[k])).filter(Boolean);

    // Build investor profile summary
    const stage = profile?.investing_journey_stage || '';
    const strategies = Array.isArray(profile?.investing_interests)
      ? profile.investing_interests
      : (profile?.investing_interests ? [profile.investing_interests] : []);
    const goals = Array.isArray(profile?.accomplish_next_6_to_12_months)
      ? profile.accomplish_next_6_to_12_months[0]
      : profile?.accomplish_next_6_to_12_months || '';
    const wantsMentor = profile?.wants_mentor_connection;

    // --- STEP 4: Build voice-ready result ---
    const parts = [];

    // Member identity
    parts.push(`MEMBER HISTORY FOR ${contact.full_name.toUpperCase()}`);
    parts.push(`Status: ${memberStatus}${memberType ? ' — ' + memberType : ''}${isBoard ? ' (Board Member)' : ''}`);

    // Investor profile
    if (stage) parts.push(`Current Stage: ${stage}`);
    if (strategies.length > 0) parts.push(`Strategies: ${strategies.join(', ')}`);
    if (goals) parts.push(`Goal: ${goals}`);
    if (wantsMentor) parts.push(`Interested in mentorship: Yes`);

    // Past voice agent calls
    if (pastCalls.length > 0) {
      parts.push(`\nPAST CALLS (${pastCalls.length} total):`);
      pastCalls.slice(0, 3).forEach(call => {
        const callParts = [`Call on ${call.date}`];
        if (call.stage) callParts.push(`stage: ${call.stage}`);
        if (call.blocker) callParts.push(`blocker: ${call.blocker}`);
        if (call.recommendedNextStep) callParts.push(`recommended: ${call.recommendedNextStep.slice(0, 100)}`);
        if (call.alreadyTried) callParts.push(`had tried: ${call.alreadyTried.slice(0, 80)}`);
        parts.push('  ' + callParts.join(' | '));
      });
    } else {
      parts.push('\nNo previous voice agent calls on record.');
    }

    // Events attended
    if (eventNames.length > 0) {
      parts.push(`\nEvents Attended: ${eventNames.slice(0, 3).join(', ')}`);
    }

    // Tools used
    if (toolNames.length > 0) {
      parts.push(`Tools Used: ${toolNames.join(', ')}`);
    }

    // Usage instructions for Claude
    parts.push('\nUSE THIS HISTORY TO:');
    parts.push('- Reference past calls naturally. Example: "Last time you called you were focused on [blocker] — how did that go?"');
    parts.push('- Skip questions already answered. If stage and strategy are known, do not ask again.');
    parts.push('- Avoid recommending resources they have already tried.');
    parts.push('- Acknowledge progress. If they moved from Exploring to Active, name it.');

    const result = parts.join('\n');

    console.log('Member history retrieved for:', contact.full_name, '| past calls:', pastCalls.length);

    return res.status(200).json({
      result,
      contact_id: contactId,
      past_calls_count: pastCalls.length,
      has_profile: !!profile
    });

  } catch(e) {
    console.error('member-history error:', e.message);
    return res.status(200).json(vapiResult('Could not retrieve member history. Proceed with the information already available.'));
  }
}