export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    const eventType = payload.message?.type || payload.type;

    console.log('Vapi event received:', eventType);

    if (eventType !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, skipped: true, eventType });
    }

    console.log('=== END OF CALL REPORT ===');

    // Vapi structured outputs come as an object keyed by output ID
    // Each value has { name, result } shape
    const structuredOutputs = payload.message?.artifact?.structuredOutputs ||
                              payload.artifact?.structuredOutputs || {};

    // Build a name -> result map
    const structured = {};
    for (const key of Object.keys(structuredOutputs)) {
      const item = structuredOutputs[key];
      if (item?.name && item?.result !== undefined) {
        structured[item.name] = item.result;
      }
    }

    console.log('Structured data:', JSON.stringify(structured));

    const callerName    = structured.callerName    || '';
    const callerPhone   = structured.callerPhone   || '';
    const callerEmail   = structured.callerEmail   || '';
    const profileType   = structured.profileType   || 'Investor';
    const investorStage = structured.investorStage || '';
    const strategies    = structured.strategies    || '';
    const blocker       = structured.blocker       || '';
    const goals         = structured.goals         || '';
    const summary       = structured.summary       || '';
    const recommendedNextStep = structured.recommendedNextStep || '';

    console.log('Extracted — name:', callerName, '| phone:', callerPhone, '| stage:', investorStage);

    if (!callerName && !callerPhone) {
      console.log('No contact info — skipping GHL sync');
      return res.status(200).json({ ok: true, skipped: true, reason: 'no contact info' });
    }

    // Convert strategies string to array
    const strategiesArray = Array.isArray(strategies)
      ? strategies
      : strategies.split(',').map(s => s.trim()).filter(Boolean);

    // Build GHL payload
    const nameParts = callerName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    const ghlPayload = {
      firstName,
      lastName,
      email:  callerEmail || '',
      phone:  callerPhone,
      // Flat fields for easy GHL workflow mapping via {{inboundWebhookRequest.*}}
      investorStage,
      strategies: strategiesArray.join(', '),
      blocker,
      goals,
      summary,
      recommendedNextStep,
      profileType,
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
        { id: 'TCCSXzunxUqJme5YtGSr', field_value: summary + (recommendedNextStep ? '\n\nNext step: ' + recommendedNextStep : '') },
        blocker === 'capital'     ? { id: 'A6d3LiW4tm4sRYgKkexW', field_value: ['Needs funding / capital'] } : null,
        blocker === 'deals'       ? { id: 'xRQGkFLJLgH0L3RQUxKF', field_value: ['Looking for deals'] }      : null,
        blocker === 'team'        ? { id: 'oiMoxdyO8wHRWl8ECyug', field_value: ['Needs team / vendors'] }   : null,
        blocker === 'education'   ? { id: 'cXLx5ddIl6enzdedkmfe', field_value: ['Needs education'] }        : null,
        blocker === 'connections' ? { id: 'q9gTLJDiYuEjx0ofOBkF', field_value: ['Looking for peer connections'] } : null,
      ].filter(Boolean)
    };

    console.log('GHL payload:', JSON.stringify(ghlPayload));

    const GHL_WEBHOOK = process.env.GHL_WEBHOOK_URL;
    if (!GHL_WEBHOOK) {
      console.log('GHL_WEBHOOK_URL not set');
      return res.status(200).json({ ok: true, note: 'GHL webhook not configured', payload: ghlPayload });
    }

    const ghlResp = await fetch(GHL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ghlPayload)
    });
    const ghlBody = await ghlResp.text();
    console.log('GHL sync status:', ghlResp.status, ghlBody.substring(0, 200));

    // Supabase upsert
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (SUPABASE_URL && SUPABASE_KEY && (callerPhone || callerEmail)) {
      const baseHeaders = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      };

      const stageMap = {
        'Exploring': 'exploring',
        'Getting Started': 'getting_started',
        'Active Investor': 'active',
        'Experienced Investor': 'experienced',
        'Veteran': 'veteran'
      };

      const lookupField = callerEmail
        ? `email=eq.${encodeURIComponent(callerEmail)}`
        : `phone=eq.${encodeURIComponent(callerPhone)}`;

      const existing = await fetch(
        `${SUPABASE_URL}/rest/v1/contacts?${lookupField}&select=id&limit=1`,
        { headers: baseHeaders }
      ).then(r => r.json()).catch(() => []);

      let contactId;
      if (existing.length > 0) {
        contactId = existing[0].id;
        await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`, {
          method: 'PATCH',
          headers: baseHeaders,
          body: JSON.stringify({ full_name: callerName, phone: callerPhone, updated_at: new Date().toISOString() })
        });
        console.log('Supabase contact updated:', contactId);
      } else {
        const created = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({
            full_name: callerName, email: callerEmail || null, phone: callerPhone,
            profile_type: profileType,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString()
          })
        }).then(r => r.json()).catch(() => []);
        contactId = created[0]?.id;
        console.log('Supabase contact created:', contactId);
      }

      if (contactId && (investorStage || strategiesArray.length)) {
        const profileData = {
          contact_id: contactId,
          investing_journey_stage: stageMap[investorStage] || investorStage || null,
          investing_interests: strategiesArray.length ? strategiesArray : null,
          accomplish_next_6_to_12_months: goals ? [goals] : null,
          updated_at: new Date().toISOString()
        };
        const existingProfile = await fetch(
          `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=id&limit=1`,
          { headers: baseHeaders }
        ).then(r => r.json()).catch(() => []);

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
        console.log('Supabase investor profile upserted');
      }
    }

    // Update contact custom fields via GHL v2 API using Private Integration Token
    const GHL_API_KEY = process.env.GHL_API_KEY;
    if (GHL_API_KEY && callerPhone) {
      try {
        // Wait briefly for GHL workflow to create the contact first
        await new Promise(r => setTimeout(r, 4000));

        // Search for contact by phone using v2 API
        const searchResp = await fetch(
          `https://services.leadconnectorhq.com/contacts/?locationId=DNirEjy0ejVwbHsaBYrn&query=${encodeURIComponent(callerPhone)}`,
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            }
          }
        );
        const searchData = await searchResp.json();
        console.log('GHL search status:', searchResp.status);

        const contact = searchData.contacts?.[0];
        if (contact?.id) {
          const stageMap = {
            'Exploring': 'Exploring / New',
            'Getting Started': 'Getting Started',
            'Active Investor': 'Active Investor',
            'Experienced Investor': 'Experienced Investor',
            'Veteran': 'Veteran / Operator'
          };

          const updateResp = await fetch(
            `https://services.leadconnectorhq.com/contacts/${contact.id}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${GHL_API_KEY}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28'
              },
              body: JSON.stringify({
                customFields: [
                  { id: 'swDtahR8SAnG4S34s2a6', field_value: stageMap[investorStage] || investorStage },
                  { id: 'mTmRVbyZKGqVXqHvhsX6', field_value: profileType }
                ]
              })
            }
          );
          console.log('GHL contact fields updated:', updateResp.status);
        } else {
          console.log('GHL contact not found for phone:', callerPhone);
        }
      } catch(e) {
        console.error('GHL API update error:', e.message);
      }
    }

    // Write to readiness_surveys table — Map 1 classification record
    if (SUPABASE_URL && SUPABASE_KEY && contactId) {
      try {
        const baseHeaders2 = {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        };
        const surveyData = {
          contact_id: contactId,
          survey_id: 'voice-agent-intake',
          survey_name: 'Voice Agent Intake',
          survey_type: 'voice_agent',
          submission_id: 'vapi-' + Date.now(),
          submitted_at: new Date().toISOString(),
          source: 'voice_agent',
          answers: JSON.stringify({
            callerName,
            callerPhone,
            profileType,
            investorStage,
            strategies: strategiesArray,
            blocker,
            goals,
            summary,
            recommendedNextStep,
            path: (investorStage === 'Exploring' || investorStage === 'Getting Started') ? 'A' : 'B'
          }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await fetch(`${SUPABASE_URL}/rest/v1/readiness_surveys`, {
          method: 'POST',
          headers: baseHeaders2,
          body: JSON.stringify(surveyData)
        });
        console.log('Readiness survey written for:', callerName);
      } catch(e) {
        console.error('Readiness survey write error:', e.message);
      }
    }

    return res.status(200).json({ ok: true, ghlStatus: ghlResp.status });

  } catch(e) {
    console.error('ghl-sync error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}