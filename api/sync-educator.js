// Syncs educator data from GHL to Supabase education_resources table
// Called by GHL workflow when a contact is tagged as a speaker

/**
 * Webhook sink that mirrors GHL "educator/speaker" contacts into the Supabase
 * `education_resources` table so the voice agent's education-matching logic can
 * recommend them. Fired by a GoHighLevel workflow whenever a contact is tagged
 * as a speaker (or their pipeline status changes).
 *
 * Behavior:
 *   - `name` is required; everything else is optional.
 *   - `pipeline_status` is mapped to `is_active`: any status string containing
 *     "active", "approved", or "confirmed" → true; missing status → true;
 *     anything else → false (so removing the active tag deactivates them).
 *   - `bio` + `takeaways` are concatenated and truncated to 500 chars for the
 *     resource description.
 *   - `strategies` and `stages` accept either an array or a comma-separated
 *     string. If `stages` isn't provided, defaults to the four investor stages
 *     above "exploring" — the assumption is educators rarely help true beginners.
 *   - Upserts on (educator_name, resource_type='educator'): PATCH if a row
 *     already exists, POST otherwise.
 *
 * @param {import('http').IncomingMessage & { body: any, method: string }} req - POST with educator fields
 * @param {import('http').ServerResponse & { status: Function, json: Function, end: Function }} res
 * @returns {Promise<void>} 200 `{ ok: true, action: 'inserted'|'updated', name }` on success
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const {
    name,
    bio,
    specialty,
    takeaways,
    topic,
    years_experience,
    pipeline_status,
    booking_url,
    strategies,
    stages
  } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  console.log('Educator sync received for:', name, '| status:', pipeline_status);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // Map pipeline status to is_active
    const isActive = !pipeline_status ||
      pipeline_status.toLowerCase().includes('active') ||
      pipeline_status.toLowerCase().includes('approved') ||
      pipeline_status.toLowerCase().includes('confirmed');

    // Build description from bio and takeaways
    const description = [bio, takeaways].filter(Boolean).join(' ').substring(0, 500) ||
      `${name} — available for mentorship and strategy sessions through Utah REIA.`;

    // Parse strategies from specialty/topic if provided
    const strategyList = strategies
      ? (Array.isArray(strategies) ? strategies : strategies.split(',').map(s => s.trim()))
      : null;

    const stageList = stages
      ? (Array.isArray(stages) ? stages : stages.split(',').map(s => s.trim()))
      : ['getting_started', 'active', 'experienced', 'veteran'];

    const educatorData = {
      title: `Mentorship Session — ${name}`,
      resource_type: 'educator',
      stages: stageList,
      strategies: strategyList,
      goals: ['learn_strategy', 'analyze_deals', 'scale_portfolio'],
      blockers: ['education', 'connections'],
      description,
      educator_name: name,
      educator_specialty: specialty || topic || null,
      booking_url: booking_url || null,
      is_free: false,
      is_active: isActive,
      priority: 2,
      updated_at: new Date().toISOString()
    };

    // Check if educator already exists
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/education_resources?educator_name=eq.${encodeURIComponent(name)}&resource_type=eq.educator&select=id&limit=1`,
      { headers: baseHeaders }
    );
    const existingData = await existing.json();

    if (existingData.length > 0) {
      // Update existing record
      const updateResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_resources?id=eq.${existingData[0].id}`,
        {
          method: 'PATCH',
          headers: { ...baseHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify(educatorData)
        }
      );
      console.log('Educator updated:', name, '| status:', updateResp.status);
      return res.status(200).json({ ok: true, action: 'updated', name });
    } else {
      // Insert new record
      const insertResp = await fetch(
        `${SUPABASE_URL}/rest/v1/education_resources`,
        {
          method: 'POST',
          headers: { ...baseHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ ...educatorData, created_at: new Date().toISOString() })
        }
      );
      console.log('Educator inserted:', name, '| status:', insertResp.status);
      return res.status(200).json({ ok: true, action: 'inserted', name });
    }

  } catch(e) {
    console.error('Educator sync error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
