/**
 * Vapi → GHL + Supabase sync endpoint. This is the call-lifecycle webhook that
 * Vapi POSTs to for every event during a voice call. We only act on two event
 * types and ignore the rest with a 200:
 *
 *   1) "conversation-update" (mid-call):
 *      Scans the rolling transcript for a user message that looks like a phone
 *      number (≥10 digits when non-digits are stripped). If found and we
 *      haven't already returned a profile for this call (detected via a
 *      MEMBER_PROFILE: marker in the conversation history), looks the member
 *      up in Supabase and returns a `messageResponse.content` block that Vapi
 *      injects into the conversation as a system message. The injected
 *      profile tells Claude the caller's name, membership tier, journey
 *      stage, strategies, recent events, and prior blocker so it can skip
 *      the qualifying questions and personalize the greeting.
 *
 *   2) "end-of-call-report" (post-call):
 *      Reads Vapi structuredOutputs (per-tool extracted fields keyed by output
 *      ID), then performs three writes:
 *        a) POSTs a flattened payload to GHL_WEBHOOK_URL (firstName, lastName,
 *           tags, customFields with hard-coded GHL field IDs) so the GHL
 *           workflow can create/update the contact.
 *        b) Upserts the contact + investor_profile in Supabase, keyed by
 *           email when present, falling back to phone.
 *        c) After a 4s delay (to let the GHL workflow create the contact),
 *           searches GHL by phone and PATCHes the contact's custom fields via
 *           the v2 LeadConnector API.
 *        d) Writes a row to `readiness_surveys` so downstream analytics can
 *           track Map 1 (intake) classification, including path A vs B.
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_WEBHOOK_URL,
 * GHL_API_KEY. Missing vars degrade gracefully (the affected write is skipped
 * and logged) rather than failing the whole request.
 *
 * @param {import('http').IncomingMessage & { body: any, method: string }} req - Vapi webhook POST
 * @param {import('http').ServerResponse & { status: Function, json: Function, end: Function }} res
 * @returns {Promise<void>} Almost always 200 — Vapi retries on non-2xx and we'd rather
 *                          swallow errors than have it retry partial side effects
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    const eventType = payload.message?.type || payload.type;

    console.log('Vapi event received:', eventType);

    // Handle conversation-update — detect phone number and inject member profile.
    // Vapi sends this event continuously as the transcript grows. We watch for
    // the first user utterance that looks like a phone number, do a one-shot
    // lookup, and return a messageResponse that Vapi injects as a system
    // message. The MEMBER_PROFILE: marker in subsequent transcripts prevents
    // us from running the lookup twice in the same call.
    if (eventType === 'conversation-update') {
      const messages = payload.message?.conversation || payload.conversation || [];
      
      // Look for a user message that looks like a phone number (10+ digits when stripped)
      const phoneMessage = messages
        .filter(m => m.role === 'user')
        .reverse()
        .find(m => {
          const digits = (m.content || m.message || '').replace(/\D/g, '');
          return digits.length >= 10;
        });

      if (!phoneMessage) {
        return res.status(200).json({ ok: true });
      }

      const rawPhone = (phoneMessage.content || phoneMessage.message || '');
      const digits = rawPhone.replace(/\D/g, '').slice(-10);

      // Check if we already did a lookup for this phone in this call
      // by looking for a system message with MEMBER_PROFILE tag
      const alreadyLookedUp = messages.some(m =>
        m.role === 'system' && (m.content || '').includes('MEMBER_PROFILE:')
      );

      if (alreadyLookedUp) {
        return res.status(200).json({ ok: true });
      }

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

      if (!SUPABASE_URL || !SUPABASE_KEY || !digits) {
        return res.status(200).json({ ok: true });
      }

      try {
        // Fetch all contacts and match by last 10 digits
        const contactResp = await fetch(
          `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=not.is.null&limit=500`,
          {
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`
            }
          }
        );

        const contacts = await contactResp.json();
        const match = Array.isArray(contacts)
          ? contacts.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === digits)
          : null;

        if (!match) {
          console.log('Member not found for phone:', digits);
          return res.status(200).json({
            messageResponse: {
              content: `MEMBER_PROFILE: not_found. Phone ${digits} was searched but no match found in Utah REIA member database. Continue with normal diagnostic flow.`
            }
          });
        }

        const contactId = match.id;
        console.log('Member found:', match.full_name, '| id:', contactId);

        // Fetch investor profile
        const profileResp = await fetch(
          `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months&limit=1`,
          { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const profiles = await profileResp.json();
        const profile = profiles?.[0] || null;

        // Fetch event attendance
        const eventResp = await fetch(
          `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${contactId}&select=event_name&order=attended_at.desc&limit=3`,
          { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const events = await eventResp.json();

        // Fetch last voice agent survey
        const surveyResp = await fetch(
          `${SUPABASE_URL}/rest/v1/readiness_surveys?contact_id=eq.${contactId}&source=eq.voice_agent&select=answers&order=created_at.desc&limit=1`,
          { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const surveys = await surveyResp.json();

        // Build member profile summary
        const name = match.full_name;
        const firstName = name?.split(' ')[0] || 'there';
        const status = match.membership_status || '';
        const memberType = match.membership_type || '';
        const isBoard = match.is_board_member;
        const lastEvent = match.last_reia_event || '';
        const stage = profile?.investing_journey_stage || '';
        const strategies = profile?.investing_interests || [];
        const goal = profile?.accomplish_next_6_to_12_months || [];
        const eventNames = Array.isArray(events) ? events.map(e => e.event_name).filter(Boolean) : [];

        // Last survey blocker
        let lastBlocker = '';
        if (surveys?.[0]?.answers) {
          try {
            const ans = typeof surveys[0].answers === 'string'
              ? JSON.parse(surveys[0].answers)
              : surveys[0].answers;
            lastBlocker = ans.blocker || '';
          } catch(e) {}
        }

        // Build context string for Claude
        const profileLines = [
          `MEMBER_PROFILE: FOUND`,
          `Name: ${name}`,
          `Membership Status: ${status}`,
          `Membership Type: ${memberType}`,
          `Board Member: ${isBoard ? 'Yes' : 'No'}`,
          stage ? `Investing Stage: ${stage}` : '',
          strategies?.length ? `Strategies: ${Array.isArray(strategies) ? strategies.join(', ') : strategies}` : '',
          goal?.length ? `Goal: ${Array.isArray(goal) ? goal[0] : goal}` : '',
          eventNames.length ? `Events Attended: ${eventNames.join(', ')}` : '',
          lastEvent && !eventNames.length ? `Last Event: ${lastEvent}` : '',
          lastBlocker ? `Last Blocker Mentioned: ${lastBlocker}` : '',
        ].filter(Boolean).join(' | ');

        console.log('Injecting member profile for:', name);

        const injectedContent = 'MEMBER_PROFILE: FOUND | ' + profileLines + ' | This caller is a known Utah REIA member. Greet them by first name ' + firstName + ', acknowledge what you know about them, skip the qualifying question, and ask one focused question based on their profile.';

        return res.status(200).json({
          messageResponse: {
            content: injectedContent
          }
        });

      } catch(e) {
        console.error('Member lookup error in conversation-update:', e.message);
        return res.status(200).json({ ok: true });
      }
    }

    if (eventType !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, skipped: true, eventType });
    }

    console.log('=== END OF CALL REPORT ===');

    // Vapi structured outputs come as an object keyed by output ID.
    // Each value has { name, result } shape — we collapse it into a flat
    // { name: result } map so we can do `structured.callerName` instead of
    // walking an unstable key set.
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

    // Update contact custom fields via GHL v2 API using Private Integration Token.
    // We can't update fields in the same call that creates the contact because
    // the GHL workflow that creates it runs async — so we wait 4s, search for
    // the contact by phone, then PATCH the dropdown fields (Investor Stage,
    // Profile Type) which the webhook payload can't set directly.
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