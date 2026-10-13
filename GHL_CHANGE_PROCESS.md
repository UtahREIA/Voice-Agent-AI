# Catching GHL platform changes before they break us

Status: built 2026-10-13. Owner: David.

## Why this exists
GoHighLevel changes things behind the scenes, with no notice, and it has already broken
Utah REIA automations twice:
- The GHL Private Integration token was sunset on 2026-08-14, which killed the nightly
  GHL to Supabase sync. Nobody noticed for about seven weeks.
- A GHL endpoint change broke the Claude tool's contact lookups.

As more automations get built on GHL, the same two change types will keep biting:
1. **Token / endpoint changes** (a token is sunset, an endpoint moves or changes shape).
2. **Field-key drift** (a custom field is renamed or deleted, so its `fieldKey` changes and
   webhook bodies, routing, and queries silently stop matching with no error).

This process catches both quickly instead of discovering them when a caller complains.

## The process at a glance
Three layers: automated canaries catch the common breaks within a day, a short weekly human
review catches the rest, and a fix runbook says what to do when something fires.

### 1. Automated canaries (run daily, alert on failure)
| Canary | What it catches | Endpoint | Schedule |
| --- | --- | --- | --- |
| **GHL drift** | token sunset/revoke, `/contacts` shape change, missing critical custom-field keys | `/api/health-ghl` | daily 13:00 UTC |
| **Sync freshness** | nightly GHL to Supabase sync gone stale (the downstream symptom of a token/endpoint break) | `/api/health-sync` | 09:00 and 21:00 UTC |
| **ElevenLabs voice** | voice key invalid / voice clone unavailable | `/api/health-elevenlabs` | per its workflow |

Each has a GitHub Action in `.github/workflows/` that curls the endpoint and **fails the run
(email to repo admins, plus Slack if `SLACK_WEBHOOK_URL` is set) when `ok:false`**. A failed
check is the early warning.

**What `health-ghl` specifically asserts** (the critical field keys live in
`api/health-ghl.js` `CRITICAL_FIELD_KEYS`; add to that list whenever a new automation takes a
dependency on a field):
- the Private Integration token still authenticates,
- `GET /contacts` still returns a `contacts` array,
- every critical contact custom-field key still exists in GHL.

**Blind spot:** GHL custom *objects* (Vendor Partners, Educators & Mentors, Tools) return 403
from Vercel/Supabase IPs, so no server-side canary can check their fields. Those are covered
by the manual check below.

### 2. Weekly human review (about 10 minutes)
- **Watch GHL's changelog.** GHL publishes a developer/API changelog and in-app release
  notes. Skim them once a week for anything touching: custom fields, custom objects, the
  contacts API, webhooks/workflow actions, or Private Integration tokens. (Subscribe to the
  changelog so changes come to you.)
- **Spot-check the custom objects** the canary can't reach, using the GHL MCP in a Claude
  session: confirm the Vendor Partners object and its fields (e.g. `area_serviced`,
  the category fields) still resolve. Do this when the changelog mentions custom objects, or
  monthly otherwise.
- **Re-run the gap report** (`GAP_REPORT.md`) if the changelog mentions dropdown/option
  changes, to catch a renamed option value that would misroute callers.

### 3. When a canary fires — the fix runbook
- **`ghl_auth_failed`** (token): the Private Integration token was revoked or sunset. Generate
  a new token in GHL and update `GHL_API_KEY` in Vercel. This is the 2026-08-14 failure mode.
- **`ghl_shape_changed`** (endpoint): a GHL response no longer has the expected array. Find the
  code that reads it (the error names it, e.g. `ghl-sync.js` phone lookup reads `body.contacts`)
  and adjust to the new shape.
- **`ghl_fields_missing`** (field drift): the response lists the missing keys. Either restore
  the field name in GHL, or update the key everywhere code/webhook bodies reference it, then
  remove it from `CRITICAL_FIELD_KEYS` only if the field is genuinely retired.
- **`health-sync` stale but `health-ghl` ok**: the token is fine, so the break is downstream —
  check the sync workflow in GHL and the Supabase edge function logs.

## Keeping the process alive
- When you build a new GHL-dependent automation, add its critical field key(s) to
  `CRITICAL_FIELD_KEYS` in `api/health-ghl.js` so the canary guards them too.
- Keep `SLACK_WEBHOOK_URL` set as a repo secret so failures reach a channel, not just email.
- The canaries read GHL and Supabase directly and do **not** depend on the voice agent, so
  they keep reporting even when a call path is down.
