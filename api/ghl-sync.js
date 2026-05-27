/**
 * ghl-sync.js — Utah REIA Voice Agent Post-Call Sync
 *
 * This is the Vapi server URL endpoint. It receives ALL Vapi webhook events
 * during and after every voice agent call.
 *
 * Two event types are handled:
 *
 * 1. conversation-update — fires mid-call whenever the conversation changes.
 *    We use this to detect when a caller speaks their phone number and inject
 *    their member profile from Supabase back into the conversation so Claude
 *    can personalize the response. This is the mid-call member recognition system.
 *    NOTE: This path is a fallback — pre-call lookup in index.html is the primary
 *    member recognition method. This handles cases where the pre-call lookup missed.
 *
 * 2. end-of-call-report — fires after every call ends with structured outputs,
 *    transcript, and call metadata. We use this to:
 *    - Send the call data to the GHL inbound webhook (triggers the post-call workflow)
 *    - Upsert the contact and investor profile in Supabase
 *    - Update GHL contact custom fields via the v2 API using the Private Integration Token
 *    - Write a readiness survey record to Supabase for Map 1 classification
 *
 * Environment variables required:
 *   SUPABASE_URL           — Supabase project URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key (bypasses RLS)
 *   GHL_WEBHOOK_URL        — GHL inbound webhook URL for the Voice Agent Lead workflow
 *   GHL_API_KEY            — GHL Private Integration Token for v2 API custom field updates
 *
 * GHL Location ID: DNirEjy0ejVwbHsaBYrn
 * Vapi Assistant ID: 92018c4f-f382-41b9-80e0-c46e8f2b505a
 */

export default async function handler(req, res) {
  // Only accept POST requests — Vapi always POSTs to this endpoint
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;

    // Vapi sends event type in different places depending on the event
    // For end-of-call-report it's at payload.message.type
    // For conversation-update it's also at payload.message.type
    const eventType = payload.message?.type || payload.type;

    console.log('Vapi event received:', eventType);

    // =========================================================
    // PATH 1: CONVERSATION-UPDATE — Mid-call member recognition
    // =========================================================
    // When Vapi sends a conversation-update, we scan the latest user messages
    // for a phone number. If found and not already looked up, we query Supabase
    // and inject the member profile as a system message back to Claude.
    // This allows Claude to personalize the conversation mid-call.
    if (eventType === 'conversation-update') {
      const messages = payload.message?.conversation || payload.conversation || [];

      // Scan user messages in reverse (most recent first) to find a phone number
      // A phone number is identified as any message with 10+ digits when stripped
      const phoneMessage = messages
        .filter(m => m.role === 'user')
        .reverse()
        .find(m => {
          const digits = (m.content || m.message || '').replace(/\D/g, '');
          return digits.length >= 10;
        });

      // No phone number detected in conversation yet — nothing to do
      if (!phoneMessage) {
        return res.status(200).json({ ok: true });
      }

      const rawPhone = (phoneMessage.content || phoneMessage.message || '');
      const digits = rawPhone.replace(/\D/g, '').slice(-10);

      // Prevent duplicate lookups — check if we already injected a MEMBER_PROFILE
      // system message earlier in this conversation
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
        // Query Supabase contacts — fetch up to 500 with phones for digit matching
        // NOTE: This is limited to 500 rows. The pre-call lookup in index.html
        // uses a direct formatted phone query which is more reliable for large datasets.
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

        // Match by stripping all non-digits and comparing last 10 digits
        // This handles formats like (801) 234-5678, +18012345678, 8012345678
        const match = Array.isArray(contacts)
          ? contacts.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === digits)
          : null;

        if (!match) {
          console.log('Member not found for phone:', digits);
          // Return a not_found marker so Claude knows to continue with normal intake
          return res.status(200).json({
            messageResponse: {
              content: `MEMBER_PROFILE: not_found. Phone ${digits} was searched but no match found in Utah REIA member database. Continue with normal diagnostic flow.`
            }
          });
        }

        const contactId = match.id;
        console.log('Member found:', match.full_name, '| id:', contactId);

        // Fetch investor profile for this contact (strategy, stage, goals)
        const profileResp = await fetch(
          `${SUPABASE_URL}/rest/v1/investor_profiles?contact_id=eq.${contactId}&select=investing_journey_stage,investing_interests,accomplish_next_6_to_12_months&limit=1`,
          { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const profiles = await profileResp.json();
        const profile = profiles?.[0] || null;

        // Fetch last 3 events this contact attended
        const eventResp = await fetch(
          `${SUPABASE_URL}/rest/v1/event_attendance?contact_id=eq.${contactId}&select=event_name&order=attended_at.desc&limit=3`,
          { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const events = await eventResp.json();

        // Fetch most recent voice agent survey to surface previous blockers
        const surveyResp = await fetch(
          `${SUPABASE_URL}/rest/v1/readiness_surveys?contact_id=eq.${contactId}&source=eq.voice_agent&select=answers&order=created_at.desc&limit=1`,
          { headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        const surveys = await surveyResp.json();

        // Extract all relevant profile fields
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

        // Extract blocker from most recent voice agent survey answers
        let lastBlocker = '';
        if (surveys?.[0]?.answers) {
          try {
            const ans = typeof surveys[0].answers === 'string'
              ? JSON.parse(surveys[0].answers)
              : surveys[0].answers;
            lastBlocker = ans.blocker || '';
          } catch(e) {}
        }

        // Build the profile summary string injected into Claude's context
        // Uses pipe-separated format to stay compact inside the system message
        const profileLines = [
          'MEMBER_PROFILE: FOUND',
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

        // Return the profile as a messageResponse — Vapi injects this as a system
        // message into Claude's context window for the next response turn
        const injectedContent = 'MEMBER_PROFILE: FOUND | ' + profileLines +
          ' | This caller is a known Utah REIA member. Greet them by first name ' +
          firstName + ', acknowledge what you know about them, skip the qualifying ' +
          'question, and ask one focused question based on their profile.';

        return res.status(200).json({
          messageResponse: { content: injectedContent }
        });

      } catch(e) {
        // Non-fatal — if member lookup fails mid-call, just continue normally
        console.error('Member lookup error in conversation-update:', e.message);
        return res.status(200).json({ ok: true });
      }
    }

    // =========================================================
    // SKIP all other event types except end-of-call-report
    // =========================================================
    // Vapi sends many event types (speech-update, status-update, etc.)
    // We only process end-of-call-report for post-call sync
    if (eventType !== 'end-of-call-report') {
      return res.status(200).json({ ok: true, skipped: true, eventType });
    }

    console.log('=== END OF CALL REPORT ===');

    // =========================================================
    // PATH 2: END-OF-CALL-REPORT — Post-call sync pipeline
    // =========================================================

    // --- STEP 1: Extract structured outputs from Vapi ---
    // Vapi structured outputs are keyed by output ID (a UUID), each with { name, result }
    // We convert this to a simple name -> result map for easy access
    const structuredOutputs = payload.message?.artifact?.structuredOutputs ||
                              payload.artifact?.structuredOutputs || {};

    const structured = {};
    for (const key of Object.keys(structuredOutputs)) {
      const item = structuredOutputs[key];
      if (item?.name && item?.result !== undefined) {
        structured[item.name] = item.result;
      }
    }

    console.log('Structured data:', JSON.stringify(structured));

    // --- STEP 2: Extract all caller data from structured outputs ---
    // These field names must exactly match the structured output names in Vapi

    const callerName    = structured.callerName    || '';
    const callerEmail   = structured.callerEmail   || '';
    const profileType   = structured.profileType   || 'Investor';
    const investorStage = structured.investorStage || '';
    const strategies    = structured.strategies    || '';
    const blocker       = structured.blocker       || '';
    const goals         = structured.goals         || '';
    const summary       = structured.summary       || '';
    const recommendedNextStep = structured.recommendedNextStep || '';

    // Format phone as (XXX) XXX-XXXX for GHL compatibility
    // Vapi structured outputs return phone as raw digits e.g. 8082190555
    // GHL's Find Contact step matches on formatted phone e.g. (808) 219-0555
    // Format phone as E.164 (+1XXXXXXXXXX) — this is how GHL stores all US phones
    // GHL Find Contact step matches on +18082190555 not (808) 219-0555
    //
    // callerPhone comes from the structured output — captured when agent asks for phone during intake
    // preCallPhone comes from index.html variable injection — captured from the widget before the call
    // For returning members, the agent skips intake so callerPhone is empty.
    // We fall back to preCallPhone in that case.
    //
    // Variable values are available at payload.message?.call?.metadata or
    // payload.call?.metadata or payload.message?.assistant?.variableValues
    const variableValues = payload.message?.call?.metadata?.variableValues
      || payload.message?.assistant?.variableValues
      || payload.call?.metadata?.variableValues
      || {};

    const rawCallerPhone = structured.callerPhone
      || variableValues.preCallPhone
      || '';
    const callerPhoneDigits = rawCallerPhone.replace(/\D/g, '').slice(-10);
    const callerPhone = callerPhoneDigits.length === 10
      ? '+1' + callerPhoneDigits
      : rawCallerPhone;

    // Final fallback — extract CALLER_PHONE from the system prompt liveContext
    // liveContext is injected by index.html and always contains CALLER_PHONE: XXXXXXXXXX
    // when a returning member was recognized pre-call
    let phoneFromContext = '';
    try {
      const messages = payload.message?.artifact?.transcript || '';
      const systemPrompt = payload.message?.call?.systemPrompt
        || payload.message?.assistant?.model?.messages?.[0]?.content
        || '';
      const phoneMatch = systemPrompt.match(/CALLER_PHONE:\s*([\d\s\-\(\)\+]+)/);
      if (phoneMatch) {
        phoneFromContext = phoneMatch[1].trim();
      }
    } catch(e) {}

    // Apply context phone if structured and variable sources are both empty
    const finalRawPhone = structured.callerPhone
      || variableValues.preCallPhone
      || phoneFromContext
      || '';

    const finalDigits = finalRawPhone.replace(/\D/g, '').slice(-10);
    const resolvedPhone = finalDigits.length === 10
      ? '+1' + finalDigits
      : callerPhone; // keep original if no better source found

    // Override callerPhone with the resolved value if it was empty
    if (!structured.callerPhone && resolvedPhone) {
      console.log('callerPhone was empty — resolved from fallback:', resolvedPhone);
    }

    // Use resolved phone going forward
    const effectivePhone = resolvedPhone || callerPhone;

    console.log('Phone sources — structured:', structured.callerPhone,
      '| preCallPhone:', variableValues.preCallPhone,
      '| fromContext:', phoneFromContext,
      '| final:', effectivePhone);

    console.log('Extracted — name:', callerName, '| phone:', callerPhone, '| stage:', investorStage);

    // Skip sync entirely if we have no way to identify the contact
    if (!callerName && !effectivePhone) {
      console.log('No contact info — skipping GHL sync');
      return res.status(200).json({ ok: true, skipped: true, reason: 'no contact info' });
    }

    // Convert strategies from comma-separated string to array
    // Vapi returns it as a string; GHL and Supabase expect an array
    const strategiesArray = Array.isArray(strategies)
      ? strategies
      : strategies.split(',').map(s => s.trim()).filter(Boolean);

    // Split full name into first and last for GHL
    const nameParts = callerName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName  = nameParts.slice(1).join(' ') || '';

    // --- STEP 3: Build GHL webhook payload ---
    // This payload is sent to the GHL inbound webhook which triggers
    // the "Utah REIA Voice Agent Lead" workflow.
    // All fields are accessible in GHL workflow steps as {{inboundWebhookRequest.fieldName}}
    // SINGLE_OPTIONS and MULTIPLE_OPTIONS custom fields cannot be set via webhook variables
    // — those require the GHL v2 API update below (STEP 5)
    const ghlPayload = {
      firstName,
      lastName,
      email:  callerEmail || '',
      phone:  effectivePhone,   // Formatted as E.164 e.g. +18082190555 — matches GHL storage format

      // Flat fields accessible in GHL workflow as {{inboundWebhookRequest.*}}
      investorStage,
      strategies: strategiesArray.join(', '),
      blocker,
      goals,
      summary,
      recommendedNextStep,
      profileType,

      // Tags applied to the contact in GHL
      // voice-agent-call-complete triggers the post-call workflow
      // va-booking-required triggers the educator booking SMS branch
      tags: [
        'Voice Agent Lead',
        'voice-agent-call-complete',
        structured.tier         ? 'VA Tier: ' + structured.tier              : null,
        structured.educatorMatch ? 'VA Educator: ' + structured.educatorMatch : null,
        structured.bookingRequired === 'true' ? 'va-booking-required'         : null,
        investorStage           ? 'Stage: ' + investorStage                  : null,
        blocker                 ? 'Blocker: ' + blocker                      : null,
        ...strategiesArray.map(s => 'Strategy: ' + s)
      ].filter(Boolean),

      // GHL custom fields — set via webhook payload (TEXT and LARGE_TEXT types only)
      // SINGLE_OPTIONS and MULTIPLE_OPTIONS fields are set via GHL v2 API in STEP 5
      customFields: [
        // Existing investor profile fields
        { id: 'swDtahR8SAnG4S34s2a6', field_value: investorStage },              // Investor Stage (text)
        { id: 'hf9VEhcVwgyNXP3qbzsA', field_value: strategiesArray },             // Strategies (multi)
        { id: 't150aKjUz1KvU183CtJw', field_value: goals ? [goals] : [] },        // Goals (multi)
        { id: 'mTmRVbyZKGqVXqHvhsX6', field_value: profileType },                 // Profile Type (text)
        { id: 'TCCSXzunxUqJme5YtGSr', field_value: summary + (recommendedNextStep ? '\n\nNext step: ' + recommendedNextStep : '') }, // Summary

        // New voice agent routing fields (created May 26 2026)
        { id: 'pqEFatxBgBKsS8dvY37S', field_value: structured.alreadyTried  || '' },  // Already Tried
        { id: 'QKOAN0pyMa2IkeGVAF9f', field_value: structured.stackSummary  || summary || '' }, // Stack Summary
        { id: 'Q1k7VrrG1gp0eIvg0M1h', field_value: structured.tier          || '1_info' },      // Routing Tier
        { id: '192I9uLeuO0eFLRE9VLq', field_value: structured.vendorMatches || '' },  // Vendor Matches
        { id: 'gWwvq2pv8P6jcSGOZKa8', field_value: structured.toolMatches   || '' },  // Tool Matches
        { id: 's6q99vaJ472SDrn3lKfS', field_value: structured.eventMatch     || '' },  // Event Match
        { id: 'A6oIIJNzdW2MdVTYX9I5', field_value: structured.educatorMatch  || '' },  // Educator Match
        { id: 'RVqXpTjVxGxqggfhFghA', field_value: structured.bookingRequired || 'false' },     // Booking Required
        { id: 'stkOiKKMZh2H1EEBb47z', field_value: structured.bookingUrl     || '' },  // Booking URL
        { id: '6VsempNA8BBF65gPShrQ', field_value: structured.handoffChannel  || 'sms' }, // Handoff Channel
        { id: '4fpADU1aLMIF5GMW85bo', field_value: 'unknown' },                        // Vendor Contacted (default)

        // Blocker-specific pipeline stage fields — only set the matching one
        blocker === 'capital'     ? { id: 'A6d3LiW4tm4sRYgKkexW', field_value: ['Needs funding / capital'] } : null,
        blocker === 'deals'       ? { id: 'xRQGkFLJLgH0L3RQUxKF', field_value: ['Looking for deals'] }       : null,
        blocker === 'team'        ? { id: 'oiMoxdyO8wHRWl8ECyug', field_value: ['Needs team / vendors'] }    : null,
        blocker === 'education'   ? { id: 'cXLx5ddIl6enzdedkmfe', field_value: ['Needs education'] }         : null,
        blocker === 'connections' ? { id: 'q9gTLJDiYuEjx0ofOBkF', field_value: ['Looking for peer connections'] } : null,
      ].filter(Boolean)
    };

    console.log('GHL payload:', JSON.stringify(ghlPayload));

    // --- STEP 4: Send payload to GHL inbound webhook ---
    // This triggers the "Utah REIA Voice Agent Lead" GHL workflow
    // The workflow handles: contact lookup, tagging, stage branching, SMS sending
    let ghlResp;
    const GHL_WEBHOOK = process.env.GHL_WEBHOOK_URL;
    if (!GHL_WEBHOOK) {
      console.log('GHL_WEBHOOK_URL not set — skipping GHL webhook send');
    } else {
      ghlResp = await fetch(GHL_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ghlPayload)
      });
      const ghlBody = await ghlResp.text();
      console.log('GHL sync status:', ghlResp.status, ghlBody.substring(0, 200));
    }

    // --- STEP 5: Supabase contact and investor profile upsert ---
    // Update or create the contact record in Supabase, then upsert investor profile
    // Uses phone as primary lookup key, falls back to email
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    let contactId; // Used later for survey write

    if (SUPABASE_URL && SUPABASE_KEY && (effectivePhone || callerEmail)) {
      const baseHeaders = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      };

      // Map Vapi stage names to Supabase enum values
      const stageMap = {
        'Exploring':           'exploring',
        'Getting Started':     'getting_started',
        'Active Investor':     'active',
        'Experienced Investor':'experienced',
        'Veteran':             'veteran'
      };

      // Look up existing contact by phone (preferred) or email
      const lookupField = callerEmail
        ? `email=eq.${encodeURIComponent(callerEmail)}`
        : `phone=eq.${encodeURIComponent(effectivePhone)}`;

      const existing = await fetch(
        `${SUPABASE_URL}/rest/v1/contacts?${lookupField}&select=id&limit=1`,
        { headers: baseHeaders }
      ).then(r => r.json()).catch(() => []);

      if (existing.length > 0) {
        // Contact exists — update name and phone only (don't overwrite other fields)
        contactId = existing[0].id;
        await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`, {
          method: 'PATCH',
          headers: baseHeaders,
          body: JSON.stringify({ full_name: callerName, phone: effectivePhone, updated_at: new Date().toISOString() })
        });
        console.log('Supabase contact updated:', contactId);
      } else {
        // New contact — create with all available fields
        const created = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({
            full_name:    callerName,
            email:        callerEmail || null,
            phone:        effectivePhone,
            profile_type: profileType,
            created_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString()
          })
        }).then(r => r.json()).catch(() => []);
        contactId = created[0]?.id;
        console.log('Supabase contact created:', contactId);
      }

      // Upsert investor profile if we have stage or strategy data
      if (contactId && (investorStage || strategiesArray.length)) {
        const profileData = {
          contact_id:                     contactId,
          investing_journey_stage:        stageMap[investorStage] || investorStage || null,
          investing_interests:            strategiesArray.length ? strategiesArray : null,
          accomplish_next_6_to_12_months: goals ? [goals] : null,
          updated_at:                     new Date().toISOString()
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

    // --- STEP 6: GHL v2 API — update contact custom fields ---
    // GHL workflow variables ({{inboundWebhookRequest.*}}) cannot set SINGLE_OPTIONS
    // or MULTIPLE_OPTIONS custom fields. Those require a direct API call using the
    // Private Integration Token. We wait 4 seconds first to allow the GHL workflow
    // to create the contact before we try to update it.
    const GHL_API_KEY = process.env.GHL_API_KEY;
    if (GHL_API_KEY && effectivePhone) {
      try {
        // Wait for GHL workflow to finish creating/finding the contact
        await new Promise(r => setTimeout(r, 4000));

        // Search GHL contacts by formatted phone number
        const searchResp = await fetch(
          `https://services.leadconnectorhq.com/contacts/?locationId=DNirEjy0ejVwbHsaBYrn&query=${encodeURIComponent(callerPhone)}`,
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'   // Required header for GHL v2 API
            }
          }
        );
        const searchData = await searchResp.json();
        console.log('GHL v2 search status:', searchResp.status, '| contacts found:', searchData.contacts?.length || 0);

        const contact = searchData.contacts?.[0];
        if (contact?.id) {
          // Map stage names to GHL SINGLE_OPTIONS picklist values
          const ghlStageMap = {
            'Exploring':           'Exploring / New',
            'Getting Started':     'Getting Started',
            'Active Investor':     'Active Investor',
            'Experienced Investor':'Experienced Investor',
            'Veteran':             'Veteran / Operator'
          };

          // Update SINGLE_OPTIONS and MULTIPLE_OPTIONS fields that cannot be
          // set via the inbound webhook payload
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
                  { id: 'swDtahR8SAnG4S34s2a6', field_value: ghlStageMap[investorStage] || investorStage },
                  { id: 'mTmRVbyZKGqVXqHvhsX6', field_value: profileType }
                ]
              })
            }
          );
          console.log('GHL v2 contact fields updated:', updateResp.status);
        } else {
          console.log('GHL v2 contact not found for phone:', effectivePhone);
        }
      } catch(e) {
        // Non-fatal — log error but don't crash the whole sync
        console.error('GHL v2 API update error:', e.message);
      }
    }

    // --- STEP 7: Write readiness survey to Supabase ---
    // Records a Map 1 classification entry for every voice agent call
    // Used for analytics, routing history, and re-engagement campaigns
    // Only writes if we have a contactId from STEP 5
    if (SUPABASE_URL && SUPABASE_KEY && contactId) {
      try {
        const baseHeaders2 = {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        };

        const surveyData = {
          contact_id:   contactId,
          survey_id:    'voice-agent-intake',
          survey_name:  'Voice Agent Intake',
          survey_type:  'voice_agent',
          submission_id: 'vapi-' + Date.now(),
          submitted_at: new Date().toISOString(),
          source:       'voice_agent',
          answers: JSON.stringify({
            callerName,
            effectivePhone,
            profileType,
            investorStage,
            strategies:          strategiesArray,
            blocker,
            goals,
            summary,
            recommendedNextStep,
            // Path A = new/exploring investors needing education
            // Path B = active investors needing vendors or resources
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
        // Non-fatal — log but don't crash
        console.error('Readiness survey write error:', e.message);
      }
    }

    // Return success with GHL webhook status if available
    // ghlResp may be undefined if GHL_WEBHOOK_URL env var is not set
    return res.status(200).json({
      ok: true,
      ghlStatus: typeof ghlResp !== 'undefined' ? ghlResp.status : 'no_webhook'
    });

  } catch(e) {
    // Top-level catch — log full error and return 500
    // This should never fire if all inner try/catch blocks are working correctly
    console.error('ghl-sync error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}