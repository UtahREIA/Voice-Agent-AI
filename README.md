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
           ├── /api/member-lookup — checks if returning member, injects profile
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
│   ├── context.js            # Pre-call liveContext loader (vendors, educators, events, tools)
│   ├── member-lookup.js      # Returning member recognition by phone number
│   ├── intake.js             # Map 1 routing — stage/strategy/blocker classification
│   ├── vendors.js            # Map 2 vendor matching with haversine zip code filtering
│   ├── education.js          # Map 3 education track matching
│   ├── caller-history.js     # Past call history for returning callers
│   ├── ghl-sync.js           # Post-call pipeline — Supabase + GHL sync
│   ├── member-history.js     # Deep history lookup (tools, events, profile)
│   ├── sync-ghl-objects.js   # Scheduled sync: pulls GHL custom objects → upserts to Supabase
│   ├── sync-educator.js      # Educator sync to ghl_educators_mentors
│   ├── claude.js             # Claude API wrapper
│   ├── knowledge.js          # Knowledge base query endpoint
│   ├── elevenlabs.js         # ElevenLabs voice API wrapper
│   ├── supabase.js           # Supabase client helper
│   └── transcribe.js         # Audio transcription endpoint
├── .github/
│   └── workflows/
│       └── sync-ghl-objects.yml  # GitHub Actions backup sync (runs nightly at 9:15 PM MDT)
├── public/
│   └── vapi-bundle.js        # Self-hosted Vapi SDK (@vapi-ai/web@2.5.2, daily-js 0.85.0)
├── index.html                # Voice agent widget page
├── vercel.json               # Vercel deployment config + cron schedule
└── package.json
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
| `endCall` | Built-in | Ends the call |

**Structured Outputs (22 fields):**
`callerName`, `callerEmail`, `callerPhone`, `profileType`, `investorStage`, `strategies`, `blocker`, `goals`, `summary`, `recommendedNextStep`, `tier`, `vendorMatches`, `toolMatches`, `educatorMatch`, `bookingRequired`, `alreadyTried`, `handoffChannel`, `stackSummary`, `commercialAssetTypes`, `wantsMentorConnection`, `wantsProfessionalConnections`, `wantsOffMarketDeals`

---

## Routing System

All routing uses live Supabase tables — no hardcoded logic in JS files.

### Map 1 — Intake Routing (`intake_routing_rules`)
- 167 active rules
- Classifies by `stage_key`, `strategy`, `blocker`, `path` (A/B/both)
- Returns `routing_action`: `getVendorMatch` | `getEducationMatch` | `ask_more` | `escalate`
- Scored by specificity — most specific rule wins

### Map 2 — Vendor Matching (`vendor_routing_matrix`)
- 554 active rules covering 31 investor needs × 32 strategies
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

Automatically pulls all records from four GHL custom objects and upserts them into matching Supabase tables so the voice agent always has fresh data to query.

| GHL Custom Object | Supabase Table |
|---|---|
| `custom_objects.vendor_resources` | `ghl_vendor_resources` |
| `custom_objects.educators_mentors` | `ghl_educators_mentors` |
| `custom_objects.educational_courses` | `ghl_educational_courses` |
| `custom_objects.tools_resources` | `ghl_tools_resources` |

### How It's Triggered

Two independent schedules run the sync automatically every night:

| Trigger | Time | Notes |
|---|---|---|
| Vercel Cron | 9:00 PM MDT (3:00 AM UTC) | Primary trigger via `vercel.json` |
| GitHub Actions | 9:15 PM MDT (3:15 AM UTC) | Backup trigger via `sync-ghl-objects.yml` |

Both triggers call `GET /api/sync-ghl-objects` with the `CRON_SECRET` authorization header. No manual intervention required.

### Manual Trigger

To run the sync immediately without waiting for the schedule, go to the GitHub repo > **Actions** tab > **Sync GHL Objects to Supabase** > **Run workflow**.

Or via terminal (PowerShell):

```powershell
Invoke-WebRequest -Uri "https://voice-agent-ai-nu.vercel.app/api/sync-ghl-objects" -Method GET -Headers @{ "Authorization" = "Bearer YOUR_CRON_SECRET" } | Select-Object -ExpandProperty Content
```

### Expected Response

```json
{
  "success": true,
  "duration_ms": 1786,
  "synced_at": "2026-06-18T11:32:47.688Z",
  "results": {
    "ghl_vendor_resources":    { "fetched": 13, "upserted": 13 },
    "ghl_educators_mentors":   { "fetched": 1,  "upserted": 1  },
    "ghl_educational_courses": { "fetched": 5,  "upserted": 5  },
    "ghl_tools_resources":     { "fetched": 2,  "upserted": 2  }
  }
}
```

### GHL Field Name Notes

- All vendor category fields append `_partner` to the key (e.g. `funding__financial_partner`, `deals__opportunities_partner`)
- Social link fields use the `social_profile_links_` prefix (e.g. `social_profile_links_facebook`)
- Boolean fields are returned as arrays containing the string `"true"` (e.g. `enroll_vendor_match: ["true"]`)
- File/image fields (e.g. `company_logo`) are returned as arrays of objects with a `url` property — the sync extracts the URL automatically
- The object displays as "Vendor Partners" in GHL UI but the immutable key remains `custom_objects.vendor_resources`

---

## Post-Call Pipeline (`ghl-sync.js`)

Triggered by Vapi end-of-call-report to the server URL. Steps:

1. Deduplicate via `vapi_call_id` — prevents double-processing
2. Extract all 22 structured outputs from Vapi payload
3. Phone number — 3-tier fallback (structured → liveContext → Vapi call object)
4. Vendor lookup from `ghl_vendor_resources`
5. Educator booking URL from `ghl_educators_mentors`
6. Append booking URL to `stackSummary` if omitted
7. Fire GHL inbound webhook → triggers post-call SMS workflow
8. GHL v2 API update (4s delay) — sets all SINGLE/MULTIPLE_OPTIONS fields
9. Write complete call record to `voice_agent_calls` table

### GHL v2 API Note
`MULTIPLE_OPTIONS` and `SINGLE_OPTIONS` custom fields **cannot** be set via webhook payload variables or workflow Update Contact Field steps. They must use the GHL v2 API with the Private Integration Token.

---

## Supabase Tables (23 active)

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
| `vendor_routing_matrix` | 554 | Map 2 vendor matching |
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
| `survey_definitions` | 11 | Survey ID to type mapping |
| `app_settings` | 5 | Configurable system parameters |
| `event_routing_members` | 4,675 | In use by GHL workflows — do not drop |

---

## Supabase Edge Functions

### `ghl-webhook` (v15)
Receives all GHL contact and survey data from the GHL to Claude via Supabase workflow.
- Upserts into: `contacts`, `investor_profiles`, `vendor_profiles`, `tool_access`, `event_attendance`, `readiness_surveys`
- Maps all 11 survey IDs to survey types
- Fixed column names matching actual `investor_profiles` schema

### `routing-trigger` (v2)
Runs Map 1 → Map 2/3 routing for non-voice contacts (surveys, field changes).
- Triggered by Supabase DB webhooks on `readiness_surveys` INSERT and `investor_profiles` UPDATE
- Writes to `routing_results` table
- **Does NOT fire the voice agent GHL webhook** — uses `SURVEY_ROUTING_WEBHOOK_URL` env var only
- v1 bug: was hardcoded with voice agent webhook causing SMS spam to random contacts

---

## GHL Workflows

### GHL to Claude via Supabase
- Triggers: Contact Created + Contact Changed + 11 × Survey Submitted
- Action: POST to `ghl-webhook` Supabase edge function
- Each survey has its own webhook action with hardcoded `survey_id` in body JSON
- `submitted_at` uses `{{right_now.date}}` (not `{{now}}` — invalid in GHL)

### Voice Agent Post-Call Workflow
- Trigger: Inbound webhook `d0a34baf-4e42-4a96-8f77-e6b99df93060`
- Called exclusively by `ghl-sync.js` after every voice agent call
- Steps: Find Contact by phone → Update Fields → SMS with stackSummary → Add Tag
- Re-enrollment: OFF

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

## Environment Variables

Set these in Vercel project settings under **Environment Variables**:

| Variable | Description |
|---|---|
| `CRON_SECRET` | Shared secret used to authorize cron and manual sync calls |
| `GHL_API_KEY` | GHL Private Integration API key |
| `GHL_LOCATION_ID` | GHL location ID (`DNirEjy0ejVwbHsaBYrn`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |

Set these in GitHub repo settings under **Settings > Secrets and variables > Actions**:

| Secret | Description |
|---|---|
| `CRON_SECRET` | Same value as the Vercel one |
| `VERCEL_SYNC_URL` | Full URL to the sync endpoint (`https://voice-agent-ai-nu.vercel.app/api/sync-ghl-objects`) |

---

## GitHub Collaborator Notes

The GitHub repo must remain **public** for Vercel to accept deployments from collaborator accounts on the Hobby plan. Vercel's free plan only allows collaboration on public repositories. Making the repo private will cause Vercel to block automatic redeployments from non-owner accounts.

---

## Vapi SDK Note

The self-hosted bundle at `public/vapi-bundle.js` is built from `@vapi-ai/web@2.5.2` with `daily-js 0.85.0`. The balacodeio CDN bundle has deprecated `daily-js` versions that Vapi servers reject. Always load from the self-hosted bundle first.

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

- **Upsert pattern:** `POST /rest/v1/{table}?on_conflict=ghl_record_id` with `Prefer: resolution=merge-duplicates,return=minimal` — the `on_conflict` query param is required; the `Prefer` header alone does not prevent 409 errors
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
