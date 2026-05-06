export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    const eventType = payload.message?.type || payload.type;

    // Only process end-of-call-report — skip all other event types
    if (eventType !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, skipped: true, eventType });
    }

    console.log('End of call report received');

    const analysis  = payload.message?.analysis || payload.analysis || {};
    const structured = analysis.structuredData || {};

    const {
      callerName    = '',
      callerEmail   = '',
      callerPhone   = '',
      profileType   = 'Investor',
      investorStage = '',
      strategies    = '',
      blocker       = '',
      goals         = '',
      summary       = '',
      recommendedNextStep = ''
    } = structured;

    console.log('Structured data:', JSON.stringify(structured));

    if (!callerEmail && !callerPhone) {
      console.log('No contact info — skipping GHL sync');
      return res.status(200).json({ ok: true, skipped: true, reason: 'no contact info' });
    }

    // Convert strategies string to array if needed
    const strategiesArray = Array.isArray(strategies)
      ? strategies
      : strategies.split(',').map(s => s.trim()).filter(Boolean);

    const ghlPayload = {
      firstName: callerName.split(' ')[0] || callerName,
      lastName:  callerName.split(' ').slice(1).join(' ') || '',
      email:     callerEmail,
      phone:     callerPhone,
      tags: [
        'Voice Agent Lead',
        investorStage ? 'Stage: ' + investorStage : null,
        blocker       ? 'Blocker: ' + blocker     : null,
        ...strategiesArray.map(s => 'Strategy: ' + s)
      ].filter(Boolean),
      customFields: [
        { id: 'swDtahR8SAnG4S34s2a6', field_value: investorStage },
        { id: 'hf9VEhcVwgyNXP3qbzsA', field_value: strategiesArray },
        { id: 't150aKjUz1KvU183CtJw', field_value: goals ? [goals] : [] },
        { id: 'mTmRVbyZKGqVXqHvhsX6', field_value: profileType },
        { id: 'TCCSXzunxUqJme5YtGSr', field_value: summary + (recommendedNextStep ? '\n\nRecommended next step: ' + recommendedNextStep : '') },
        blocker === 'capital'     ? { id: 'A6d3LiW4tm4sRYgKkexW', field_value: ['Needs funding / capital'] } : null,
        blocker === 'deals'       ? { id: 'xRQGkFLJLgH0L3RQUxKF', field_value: ['Looking for deals'] }      : null,
        blocker === 'team'        ? { id: 'oiMoxdyO8wHRWl8ECyug', field_value: ['Needs team / vendors'] }   : null,
        blocker === 'education'   ? { id: 'cXLx5ddIl6enzdedkmfe', field_value: ['Needs education'] }        : null,
        blocker === 'connections' ? { id: 'q9gTLJDiYuEjx0ofOBkF', field_value: ['Looking for peer connections'] } : null,
      ].filter(Boolean)
    };

    const GHL_WEBHOOK = process.env.GHL_WEBHOOK_URL;

    if (!GHL_WEBHOOK || GHL_WEBHOOK.includes('YOUR_WEBHOOK_ID')) {
      console.log('GHL webhook not configured — payload ready but not sent:', JSON.stringify(ghlPayload));
      return res.status(200).json({ ok: true, note: 'GHL webhook not configured', payload: ghlPayload });
    }

    const ghlResp = await fetch(GHL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ghlPayload)
    });
    console.log('GHL sync status:', ghlResp.status);

    // Also upsert to Supabase
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (SUPABASE_URL && SUPABASE_KEY && callerEmail) {
      const stageMap = {
        'Exploring': 'exploring',
        'Getting Started': 'getting_started',
        'Active Investor': 'active',
        'Experienced Investor': 'experienced',
        'Veteran': 'veteran'
      };

      const baseHeaders = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      };

      // Check if contact exists
      const existing = await fetch(
        `${SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(callerEmail)}&select=id&limit=1`,
        { headers: baseHeaders }
      ).then(r => r.json());

      let contactId;
      if (existing.length > 0) {
        contactId = existing[0].id;
        await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`, {
          method: 'PATCH',
          headers: baseHeaders,
          body: JSON.stringify({ full_name: callerName, phone: callerPhone, updated_at: new Date().toISOString() })
        });
      } else {
        const created = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({
            full_name: callerName, email: callerEmail, phone: callerPhone,
            profile_type: profileType, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
          })
        }).then(r => r.json());
        contactId = created[0]?.id;
      }

      if (contactId) {
        const profileData = {
          contact_id: contactId,
          where_in_journey: stageMap[investorStage] || investorStage,
          investing_types: strategiesArray,
          goals_6_to_12_months: goals ? [goals] : null,
          updated_at: new Date().toISOString()
        };
        const existingProfile = await fetch(
          `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=id&limit=1`,
          { headers: baseHeaders }
        ).then(r => r.json());

        if (existingProfile.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}`, {
            method: 'PATCH', headers: baseHeaders, body: JSON.stringify(profileData)
          });
        } else {
          await fetch(`${SUPABASE_URL}/rest/v1/investor_profiles`, {
            method: 'POST', headers: baseHeaders,
            body: JSON.stringify({ ...profileData, created_at: new Date().toISOString() })
          });
        }
        console.log('Supabase upsert complete for contact:', contactId);
      }
    }

    return res.status(200).json({ ok: true, ghlStatus: ghlResp.status });

  } catch(e) {
    console.error('GHL sync error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}