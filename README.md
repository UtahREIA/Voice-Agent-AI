# Utah REIA Voice Agent AI

> AI-powered voice assistant for Utah's largest real estate investor association. Routes investors to the right vendors, educators, and resources through live voice calls, readiness surveys, and investor profile matching.

---

## Live URLs

| Resource | URL |
|---|---|
| Voice Agent Page | https://utahreia.org/voice-agent-ai-page |
| Vercel Deployment | https://voice-agent-ai-nu.vercel.app |
| Property Listings | https://utahreia.org/property-listing |

---

## Architecture

```
Caller → index.html (GHL Funnel)
           ├── /api/context       — loads liveContext (vendors, educators, events, tools)
           ├── /api/member-lookup — checks if returning member, injects profile + last call
           └── Vapi Web SDK (self-hosted at /public/vapi-bundle.js)
                    │
                    ▼
              Vapi Assistant (claude-haiku-4-5)
                    │
         ┌──────────┼──────────┐
         │          │          │
    /api/intake  /api/vendors  /api/education
    /api/caller-history
                    │
                    ▼
              /api/ghl-sync  (post-call)
         ┌──────────┼──────────┐
         │          │          │
    Supabase    GHL Webhook   GHL v2 API
  voice_agent    (workflow)   (custom fields)
    _calls
```

---

## Repository Structure

```
Voice-Agent-AI/
├── api/
│   ├── context.js            # Pre-call liveContext loader — queries ghl_upcoming_events for strategy-matched events
│   ├── member-lookup.js      # Returning member recognition by phone — returns profile + last_call data
│   ├── intake.js             # Map 1 routing — stage/strategy/blocker classification
│   ├── vendors.js            # Map 2 vendor matching with haversine zip code filtering
│   ├── education.js          # Map 3 education track matching
│   ├── caller-history.js     # Past call history for returning callers (mid-call tool)
│   ├── ghl-sync.js           # Post-call pipeline — Supabase + GHL sync + vendor notification payload
│   ├── member-history.js     # Deep history lookup (tools, events, profile)
│   ├── member-profile.js     # Mid-call member lookup tool (fallback if phone not entered pre-call)
│   ├── sync-ghl-objects.js   # Dual handler: POST = GHL webhook receiver, GET = nightly event sync
│   ├── sync-educator.js      # Educator sync to ghl_educators_mentors
│   ├── supabase.js           # Supabase client helper
├── .github/
│   └── workflows/
│       └── sync-ghl-objects.yml  # GitHub Actions backup sync (runs nightly at 9:15 PM MDT)
├── public/
│   └── vapi-bundle.js        # Self-hosted Vapi SDK (@vapi-ai/web@2.5.2, daily-js 0.85.0)
├── index.html                # Voice agent widget page
├── vercel.json               # Vercel deployment config
├── package.json              # Must include "type": "module" for ESM support on Vercel
└── README.md
```

---

## Key Identifiers

| Resource | Value |
|---|---|
| Supabase Project ID | `kttzxjddtkgsitzehiid` |
| Supabase URL | `https://kttzxjddtkgsitzehiid.supabase.co` |
| GHL Location ID | `DNirEjy0ejVwbHsaBYrn` |
| Vapi Assistant ID | `92018c4f-f382-41b9-80e0-c46e8f2b505a` |
| Vapi Voice | ElevenLabs `Xi53u0N6awPQcGCxrwD3` (Harmonie Borden clone) |
| Vapi Server URL | `https://voice-agent-ai-nu.vercel.app/api/ghl-sync` |
| Vapi End Call Message | `Mahalo.` |

---

## Vapi Configuration

**Model:** `claude-haiku-4-5-20251001` | **Max Tokens:** 150

**Tools (all synchronous — async OFF):**

| Tool | Endpoint | Purpose |
|---|---|---|
| `getIntakeRouting` | `/api/intake` | Map 1 — classifies investor, returns routing action |
| `getVendorMatch` | `/api/vendors` | Map 2 — matches vendors by need + zip distance |
| `getEducationMatch` | `/api/education` | Map 3 — matches education track + educator |
| `getCallerHistory` | `/api/caller-history` | Returns past call history for returning callers |
| `endCall` | Built-in | Ends the call. End Call Message set to "Mahalo." |

**Structured Outputs (22 fields):**
`callerName`, `callerEmail`, `callerPhone`, `profileType`, `investorStage`, `strategies`, `blocker`, `goals`, `summary`, `recommendedNextStep`, `tier`, `vendorMatches`, `toolMatches`, `educatorMatch`, `bookingRequired`, `alreadyTried`, `handoffChannel`, `stackSummary`, `commercialAssetTypes`, `wantsMentorConnection`, `wantsProfessionalConnections`, `wantsOffMarketDeals`

---

## Pre-Call Flow (index.html)

1. Caller enters phone number and clicks Begin Journey
2. `/api/context` loads liveContext (vendors, educators, courses, tools, events with strategy tags, property listing URL)
3. `/api/member-lookup` checks if the number matches a contact in Supabase
4. If returning member found — injects profile + last call data into liveContext
5. `firstMessage` is set dynamically:
   - **Returning member with past call history** → personalized follow-up: "Aloha [name], welcome back... I recommended [last stack_summary]. How did that go?"
   - **Returning member, no meaningful call history** → "Aloha [name], glad you reached out. How can I help you today?"
   - **New caller** → "Aloha, welcome to Utah REIA. How can I help you today?"
6. Vapi SDK loads from self-hosted bundle (`/vapi-bundle.js`) first, falls back to CDN
7. liveContext truncated to 8,000 characters — Mahalo closing rule prepended so it is never truncated
8. Reconnect button shown automatically if call drops due to network issues

**Meaningful call filter (`member-lookup.js`):**
Skips calls with stack_summary containing: "no recommendations", "intake was in progress", "ended before", "call ended", "not delivered", "unable to", "no result", "did not complete", "incomplete". Only picks calls with a clean summary > 30 chars, matched educator, or matched vendors.

---

## Routing System

All routing uses live Supabase tables — no hardcoded logic in JS files.

### Map 1 — Intake Routing (`intake_routing_rules`)
- 167 active rules
- Classifies by `stage_key`, `strategy`, `blocker`, `path` (A/B/both)
- Returns `routing_action`: `getVendorMatch` | `getEducationMatch` | `ask_more` | `escalate`
- Scored by specificity — most specific rule wins

### Map 2 — Vendor Matching (`vendor_routing_matrix`)
- 554 active rules covering 31 investor needs × 32 strategies (26 active strategies)
- Geographic filtering via haversine distance from caller zip (zippopotam.us API)
- Radius configurable via `app_settings.vendor_match_radius_miles` (default 100 miles)
- Vendor scoring: zip match → city match → within radius → statewide → national

### Map 3 — Education Matching (`education_routing_matrix`)
- 80 active rows covering 5 stages × 16 strategies
- Three-tier fallback: exact stage+strategy → stage only → strategy only
- Returns track name, resource titles, delivery methods, educator booking URL

---

## GHL to Supabase Sync

### What It Does

Automatically pulls records from GHL custom objects and event slots, upserts them into Supabase tables so the voice agent always has fresh data.

| Source | Supabase Table |
|---|---|
| `custom_objects.vendor_resources` | `ghl_vendor_resources` |
| `custom_objects.educators_mentors` | `ghl_educators_mentors` |
| `custom_objects.educational_courses` | `ghl_educational_courses` |
| `custom_objects.tools_resources` | `ghl_tools_resources` |
| GHL Custom Values (event slots 1-9) | `ghl_upcoming_events` |

### How It's Triggered

Two independent schedules run the sync automatically every night:

| Trigger | Time | Notes |
|---|---|---|
| Vercel Cron | 9:00 PM MDT (3:00 AM UTC) | Primary trigger via `vercel.json` |
| GitHub Actions | 9:15 PM MDT (3:15 AM UTC) | Backup trigger via `sync-ghl-objects.yml` |

Both call `GET /api/sync-ghl-objects` with the `CRON_SECRET` authorization header.

### Manual Trigger

Go to GitHub repo > **Actions** tab > **Sync GHL Objects to Supabase** > **Run workflow**.

Or via PowerShell:

```powershell
Invoke-WebRequest -Uri "https://voice-agent-ai-nu.vercel.app/api/sync-ghl-objects" -Method GET -Headers @{ "Authorization" = "Bearer YOUR_CRON_SECRET" } | Select-Object -ExpandProperty Content
```

### Event Strategy Auto-Detection

`sync-ghl-objects.js` reads the event title and subtitle from each GHL custom value slot and auto-detects relevant strategies using keyword matching. Results are stored in `ghl_upcoming_events.strategies[]`. `context.js` queries this table and includes `Relevant for: wholesale, fix_and_flip` per event in liveContext so Claude can match events to callers accurately.

**Supported strategy keywords (15 strategies):**
`fix_and_flip`, `wholesale`, `buy_and_hold`, `brrrr`, `short_term_rental`, `creative_financing`, `development`, `multi_family`, `commercial`, `raising_capital`, `notes_lending`, `house_hacking`, `land`, `out_of_state`, `tax_deeds_liens`

**Event type detection:** `main`, `mid_day`, `wreia`, `virtual`, `latino`, `true_wealth`, `meetup`, `commercial`, `workshop`

### Important: `package.json` Must Include `"type": "module"`

All API files use ESM (`export default`). Without `"type": "module"` in `package.json`, Vercel tries to convert ESM to CommonJS at runtime and fails with "Invalid export found in module". The fix is permanent in the repo but must not be removed.

---

## Post-Call Pipeline (`ghl-sync.js`)

Triggered by Vapi end-of-call-report to the server URL. Steps:

1. Deduplicate via `vapi_call_id` — prevents double-processing from duplicate Vapi events
2. Extract all 22 structured outputs (3-format fallback: UUID map → array → flat object)
3. Phone number — 3-tier fallback (structured → liveContext CALLER_PHONE tag → Vapi call object)
4. Vendor lookup from `ghl_vendor_resources` — resolves `vendorPhone`, `vendorEmail`, `vendorWebsite`, `vendorName`
5. Educator booking URL from `ghl_educators_mentors`
6. Append booking URL to `stackSummary` if omitted by Claude
7. Fire GHL inbound webhook → triggers Voice Agent Post-Call Workflow
8. GHL v2 API update (4s delay) — sets all SINGLE/MULTIPLE_OPTIONS fields
9. Write complete call record to `voice_agent_calls` table

### Webhook Payload Fields (available as `{{inboundWebhookRequest.*}}` in GHL)

| Field | Description |
|---|---|
| `vendorName` | Matched vendor company name |
| `vendorPhone` | Matched vendor phone number |
| `vendorEmail` | Matched vendor company email |
| `vendorWebsite` | Matched vendor company website |
| `educatorMatch` | Matched educator name |
| `bookingUrl` | Educator booking URL |
| `stackSummary` | Full recommendation summary |
| `strategies` | Investor strategies |
| `blocker` | Main investor blocker |
| `goals` | Investor goals |
| `tier` | Routing tier (1_info / 2_vendor / 3_educator / 2_and_3) |
| `investorStage` | Investor stage |

### GHL v2 API Note
`MULTIPLE_OPTIONS` and `SINGLE_OPTIONS` custom fields **cannot** be set via webhook payload variables or workflow Update Contact Field steps. They must use the GHL v2 API with the Private Integration Token.

---

## Supabase Tables (24 active)

| Table | Rows | Purpose |
|---|---|---|
| `contacts` | 4,979 | All GHL contacts |
| `investor_profiles` | 4,920 | Investor questionnaire data |
| `vendor_profiles` | 4,920 | Vendor service data |
| `tool_access` | 4,920 | Calculator access dates |
| `event_attendance` | Growing | Event attendance per contact |
| `readiness_surveys` | 109+ | GHL survey submissions |
| `voice_agent_calls` | Growing | Voice agent call history |
| `routing_results` | Growing | Non-voice routing events |
| `intake_routing_rules` | 167 | Map 1 routing rules |
| `vendor_routing_matrix` | 554 | Map 2 vendor matching (26 active strategies) |
| `education_routing_matrix` | 80 | Map 3 education tracks |
| `tools_routing_matrix` | 11 | Calculator recommendations |
| `blocker_service_mapping` | 40 | Blocker to service type |
| `strategy_crosswalk` | 26 | Strategy key normalization |
| `intake_questions` | 21 | Voice agent question bank |
| `intake_stages` | 5 | Investor stage definitions |
| `ghl_vendor_resources` | 13 | Synced vendor records (auto-updated nightly) |
| `ghl_educators_mentors` | 1 | Synced educator records (auto-updated nightly) |
| `ghl_educational_courses` | 5 | Synced course records (auto-updated nightly) |
| `ghl_tools_resources` | 2 | Synced tool records (auto-updated nightly) |
| `ghl_upcoming_events` | 9 | Event slots synced from GHL custom values (auto-updated nightly) |
| `survey_definitions` | 11 | Survey ID to type mapping |
| `app_settings` | 5 | Configurable system parameters |
| `event_routing_members` | 4,675 | In use by GHL workflows — do not drop |

---

## Supabase Edge Functions

### `ghl-webhook` (v15)
Receives all GHL contact and survey data from the GHL to Claude via Supabase workflow.
- Upserts into: `contacts`, `investor_profiles`, `vendor_profiles`, `tool_access`, `event_attendance`, `readiness_surveys`
- Maps all 11 survey IDs to survey types

### `routing-trigger` (v2)
Runs Map 1 → Map 2/3 routing for non-voice contacts (surveys, field changes).
- Triggered by Supabase DB webhooks on `readiness_surveys` INSERT and `investor_profiles` UPDATE
- Writes to `routing_results` table
- **Does NOT fire the voice agent GHL webhook** — uses `SURVEY_ROUTING_WEBHOOK_URL` env var only
- v1 bug: was hardcoded with voice agent webhook causing SMS spam to random contacts

---

## GHL Workflows

### GHL to Claude via Supabase
- Triggers: Contact Created + Contact Changed + 11 × Survey Submitted (separate trigger per survey)
- Action: POST to `ghl-webhook` Supabase edge function
- Each survey has its own webhook action with hardcoded `survey_id` in body JSON
- `submitted_at` uses `{{right_now.date}}` (not `{{now}}` — invalid in GHL)

### Voice Agent Post-Call Workflow
- Trigger: Inbound webhook `d0a34baf-4e42-4a96-8f77-e6b99df93060`
- Called exclusively by `ghl-sync.js` after every voice agent call
- Flow:
  1. Find Contact by phone → Contact Found / Contact Not Found branches
  2. Wait → Update Contact Fields → Wait → Add Tag (`Voice Agent Lead`) → Wait 5 min
  3. Resource Stack SMS → **If Voice Agent Vendor Matches is not empty**
     - Branch (vendor matched): Notify Vendor (Internal Notification email to `{{inboundWebhookRequest.vendorEmail}}`) → Wait → SMS to Caller (includes `{{inboundWebhookRequest.vendorWebsite}}`)
     - None: **If Voice Agent Booking Required = true**
       - Branch (booking required): Educator Booking SMS → Wait 2 days → 48-hour follow-up → Remove Tag
       - None: END
- Re-enrollment: OFF
- **Note:** Tags (`va-vendor-matched`, `va-booking-required`) removed. Workflow checks custom fields directly.

### Survey Routing Workflow *(pending Chris Borden approval to publish)*
- Trigger: Inbound webhook `3734177a-a056-41cb-8580-fb447418d526`
- Steps: Check triggerSource → Wait 5 min → Check stackSummary → Find Contact → SMS → Add Tag `survey-routing-complete`
- Re-enrollment: OFF

---

## GHL Survey IDs

| Survey | ID | Type |
|---|---|---|
| BRRRRR Readiness Survey | `8CzJrtK4SZ8KuOFkpc9q` | `brrrr` |
| Build Scope AI Estimator | `59rKPVr4G72h4gLEiHfB` | `buildscope` |
| Fix & Flip Readiness | `j60aT4pN9PyQON8Pnn9r` | `fix_flip` |
| Rental Readiness | `CmCuA7NQQSvbIHdpirxt` | `rental` |
| Short Term Readiness | `YGYxMg8ULW64gjhQDhP1` | `short_term` |
| Wholesaler Readiness | `vnMfd0K5soW0Ob2yIO64` | `wholesale` |
| Your Path to Success | `9RTgEIeNcHvWBZkqUZKl` | `path_to_success` |
| Event Register New | `ktDhoCZJC1erRWjzcJGB` | `event_roster` |
| Event Register Free Events | `ey3blG1MMg54GLPQLJIc` | `event_roster_free` |
| Event Roster Virtual | `OtlsyMRStvmrwyEYxaZx` | `event_roster_virtual` |
| Vendor Readiness Survey | `XWJdSkA6qxctH9imv6U4` | `vendor` |

---

## Enrolled Vendors (Vendor Notification Enabled)

These vendors have `enroll_vendor_match = true` and receive an email when matched to a caller:

| Vendor | Email | Website |
|---|---|---|
| REIPrintMail | smullen@reiprintmail.com | https://app.reiprintmail.com/launch/UTAHREIA |
| CamaPlan | mmoore@camaplan.com | https://www.camaplan.com |

---

## Environment Variables

Set in Vercel project settings:

| Variable | Description |
|---|---|
| `CRON_SECRET` | Shared secret for cron and manual sync calls |
| `GHL_API_KEY` | GHL Private Integration API key |
| `GHL_LOCATION_ID` | GHL location ID (`DNirEjy0ejVwbHsaBYrn`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |

Set in GitHub repo secrets:

| Secret | Description |
|---|---|
| `CRON_SECRET` | Same value as the Vercel one |
| `VERCEL_SYNC_URL` | `https://voice-agent-ai-nu.vercel.app/api/sync-ghl-objects` |

---

## GitHub Collaborator Notes

The GitHub repo must remain **public** for Vercel to accept deployments from collaborator accounts on the Hobby plan. Making the repo private will cause Vercel to block automatic redeployments from non-owner accounts.

---

## Vapi SDK Note

The self-hosted bundle at `public/vapi-bundle.js` is built from `@vapi-ai/web@2.5.2` with `daily-js 0.85.0`. Always load from the self-hosted bundle first.

Add to GHL funnel head tracking code:
```html
<script src="https://voice-agent-ai-nu.vercel.app/vapi-bundle.js"></script>
```

---

## Configurable Settings

Change via SQL in Supabase — no code deploy needed:

```sql
-- Change vendor search radius
UPDATE app_settings SET value = '150' WHERE setting_key = 'vendor_match_radius_miles';

-- Check current settings
SELECT setting_key, value, description FROM app_settings;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           
```

---

## Supabase Patterns

- **Upsert pattern:** `POST /rest/v1/{table}?on_conflict=ghl_record_id` with `Prefer: resolution=merge-duplicates,return=minimal`
- Records are never deleted — the sync only inserts new records and updates existing ones
- Array columns require explicit `::text[]` cast in raw SQL
- `strategy_crosswalk.id` is `GENERATED ALWAYS AS IDENTITY` — omit on insert

---

## Pending Items

- [ ] Publish Survey Routing Workflow (pending Chris Borden approval)
- [ ] Add Dr. Jason Williams and Jeremy Davis to GHL and sync to Supabase
- [ ] ElevenLabs Creator plan upgrade for Harmonie voice clone
- [ ] Path V (vendor callers) — system prompt, intake routing rules, GHL workflow branch
- [ ] Post-call follow-up tracking — 72-hour check-in SMS
- [ ] Dashboard for Chris — call volume, top blockers, routing distribution
- [ ] Multi-language support (Spanish path)
- [ ] Inbound SMS routing
- [ ] Test vendor email notification end to end (REIPrintMail / CamaPlan)
- [ ] Upgrade vapi-bundle.js when daily-js 0.85.0 is fully deprecated

---

## Team

| Name | Role |
|---|---|
| Chris Borden | Decision maker, strategy approval |
| Harmonie Borden | Brand voice, operations, marketing |
| David Igberi | Tech lead — GHL, Supabase, Vercel, Vapi |
| Angela | Communications |
| Bebe | Design, Canva |

---

*Utah Real Estate Investors Association — utahreia.org*
