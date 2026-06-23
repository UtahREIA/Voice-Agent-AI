/**
 * member-profile.js
 * Called by Vapi tool getMemberProfile during a call
 * after the agent has collected and confirmed the caller's phone number.
 *
 * Looks up the contact in Supabase by phone number and returns:
 * - Their investor profile (stage, strategies, goals)
 * - Past call history (last recommendation, educator match)
 * - Tool access (calculators they have used)
 * - Event attendance
 *
 * This enables mid-call personalization without requiring
 * the caller to type their number before the call starts.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ result: 'Method not allowed' });

  // Extract toolCallId for Vapi response format
  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id
    || req.body?.message?.toolCalls?.[0]?.id
    || req.body?.toolCallList?.[0]?.id
    || null;

  function vapiResult(result) {
    if (toolCallId) return { results: [{ toolCallId, result: String(result) }] };
    return { result: String(result) };
  }

  // Extract phone from tool arguments
  function extractArgs(body) {
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

  console.log('getMemberProfile called with phone:', rawPhone);

  if (!rawPhone) {
    return res.status(200).json(vapiResult('No phone number provided. Continue with intake.'));
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json(vapiResult('Profile lookup unavailable. Continue normally.'));
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Normalize phone — try last 10 digits
    const digits = rawPhone.replace(/\D/g, '');
    const last10 = digits.slice(-10);

    if (last10.length < 10) {
      return res.status(200).json(vapiResult('Phone number unclear. Ask the caller to repeat it.'));
    }

    // Search contacts table
    const contactResp = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_type,ghl_membership_status&limit=5`,
      { headers: baseHeaders }
    );
    const allContacts = await contactResp.json();

    const match = Array.isArray(allContacts)
      ? allContacts.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10)
      : null;

    if (!match) {
      return res.status(200).json(vapiResult(
        `No profile found for ${last10}. This appears to be a new caller. Continue with full intake and collect their email at the end.`
      ));
    }

    const firstName = (match.full_name || '').split(' ')[0] || 'there';
    const parts = [`MEMBER FOUND: ${match.full_name || 'Unknown'}`];

    if (match.membership_type) parts.push(`Membership: ${match.membership_type}`);

    // Fetch investor profile
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${match.id}&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months,wants_mentor_connection,wants_professional_connections&limit=1`,
      { headers: baseHeaders }
    );
    const profiles = await profileResp.json();
    const profile = Array.isArray(profiles) ? profiles[0] : null;

    if (profile) {
      if (profile.investing_journey_stage) parts.push(`Stage: ${profile.investing_journey_stage}`);
      if (profile.investing_interests?.length) parts.push(`Interests: ${profile.investing_interests.join(', ')}`);
      if (profile.accomplish_next_6_to_12_months?.length) parts.push(`Goals: ${profile.accomplish_next_6_to_12_months.join(', ')}`);
    }

    // Fetch past call history
    const historyResp = await fetch(
      `${SUPABASE_URL}/rest/v1/voice_agent_calls?contact_id=eq.${match.id}&select=stack_summary,recommended_next,educator_match,blocker,created_at&order=created_at.desc&limit=3`,
      { headers: baseHeaders }
    );
    const history = await historyResp.json();

    let lastCallSummary = '';
    if (Array.isArray(history) && history.length > 0) {
      // Find most recent call with meaningful data
      const meaningful = history.find(h =>
        (h.stack_summary && h.stack_summary.length > 20 && !h.stack_summary.toLowerCase().includes('returning to utah')) ||
        (h.recommended_next && h.recommended_next.length > 10) ||
        (h.educator_match && h.educator_match.length > 2)
      );

      if (meaningful) {
        const date = meaningful.created_at
          ? new Date(meaningful.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'previously';
        lastCallSummary = meaningful.stack_summary || meaningful.recommended_next || '';
        parts.push(`Last call (${date}): ${lastCallSummary.slice(0, 150)}`);
        if (meaningful.educator_match) parts.push(`Educator matched: ${meaningful.educator_match}`);
      }

      parts.push(`Total past calls: ${history.length}`);
    }

    // Build instruction for agent
    const hasHistory = lastCallSummary.length > 0;
    const instruction = hasHistory
      ? `RETURNING MEMBER — greet ${firstName} by name. Say: "Welcome back ${firstName}, before we dive into why you called today, I want to follow up on what I recommended last time: ${lastCallSummary.slice(0, 120)}. How did that go?" Then listen to their response before moving to new topics.`
      : `RETURNING MEMBER — greet ${firstName} by name. Say: "Welcome back ${firstName}, glad you reached out to Utah REIA. What are you working on today?" Then go straight to helping them — skip the full intake.`;

    parts.push(`\nINSTRUCTION: ${instruction}`);

    const result = parts.join(' | ');
    console.log('getMemberProfile result:', result.slice(0, 200));

    return res.status(200).json(vapiResult(result));

  } catch(e) {
    console.error('getMemberProfile error:', e.message);
    return res.status(200).json(vapiResult('Profile lookup failed. Continue with intake normally.'));
  }
}
