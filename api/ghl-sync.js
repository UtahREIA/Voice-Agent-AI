// GHL sync handler
// Receives Vapi end-of-call webhook and syncs structured data to GHL
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    console.log('Vapi webhook received:', JSON.stringify(payload).substring(0, 500));

    // Vapi sends different event types — only process end-of-call-report
    const eventType = payload.type || payload.message?.type;
    if (eventType && eventType !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, skipped: true, eventType });
    }

    // Extract structured data from Vapi payload
    // Vapi wraps it in message.analysis.structuredData or directly in analysis
    const analysis = payload.message?.analysis || payload.analysis || {};
    const structured = analysis.structuredData || {};
    const transcript = payload.message?.transcript || payload.transcript || '';
    const callDuration = payload.message?.durationSeconds || payload.durationSeconds || 0;

    const {
      callerName    = '',
      callerEmail   = '',
      callerPhone   = '',
      profileType   = 'Investor',
      investorStage = '',
      strategies    = [],
      blocker       = '',
      goals         = '',
      summary       = '',
      recommendedNextStep = ''
    } = structured;

    console.log('Structured data:', JSON.stringify(structured));

    if (!callerEmail && !callerPhone) {
      console.log('No contact info found — skipping GHL sync');
      return res.status(200).json({ ok: true, skipped: true, reason: 'no contact info' });
    }

    // Build GHL contact payload with exact field keys
    const ghlPayload = {
      firstName: callerName.split(' ')[0] || callerName,
      lastName:  callerName.split(' ').slice(1).join(' ') || '',
      email:     callerEmail,
      phone:     callerPhone,
      tags: [
        'Voice Agent Lead',
        investorStage ? 'Stage: ' + investorStage : null,
        blocker       ? 'Blocker: ' + blocker     : null,
        ...strategies.map(s => 'Strategy: ' + s)
      ].filter(Boolean),
      customFields: [
        // Map to exact GHL field keys
        {
          id: 'swDtahR8SAnG4S34s2a6', // where_would_you_say_you_are_in_your_real_estate_investing_journey
          field_value: investorStage
        },
        {
          id: 'hf9VEhcVwgyNXP3qbzsA', // what_type_of_investing_are_you_most_interested_in
          field_value: strategies
        },
        {
          id: 't150aKjUz1KvU183CtJw', // what_are_you_trying_to_accomplish_in_the_next_6_to_12_months
          field_value: goals ? [goals] : []
        },
        {
          id: 'mTmRVbyZKGqVXqHvhsX6', // entity_type (Profile Type)
          field_value: profileType
        },
        {
          id: 'TCCSXzunxUqJme5YtGSr', // message (Voice call summary)
          field_value: summary + (recommendedNextStep ? '\n\nRecommended next step: ' + recommendedNextStep : '')
        },
        // Blocker maps to relevant need bucket
        blocker === 'capital' ? {
          id: 'A6d3LiW4tm4sRYgKkexW', // funding__financial
          field_value: ['Needs funding / capital']
        } : null,
        blocker === 'deals' ? {
          id: 'xRQGkFLJLgH0L3RQUxKF', // deals__opportunities
          field_value: ['Looking for deals']
        } : null,
        blocker === 'team' ? {
          id: 'oiMoxdyO8wHRWl8ECyug', // team__vendors
          field_value: ['Needs team / vendors']
        } : null,
        blocker === 'education' ? {
          id: 'cXLx5ddIl6enzdedkmfe', // education__tools
          field_value: ['Needs education']
        } : null,
        blocker === 'connections' ? {
          id: 'q9gTLJDiYuEjx0ofOBkF', // growth__network
          field_value: ['Looking for peer connections']
        } : null,
      ].filter(Boolean)
    };

    // Send to GHL via webhook
    const GHL_WEBHOOK = process.env.GHL_WEBHOOK_URL;
    if (!GHL_WEBHOOK || GHL_WEBHOOK.includes('YOUR_WEBHOOK_ID')) {
      console.log('GHL webhook not configured — logging payload only');
      console.log('GHL payload:', JSON.stringify(ghlPayload));
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
      const sbResp = await fetch(`${req.headers.host ? 'https://' + req.headers.host : ''}/api/supabase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          contact: { name: callerName, email: callerEmail, phone: callerPhone },
          profile: {
            role: profileType.toLowerCase().includes('vendor') ? 'vendor' : 'investor',
            stage: investorStage.toLowerCase().replace(/ /g, '_').replace('active_investor', 'active').replace('experienced_investor', 'experienced'),
            strategies: strategies.map(s => s.toLowerCase().replace(/ /g, '_').replace('&', 'and').replace('fix_and_flip', 'fix_and_flip')),
            blocker,
            goals,
            summary
          }
        })
      });
      console.log('Supabase upsert status:', sbResp.status);
    }

    return res.status(200).json({ ok: true, ghlStatus: ghlResp.status });

  } catch(e) {
    console.error('GHL sync error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
