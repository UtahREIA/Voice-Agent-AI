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

    // Stage map — defined here so it is available throughout the handler
    const ghlStageMap = {
      'Exploring':              'Exploring / New',
      'exploring':              'Exploring / New',
      'Getting Started':        'Getting Started',
      'getting_started':        'Getting Started',
      'Active Investor':        'Active Investor',
      'active':                 'Active Investor',
      'Experienced Investor':   'Experienced Investor',
      'experienced':            'Experienced Investor',
      'Veteran':                'Veteran / Operator',
      'veteran':                'Veteran / Operator',
      'Veteran / Operator':     'Veteran / Operator',
    };

    // =========================================================
    // DEDUPLICATION — Prevent processing the same call twice
    // Vapi sometimes sends end-of-call-report multiple times
    // Check voice_agent_calls table for existing vapi_call_id
    // =========================================================
    const vapiCallId = payload.message?.call?.id || payload.call?.id || null;

    const _SUPA_URL = process.env.SUPABASE_URL;
    const _SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

    if (vapiCallId && _SUPA_URL && _SUPA_KEY) {
      try {
        const dedupResp = await fetch(
          `${_SUPA_URL}/rest/v1/voice_agent_calls?vapi_call_id=eq.${encodeURIComponent(vapiCallId)}&select=id&limit=1`,
          {
            headers: {
              'Content-Type': 'application/json',
              'apikey': _SUPA_KEY,
              'Authorization': `Bearer ${_SUPA_KEY}`
            }
          }
        );
        const existing = await dedupResp.json();
        if (Array.isArray(existing) && existing.length > 0) {
          console.log(`Duplicate end-of-call-report detected for call ${vapiCallId} — skipping`);
          return res.status(200).json({ ok: true, skipped: true, reason: 'duplicate_call_id' });
        }
      } catch(e) {
        console.error('Dedup check error:', e.message);
        // Non-fatal — proceed with processing
      }
    }

    // =========================================================
    // PATH 2: END-OF-CALL-REPORT — Post-call sync pipeline
    // =========================================================

    // --- STEP 1: Extract structured outputs from Vapi ---
    // Vapi structured outputs are keyed by output ID (a UUID), each with { name, result }
    // We convert this to a simple name -> result map for easy access
    // Try all known Vapi payload paths for structured outputs
    const structuredOutputs =
      payload.message?.artifact?.structuredOutputs ||
      payload.artifact?.structuredOutputs ||
      payload.message?.analysis?.structuredOutputs ||
      payload.analysis?.structuredOutputs ||
      {};

    const structured = {};

    // Format 1: { uuid: { name, result } } — original format
    for (const key of Object.keys(structuredOutputs)) {
      const item = structuredOutputs[key];
      if (item?.name && item?.result !== undefined) {
        structured[item.name] = item.result;
      }
    }

    // Format 2: array of { name, result } — newer Vapi format
    if (Object.keys(structured).length === 0 && Array.isArray(structuredOutputs)) {
      for (const item of structuredOutputs) {
        if (item?.name && item?.result !== undefined) {
          structured[item.name] = item.result;
        }
      }
    }

    // Format 3: flat object { callerName: value, ... } — simplest format
    if (Object.keys(structured).length === 0 && payload.message?.artifact) {
      const art = payload.message.artifact;
      const knownFields = ['callerName','callerEmail','callerPhone','profileType','investorStage',
        'strategies','blocker','goals','summary','recommendedNextStep','tier','vendorMatches',
        'toolMatches','educatorMatch','bookingRequired','alreadyTried','handoffChannel',
        'stackSummary','commercialAssetTypes','wantsMentorConnection',
        'wantsProfessionalConnections','wantsOffMarketDeals'];
      for (const field of knownFields) {
        if (art[field] !== undefined) structured[field] = art[field];
      }
    }

    // Log full payload structure for debugging
    console.log('Payload keys:', JSON.stringify(Object.keys(payload.message || payload)));
    console.log('Artifact keys:', JSON.stringify(Object.keys(payload.message?.artifact || payload.artifact || {})));
    console.log('Structured data extracted:', JSON.stringify(structured));

    // =========================================================
    // VENDOR ENROLLMENT FORK (Path V)
    // =========================================================
    // A vendor who called in to enroll themselves is a different persona than
    // an investor. They are NOT matched to resources and they must NOT be written
    // to the vendor_resources object automatically. Instead we hold them on the
    // contact record with vendor answers plus a "Vendor Pending Review" tag, and
    // the post-call workflow notifies the team to vet them before promotion.
    //
    // Detection: profileType indicates vendor (and not primarily investor), or the
    // intake tier came back as the vendor enroll tier. profileType is the existing
    // Vapi structured output ("Whether the caller is an investor, vendor, or both"),
    // so we reuse it rather than adding a redundant caller_type output.
    // If this is a vendor, we run the vendor sync and return early so the investor
    // pipeline never touches them.
    const profileTypeRaw = (structured.profileType || structured.profile_type || '').toLowerCase();
    const isVendorCaller =
      structured.tier === 'vendor_enroll' ||
      (/vendor|service provider|provider/.test(profileTypeRaw) && !/investor/.test(profileTypeRaw));

    if (isVendorCaller) {
      console.log('Vendor caller detected — running vendor enrollment fork, skipping investor pipeline');

      const SUPABASE_URL_V = process.env.SUPABASE_URL;
      const SUPABASE_KEY_V = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
      const GHL_WEBHOOK_URL_V = process.env.GHL_WEBHOOK_URL;

      // Pull the vendor structured outputs. Accept both camelCase and snake_case
      // so this is resilient to however the Vapi outputs get named.
      const vName    = structured.callerName || structured.caller_name || '';
      const vService = structured.vendorServiceType     || structured.vendor_service_type     || '';
      const vTypes   = structured.vendorInvestorTypes   || structured.vendor_investor_types   || '';
      const vMarket  = structured.vendorMarket          || structured.vendor_market          || '';
      const vReia    = structured.vendorReiaConnection  || structured.vendor_reia_connection  || '';
      const vEnroll  = structured.vendorEnrollmentInterest || structured.vendor_enrollment_interest || '';
      const vFollow  = structured.vendorFollowUpPreference  || structured.vendor_follow_up_preference  || '';
      const vSummary = structured.stackSummary || structured.summary || '';

      // Resolve phone the same way the investor path does: structured output,
      // then the preCallPhone variable injected by index.html.
      const variableValuesV = payload.message?.call?.metadata?.variableValues
        || payload.message?.assistant?.variableValues
        || payload.call?.metadata?.variableValues
        || {};
      const rawVendorPhone = structured.callerPhone || structured.caller_phone || variableValuesV.preCallPhone || '';
      const vDigits = rawVendorPhone.replace(/\D/g, '').slice(-10);
      const vPhone = vDigits.length === 10 ? '+1' + vDigits : rawVendorPhone;

      const vNameParts = vName.trim().split(' ');
      const vFirst = vNameParts[0] || '';
      const vLast  = vNameParts.slice(1).join(' ') || '';

      // Skip if we cannot identify the vendor at all.
      if (!vName && !vPhone) {
        console.log('Vendor fork — no name or phone, skipping');
        return res.status(200).json({ ok: true, skipped: true, reason: 'vendor: no contact info' });
      }

      // Send to the GHL inbound webhook so the post-call workflow fires.
      // The "Vendor Pending Review" tag is what the workflow branches on to send
      // the internal team notification. va-vendor-enroll is a stable machine tag.
      let ghlRespV;
      try {
        if (GHL_WEBHOOK_URL_V) {
          ghlRespV = await fetch(GHL_WEBHOOK_URL_V, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              firstName: vFirst,
              lastName: vLast,
              phone: vPhone,
              // Flat fields for {{inboundWebhookRequest.*}} use in the workflow
              profileType: 'Vendor',
              vendorServiceType: vService,
              vendorInvestorTypes: vTypes,
              vendorMarket: vMarket,
              vendorReiaConnection: vReia,
              vendorEnrollmentInterest: vEnroll,
              vendorFollowUpPreference: vFollow,
              vendorSummary: vSummary.slice(0, 500),
              tags: [
                'Voice Agent Lead',
                'voice-agent-call-complete',
                'Vendor Pending Review',
                'va-vendor-enroll'
              ].filter(Boolean)
            })
          });
          console.log('Vendor GHL webhook sent:', ghlRespV.status);
        } else {
          console.log('Vendor fork — GHL_WEBHOOK_URL not set, skipping webhook');
        }
      } catch (e) {
        console.error('Vendor GHL webhook error:', e.message);
      }

      // Vendor custom fields are written by the GHL workflow, not here.
      // The workflow's Update Contact Field step maps every vendorServiceType,
      // vendorInvestorTypes, vendorMarket, vendorReiaConnection,
      // vendorEnrollmentInterest, vendorFollowUpPreference and vendorSummary
      // value from {{inboundWebhookRequest.*}} in the webhook payload above.
      //
      // We deliberately do NOT write them via the v2 API here. Most vendors are
      // brand new, so they do not exist in Supabase or GHL yet — the workflow's
      // Contact Not Found branch creates them ~30s after this webhook fires. Any
      // timed lookup from this function races that creation and fails ("contact
      // not found"). The workflow creates the contact and writes the fields in
      // the correct order with no race. These fields are all TEXT, so workflow
      // variables can set them (unlike SINGLE_OPTIONS/MULTIPLE_OPTIONS fields).


      // Record the vendor call in voice_agent_calls, tagged as a vendor call.
      try {
        if (SUPABASE_URL_V && SUPABASE_KEY_V) {
          const startedAtV = payload.message?.call?.startedAt || payload.call?.startedAt || null;
          const endedAtV   = payload.message?.call?.endedAt   || payload.call?.endedAt   || null;
          let durationV = null;
          if (startedAtV && endedAtV) {
            durationV = Math.round((new Date(endedAtV) - new Date(startedAtV)) / 1000);
          }
          await fetch(SUPABASE_URL_V + '/rest/v1/voice_agent_calls', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY_V,
              'Authorization': 'Bearer ' + SUPABASE_KEY_V,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              caller_name: vName,
              caller_phone: vPhone,
              profile_type: 'Vendor',
              path: 'V',
              tier: 'vendor_enroll',
              summary: vSummary,
              stack_summary: vSummary,
              vapi_call_id: vapiCallId,
              call_duration_secs: durationV,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          });
          console.log('Vendor call history written for:', vName);
        }
      } catch (e) {
        console.error('Vendor call history write error:', e.message);
      }

      // Return early. The investor pipeline below must not run for a vendor.
      return res.status(200).json({
        ok: true,
        vendor: true,
        ghlStatus: typeof ghlRespV !== 'undefined' ? ghlRespV.status : 'no_webhook'
      });
    }

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

    // --- VENDOR LOOKUP: fetch vendor phone for two-sided warm intro ---
    // When a vendor is matched during the call, we look up their contact in Supabase.
    // We join vendor_profiles to contacts to get the phone number since company_phone
    // is not yet populated on most vendor records — contact.phone is the reliable fallback.
    // The vendor gets an SMS intro with the caller's profile so they can follow up directly.
    let vendorPhone = '';
    let vendorEmail = '';
    let vendorWebsite = '';
    let vendorName = '';
    let vendorCompany = '';
    const matchedVendorName = structured.vendorMatches ? structured.vendorMatches.split(',')[0].trim() : '';

    if (matchedVendorName && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const supaHeaders = {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
        };

        // Search vendor_profiles by full_name matching the first word of the matched vendor name
        // Then join to contacts to get their phone number
        // Search ghl_vendor_resources (synced from GHL custom objects) by company name
        // This is now the source of truth for vendor phone numbers
        const firstWord = encodeURIComponent(matchedVendorName.split(' ')[0]);
        const vendorResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/ghl_vendor_resources?select=company_name,company_phone&company_name=ilike.*${firstWord}*&is_active=eq.true&limit=1`,
          { headers: supaHeaders }
        );
        const vendorData = await vendorResp.json();

        if (Array.isArray(vendorData) && vendorData.length > 0) {
          const vendor = vendorData[0];
          vendorName = vendor.company_name || matchedVendorName;
          vendorCompany = vendor.company_name || matchedVendorName;
          vendorPhone = vendor.company_phone || '';
          vendorEmail = vendor.company_email || '';
          vendorWebsite = vendor.company_website || '';

          // Format vendor phone as E.164 for GHL SMS delivery
          const vendorDigits = vendorPhone.replace(/\D/g, '').slice(-10);
          if (vendorDigits.length === 10) {
            vendorPhone = '+1' + vendorDigits;
          }

          console.log('Vendor found for warm intro:', vendorCompany, '| phone:', vendorPhone);
        } else {
          console.log('No vendor found in Supabase for:', matchedVendorName);
        }
      } catch(e) {
        console.error('Vendor lookup error:', e.message);
      }
    }

    // --- EDUCATOR BOOKING URL LOOKUP ---
    // When an educator is matched (educatorMatch structured output has a value),
    // look up their booking URL from Supabase education_resources and add it to
    // the GHL payload so the workflow can send the correct booking link via SMS.
    let educatorBookingUrl = structured.bookingUrl || '';
    const matchedEducatorName = structured.educatorMatch || '';

    if (matchedEducatorName && !educatorBookingUrl && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const firstWord = encodeURIComponent(matchedEducatorName.split(' ')[0]);
        // Use ghl_educators_mentors as source of truth for educator booking URLs
        const eduResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/ghl_educators_mentors?select=educators_url,educators_name&educators_name=ilike.*${firstWord}*&is_active=eq.true&limit=1`,
          {
            headers: {
              'Content-Type': 'application/json',
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
            }
          }
        );
        const eduData = await eduResp.json();
        if (Array.isArray(eduData) && eduData.length > 0 && eduData[0].educators_url) {
          educatorBookingUrl = eduData[0].educators_url;
          console.log('Educator booking URL resolved:', educatorBookingUrl);
        }
      } catch(e) {
        console.error('Educator booking URL lookup error:', e.message);
      }
    }

    // --- RESOURCE STACK LINKS (for the follow-up SMS) ---
    // resources.js cached the exact links getResourceStack delivered on this
    // call, keyed by vapi_call_id (voice_agent_stack_links). Read them back so
    // the SMS carries real links, not just a summary. This is deterministic and
    // does not depend on the per-resource structured outputs, which per CLAUDE.md
    // do not reliably emit.
    let stackLinks = '';
    if (vapiCallId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const linkResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/voice_agent_stack_links?vapi_call_id=eq.${encodeURIComponent(vapiCallId)}&select=sms_links&limit=1`,
          {
            headers: {
              'Content-Type': 'application/json',
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
            }
          }
        );
        const linkData = await linkResp.json();
        if (Array.isArray(linkData) && linkData[0]?.sms_links) stackLinks = linkData[0].sms_links;
        console.log('Resource stack links resolved:', stackLinks ? stackLinks.length + ' chars' : 'none');
      } catch(e) {
        console.error('Stack links lookup error:', e.message);
      }
    }

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
    // noMatch comes directly from Vapi structured output
    // Falls back to inferring from absence of matches if structured output not set
    // isNoMatch — only true when genuinely no resources were found
    // Check structured outputs AND stackSummary as a safety net
    const hasVendors   = structured.vendorMatches && structured.vendorMatches.length > 0;
    const hasEducator  = structured.educatorMatch && structured.educatorMatch.trim().length > 2;
    const hasTools     = structured.toolMatches && structured.toolMatches.length > 0;
    const hasStack     = structured.stackSummary && structured.stackSummary.trim().length > 20 &&
                         !structured.stackSummary.toLowerCase().includes('no recommendation') &&
                         !structured.stackSummary.toLowerCase().includes('ended before');
    const hasAnyMatch  = hasVendors || hasEducator || hasTools || hasStack;

    const isNoMatch = structured.noMatch === 'true' || structured.noMatch === true
      ? true
      : structured.noMatch === 'false'
        ? false
        : !hasAnyMatch; // only infer no-match when absolutely nothing was found
    const ghlPayload = {
      firstName,
      lastName,
      email:  callerEmail || '',
      phone:  effectivePhone,   // Formatted as E.164 e.g. +18082190555 — matches GHL storage format

      // Flat fields accessible in GHL workflow as {{inboundWebhookRequest.*}}
      // These must be top-level keys — nested fields like customFields[] are NOT
      // accessible via {{inboundWebhookRequest.*}} variables in GHL workflow steps
      investorStage,
      // Append booking URL to stack summary if educator was matched
      // This ensures the URL always appears in the SMS even if Claude omitted it
      stackSummary: (() => {
        let s = (structured.stackSummary || summary || '').slice(0, 300);
        const bookingUrl = educatorBookingUrl || structured.bookingUrl || '';
        const educatorName = structured.educatorMatch || '';
        // Append the educator booking URL only if it is not already carried by
        // the cached stack links below (avoids listing it twice).
        const bookingInLinks = bookingUrl && stackLinks.includes(bookingUrl);
        if (bookingUrl && s && !s.includes(bookingUrl) && !bookingInLinks) {
          s = s + (educatorName ? ' Book ' + educatorName + ': ' : ' Book here: ') + bookingUrl;
        }
        // Fold in the real resource links captured during the call so the SMS
        // delivers on Lani's "I will include the link in your follow-up message".
        if (stackLinks) {
          s = s + '\n\n' + stackLinks;
        }
        return s.slice(0, 900); // multi-segment SMS is fine; links must survive
      })(),
      alreadyTried:   structured.alreadyTried  || '',
      vendorMatches:  structured.vendorMatches || '',
      toolMatches:    structured.toolMatches   || '',
      educatorMatch:  structured.educatorMatch  || '',
      eventMatch:     structured.eventMatch     || '',
      bookingUrl:     educatorBookingUrl || structured.bookingUrl || '', // resolved from Supabase or structured output

      // ---- INVESTOR QUESTIONNAIRE TEXT FIELDS ----
      // These populate the same fields the GHL web form collects
      // Sent as top-level keys so GHL workflow can write them via Update Contact Field
      investorStageLabel: ghlStageMap[investorStage] || investorStage || '',
      investingInterests: strategiesArray.join(', ') || '',
      accomplishNext12:   goals || '',
      fundingNeeds:       blocker === 'capital' ? 'Private Money / Hard Money' : '',
      dealNeeds:          blocker === 'deals' ? 'Off Market Deals' : '',
      teamNeeds:          (blocker === 'team' || blocker === 'contractors') ? 'Contractors' : '',
      wantsMentor:        structured.bookingRequired === 'true' ? 'Yes' : '',
      wantsProfessionals: structured.vendorMatches ? 'Yes' : '',
      handoffChannel: structured.handoffChannel || 'sms',
      tier:           structured.tier           || '1_info',

      // ── INVESTOR QUESTIONNAIRE FIELDS ────────────────────────────────────
      // Populated from voice agent conversation — mirrors the GHL intake form
      // so the investor profile is complete whether they called or filled the form
      investingJourney:   ghlStageMap[investorStage] || investorStage || '',
      investingInterests: strategiesArray.slice(0, 3).join(', ') || '',
      accomplish6to12:    goals || '',
      whatDescribesYou:   profileType || '',
      wantsMentor:        structured.bookingRequired === 'true' ? 'Yes' : '',
      wantsProfessionals: structured.vendorMatches ? 'Yes' : '',

      // Vendor warm intro fields — used by GHL workflow to send parallel SMS to vendor
      // vendorPhone is the matched vendor's phone number from Supabase vendor_profiles
      // vendorName and vendorCompany identify the vendor in the workflow
      vendorPhone:    vendorPhone,
      vendorEmail:    vendorEmail,
      vendorWebsite:  vendorWebsite,
      vendorName:     vendorName,
      vendorCompany:  vendorCompany,
      strategies: strategiesArray.join(', '),
      blocker,
      goals,
      summary,
      recommendedNextStep,
      profileType,
      noMatch:         isNoMatch ? 'true' : 'false',
      bookingRequired: structured.bookingRequired || 'false',
      tier:            structured.tier            || '1_info',

      // Tags applied to the contact in GHL
      // voice-agent-call-complete triggers the post-call workflow
      // va-booking-required and va-vendor-matched removed — workflow checks custom fields directly
      // va-no-match fires when the agent could not find matching resources for the caller
      tags: [
        'Voice Agent Lead',
        'voice-agent-call-complete',
        isNoMatch ? 'va-no-match' : null,
        structured.tier         ? 'VA Tier: ' + structured.tier              : null,
        structured.educatorMatch ? 'VA Educator: ' + structured.educatorMatch : null,
        // va-vendor-matched tag removed — workflow now checks Voice Agent Vendor Matches field directly
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
        { id: 'Ed5YpSfkVwceWfnuDK8M', field_value: structured.tier          || '1_info' },      // Routing Tier
        { id: '192I9uLeuO0eFLRE9VLq', field_value: structured.vendorMatches || '' },  // Vendor Matches
        { id: 'gWwvq2pv8P6jcSGOZKa8', field_value: structured.toolMatches   || '' },  // Tool Matches
        { id: 's6q99vaJ472SDrn3lKfS', field_value: structured.eventMatch     || '' },  // Event Match
        { id: 'A6oIIJNzdW2MdVTYX9I5', field_value: structured.educatorMatch  || '' },  // Educator Match
        { id: 'OuoM1zSW9cwlMxpceERy', field_value: structured.bookingRequired || 'false' },     // Booking Required
        { id: 'stkOiKKMZh2H1EEBb47z', field_value: educatorBookingUrl || structured.bookingUrl || '' }, // Booking URL — resolved from Supabase
        { id: '6VsempNA8BBF65gPShrQ', field_value: structured.handoffChannel  || 'sms' }, // Handoff Channel
        { id: '4fpADU1aLMIF5GMW85bo', field_value: 'unknown' },                        // Vendor Contacted (default)
        { id: 'XLTxDRmto8uDjYhkeEsq', field_value: isNoMatch ? 'true' : 'false' },     // Voice Agent No Match

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

      // Look up existing contact by phone or email
      // Try multiple phone formats since Supabase stores phones in various formats
      // E.164 (+18082190555), formatted ((808) 219-0555), raw digits (8082190555)
      let existing = [];

      if (callerEmail) {
        existing = await fetch(
          `${SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(callerEmail)}&select=id&limit=1`,
          { headers: baseHeaders }
        ).then(r => r.json()).catch(() => []);
      }

      // Try formatted phone (XXX) XXX-XXXX — most common Supabase format
      if (!existing.length && callerPhoneDigits) {
        // Try formatted phone variants to match how GHL stores numbers
        const formattedPhone = '(' + callerPhoneDigits.slice(0,3) + ') ' + callerPhoneDigits.slice(3,6) + '-' + callerPhoneDigits.slice(6);
        existing = await fetch(
          `${SUPABASE_URL}/rest/v1/contacts?phone=eq.${encodeURIComponent(formattedPhone)}&select=id&limit=1`,
          { headers: baseHeaders }
        ).then(r => r.json()).catch(() => []);
      }

      // Try E.164 format (+1XXXXXXXXXX)
      if (!existing.length && effectivePhone) {
        existing = await fetch(
          `${SUPABASE_URL}/rest/v1/contacts?phone=eq.${encodeURIComponent(effectivePhone)}&select=id&limit=1`,
          { headers: baseHeaders }
        ).then(r => r.json()).catch(() => []);
      }

      // Try raw digits
      if (!existing.length && callerPhoneDigits) {
        existing = await fetch(
          // Fetch contacts and match by last 10 digits to handle format differences
          // e.g. "+1 912-168-1159" vs "9121681159" vs "(912) 168-1159"
          `${SUPABASE_URL}/rest/v1/contacts?select=id,phone&limit=5000`,
          { headers: baseHeaders }
        ).then(r => r.json()).then(all => {
          if (!Array.isArray(all)) return [];
          return all.filter(c => c.phone && c.phone.replace(/\D/g,'').slice(-10) === callerPhoneDigits);
        }).catch(() => []);
      }

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
        await new Promise(r => setTimeout(r, 8000)); // 8s — allows GHL workflow time to create new contacts

        const last10 = effectivePhone.replace(/\D/g,'').slice(-10);
        const v2Headers = {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        };

        // Look up GHL contact ID from Supabase first — faster and more reliable
        // than GHL's contacts search API which has phone format matching issues
        let contact = null;
        try {
          const sbContactResp = await fetch(
            `${SUPABASE_URL}/rest/v1/contacts?select=ghl_contact_id,full_name,phone&limit=5000`,
            { headers: baseHeaders }
          );
          const sbContacts = await sbContactResp.json();
          if (Array.isArray(sbContacts)) {
            const sbMatch = sbContacts.find(c =>
              c.phone && c.phone.replace(/\D/g,'').slice(-10) === last10
            );
            if (sbMatch?.ghl_contact_id) {
              contact = { id: sbMatch.ghl_contact_id };
              console.log('GHL v2 contact found via Supabase:', sbMatch.ghl_contact_id, '| name:', sbMatch.full_name);
            }
          }
        } catch(e) {
          console.error('Supabase contact lookup error:', e.message);
        }

        // Fallback — use GHL contacts search API if Supabase lookup failed
        if (!contact?.id) {
          try {
            const phoneFormatted = `+1 ${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}`;
            const searchResp = await fetch(
              `https://services.leadconnectorhq.com/contacts/?locationId=DNirEjy0ejVwbHsaBYrn&query=${encodeURIComponent(phoneFormatted)}`,
              { headers: v2Headers }
            );
            const searchData = await searchResp.json();
            const matches = searchData.contacts || [];
            const matched = matches.find(c => c.phone && c.phone.replace(/\D/g,'').slice(-10) === last10);
            if (matched) {
              contact = matched;
              console.log('GHL v2 contact found via search fallback:', contact.id);
            }
          } catch(e) {
            console.error('GHL v2 search fallback error:', e.message);
          }
        }

        if (!contact?.id) {
          console.log('GHL v2 contact not found for phone:', effectivePhone);
        }

        if (contact?.id) {
          // Map stage names to GHL SINGLE_OPTIONS picklist values
          // Map voice agent stage values to exact GHL picklist option labels
          // ghlStageMap defined at handler level above

          // Map strategy keys to exact GHL "What type of investing" picklist values
          const strategyToGHL = {
            'fix_and_flip':       'Fix & Flip',
            'buy_and_hold':       'Buy & Hold / Rentals',
            'brrrr':              'Buy & Hold / Rentals',
            'wholesale':          'Wholesaling',
            'wholesaling':        'Wholesaling',
            'short_term_rental':  'Short Term Rentals',
            'creative_financing': 'Creative Financing',
            'development':        'New Construction / Development',
            'notes_lending':      'Notes / Lending',
            'raising_capital':    'Syndication / Capital Raising',
            'syndication':        'Syndication / Capital Raising',
            'commercial':         'Commercial Real Estate',
            'multi_family':       'Commercial Real Estate',
            'not_sure':           "I'm not sure yet, I'm here to learn",
          };

          // Map goals to GHL "What are you trying to accomplish" picklist values
          const goalToGHL = {
            'first_deal':         'Close my first deal',
            'passive_income':     'Build passive income / cash flow',
            'portfolio':          'Build a real estate portfolio',
            'financial_freedom':  'Achieve financial freedom',
            'replace_income':     'Replace my W2 income',
            'scale':              'Scale my existing portfolio',
            'capital':            'Raise capital or private money',
            'connections':        'Connect with other investors',
            'education':          'Learn more about investing',
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
                  // ── VOICE AGENT FIELDS ──────────────────────────────────
                  { id: 'Ed5YpSfkVwceWfnuDK8M', field_value: structured.tier || '1_info' },
                  { id: 'OuoM1zSW9cwlMxpceERy', field_value: structured.bookingRequired || 'false' },
                  { id: '6VsempNA8BBF65gPShrQ', field_value: structured.handoffChannel || 'sms' },
                  { id: '4fpADU1aLMIF5GMW85bo', field_value: 'unknown' },
                  { id: 'XLTxDRmto8uDjYhkeEsq', field_value: isNoMatch ? 'true' : 'false' },

                  // ── INVESTOR QUESTIONNAIRE FIELDS ────────────────────────
                  // These fields mirror the GHL intake form — populated from
                  // voice agent conversation so the profile is complete whether
                  // the investor filled out the form or called in.

                  // Where are you in your investing journey? (SINGLE_OPTIONS)
                  { id: 'swDtahR8SAnG4S34s2a6', field_value: ghlStageMap[investorStage] || investorStage },

                  // Profile type (SINGLE_OPTIONS)
                  { id: 'mTmRVbyZKGqVXqHvhsX6', field_value: profileType },

                  // What type of investing are you most interested in? (MULTIPLE_OPTIONS)
                  // Map strategy key to exact GHL picklist label
                  ...(strategiesArray.length > 0 ? [{
                    id: 'hf9VEhcVwgyNXP3qbzsA',
                    field_value: strategyToGHL[strategiesArray[0]?.toLowerCase()] || strategiesArray[0]
                  }] : []),

                  // What are you trying to accomplish in the next 6 to 12 months? (MULTIPLE_OPTIONS)
                  ...(goals ? [{
                    id: 't150aKjUz1KvU183CtJw',
                    field_value: goals.split(',')[0].trim().slice(0, 100)
                  }] : []),

                  // Would you like us to connect you with a mentor? (SINGLE_OPTIONS)
                  ...(structured.bookingRequired === 'true' ? [{
                    id: 'kKWtIpls9sY2W4BZJMi8',
                    field_value: 'Yes'
                  }] : []),

                  // Would you like us to connect you with professionals? (SINGLE_OPTIONS)
                  ...(structured.vendorMatches ? [{
                    id: 'K0oXRPbezNJdlHutBGOa',
                    field_value: 'Yes'
                  }] : []),

                  // Would you like us to connect with other investors? (SINGLE_OPTIONS)
                  { id: 'lcemjR9gDTWWgKWrG7bU', field_value: 'Yes' },

                  // Funding & Financial needs (MULTIPLE_OPTIONS)
                  ...(blocker === 'capital' || structured.tier === '2_vendor' ? [{
                    id: 'A6d3LiW4tm4sRYgKkexW',
                    field_value: 'Private Money / Hard Money'
                  }] : []),

                  // Deals & Opportunities — set if blocker is deals or wholesale strategy
                  ...(blocker === 'deals' || (strategiesArray || []).some(s => s.toLowerCase().includes('wholesale')) ? [{
                    id: 'xRQGkFLJLgH0L3RQUxKF',
                    field_value: 'Off Market Deals'
                  }] : []),

                  // Team & Vendors — set if blocker is team or contractors
                  ...(blocker === 'team' || blocker === 'contractors' ? [{
                    id: 'oiMoxdyO8wHRWl8ECyug',
                    field_value: 'Contractors'
                  }] : []),

                  // Select Commercial Asset Types — set if strategy is commercial
                  ...((strategiesArray || []).some(s => ['commercial','multi_family','self_storage','assisted_living'].includes(s.toLowerCase())) ? [{
                    id: 'fSCzPFTuniRg0Lce2CCf',
                    field_value: strategiesArray.find(s => ['commercial','multi_family','self_storage','assisted_living'].includes(s.toLowerCase())) || 'Multi-Family'
                  }] : []),

                  // Do you want access to off-market opportunities?
                  ...(blocker === 'deals' ? [{
                    id: 'a51p8NV5scymqkF2sXbr',
                    field_value: 'Yes'
                  }] : []),

                  // Message field — call summary (LARGE_TEXT, can be set via v2 API)
                  ...(summary ? [{
                    id: 'TCCSXzunxUqJme5YtGSr',
                    field_value: summary.slice(0, 500)
                  }] : []),

                ].filter(f => f.field_value)
              })
            }
          );
          console.log('GHL v2 contact fields updated:', updateResp.status);

          // --- Clear stale vendor fields on non-vendor calls ---
          // The main PUT above filters out empty values, so it can never blank a
          // field. That means a vendor Service Type written on a PRIOR vendor call
          // would survive into a later investor call and wrongly trip the workflow's
          // "Vendor Service Type is not empty" branch. This second PUT explicitly
          // writes empty strings to the seven Voice Agent Vendor fields (no empty
          // filter) so every non-vendor call resets them. isVendorCaller was already
          // false to reach this block, so this only runs for investors.
          try {
            const clearResp = await fetch(
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
                    { id: 'ESvM4hhpSnQWiuluGard', field_value: '' }, // Voice Agent Vendor Service Type
                    { id: '1nvU9eGll7NYZ73YIR7e', field_value: '' }, // Voice Agent Vendor Investor Types
                    { id: 'vdrZr28gqAsDntrN6CPG', field_value: '' }, // Voice Agent Vendor Market
                    { id: 'kzolZI3cyPGf4THu00T0', field_value: '' }, // Voice Agent Vendor REIA Connection
                    { id: 'tvoRTYDCkAbIjslA7PGC', field_value: '' }, // Voice Agent Vendor Enrollment Interest
                    { id: 'ttt3eBFkIUjIqV6JBrpF', field_value: '' }, // Voice Agent Vendor Follow Up Preference
                    { id: 'IzhYTD89SrsXDUZFGxLK', field_value: '' }  // Voice Agent Vendor Summary
                  ]
                })
              }
            );
            console.log('GHL v2 stale vendor fields cleared:', clearResp.status);
          } catch(e) {
            console.error('GHL v2 vendor field clear error:', e.message);
          }
        } else {
          console.log('GHL v2 contact not found for phone:', effectivePhone);
        }
      } catch(e) {
        // Non-fatal — log error but don't crash the whole sync
        console.error('GHL v2 API update error:', e.message);
      }
    }

    // --- STEP 7: Write voice agent call history to Supabase ---
    // Stores every call in voice_agent_calls — dedicated to voice agent history.
    // NOTE: readiness_surveys is reserved for GHL form submissions only.
    // Writes for ALL callers regardless of whether contactId was resolved.
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const baseHeaders2 = {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        };

        // Calculate call duration from Vapi timestamps
        const callStartedAt = payload.message?.call?.startedAt || payload.call?.startedAt || null;
        const callEndedAt   = payload.message?.call?.endedAt   || payload.call?.endedAt   || null;
        let callDurationSecs = null;
        if (callStartedAt && callEndedAt) {
          callDurationSecs = Math.round((new Date(callEndedAt) - new Date(callStartedAt)) / 1000);
        }

        const callRecord = {
          contact_id:       contactId || null,
          caller_name:      callerName || '',
          caller_phone:     effectivePhone || '',
          // caller_email removed — emails not collected during voice calls
          investor_stage:   investorStage || '',
          profile_type:     profileType || '',
          path:             (investorStage === 'Exploring' || investorStage === 'Getting Started') ? 'A' : 'B',
          tier:             structured.tier || '1_info',
          strategies:       strategiesArray.length ? strategiesArray : null,
          blocker:          blocker || '',
          goals:            goals || '',
          already_tried:    structured.alreadyTried || '',
          summary:          summary || '',
          vendor_matches:   structured.vendorMatches || '',
          tool_matches:     structured.toolMatches || '',
          educator_match:   structured.educatorMatch || '',
          booking_url:      educatorBookingUrl || structured.bookingUrl || '',
          booking_required: structured.bookingRequired === 'true',
          stack_summary:    structured.stackSummary || summary || '',
          recommended_next: structured.recommendedNextStep || recommendedNextStep || '',
          handoff_channel:  structured.handoffChannel || 'sms',
          vendor_contacted: 'unknown',
          vapi_call_id:     payload.message?.call?.id || payload.call?.id || null,
          call_duration_secs: callDurationSecs,
          created_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString()
        };

        await fetch(`${SUPABASE_URL}/rest/v1/voice_agent_calls`, {
          method: 'POST',
          headers: baseHeaders2,
          body: JSON.stringify(callRecord)
        });
        console.log('Voice agent call history written for:', callerName);
      } catch(e) {
        console.error('Voice agent call history write error:', e.message);
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