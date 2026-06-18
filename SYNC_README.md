# GHL to Supabase Sync - File Guide

These are the files from the previous Claude session that need to be added to the Voice-Agent-AI GitHub repo.

---

## Files to add

### 1. `api/sync-ghl-objects.js`
Place at the root of the repo under `api/`.

This is the Vercel serverless function that:
- Pulls all records from 4 GHL custom objects (vendor_resources, educators_mentors, educational_courses, tools_resources)
- Upserts them into the 4 matching Supabase tables (ghl_vendor_resources, ghl_educators_mentors, ghl_educational_courses, ghl_tools_resources)
- Returns a summary of what was fetched and upserted per table
- Is protected by CRON_SECRET so only Vercel (and GitHub Actions) can trigger it

### 2. `vercel.json`
Merge this into your existing vercel.json (do not replace it entirely if you have other config in there).

Add the `crons` block to your existing vercel.json:
```json
"crons": [
  {
    "path": "/api/sync-ghl-objects",
    "schedule": "0 3 * * *"
  }
]
```

This tells Vercel to call the sync endpoint every day at 3:00 AM UTC.

### 3. `.github/workflows/sync-ghl-objects.yml`
Place at `.github/workflows/sync-ghl-objects.yml` in the repo.

This GitHub Actions workflow:
- Also runs the sync daily at 3:15 AM UTC (15 min offset from Vercel cron as a safety net)
- Can be triggered manually from the GitHub Actions tab
- Does NOT depend on who pushed code, so it bypasses the Vercel collaborator issue entirely

---

## Environment variables needed in Vercel

Go to: Vercel project > Settings > Environment Variables

Add these if not already present:

| Variable | Value |
|---|---|
| `CRON_SECRET` | Already added (the secret you set) |
| `GHL_API_KEY` | Your GHL private integration API key |
| `GHL_LOCATION_ID` | `DNirEjy0ejVwbHsaBYrn` |
| `SUPABASE_URL` | `https://kttzxjddtkgsitzehiid.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service_role key |

---

## GitHub Secrets needed for the Actions workflow

Go to: GitHub repo > Settings > Secrets and variables > Actions

Add:

| Secret | Value |
|---|---|
| `CRON_SECRET` | Same value as the Vercel one |
| `VERCEL_SYNC_URL` | The full URL to the endpoint, e.g. `https://your-project.vercel.app/api/sync-ghl-objects` |

---

## Fixing the Vercel collaborator deployment issue

The Actions workflow above already helps because it can deploy independently. But to fully fix
the Vercel blocking issue for code pushes, Chris (the Vercel account owner) needs to do ONE of:

**Option A (easiest):** In Vercel project > Settings > Git > Deployment Protection,
disable "Protect Production Deployments" or add David's GitHub username to the trusted list.

**Option B:** In Vercel team settings, add David as a team member so his pushes are trusted.

---

## How to test manually after deploying

Once the files are pushed and Vercel deploys, test by calling:

```
curl -X GET \
  -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://your-project.vercel.app/api/sync-ghl-objects
```

Expected response (success):
```json
{
  "success": true,
  "duration_ms": 2341,
  "results": {
    "ghl_vendor_resources": { "fetched": 13, "upserted": 13 },
    "ghl_educators_mentors": { "fetched": 1, "upserted": 1 },
    "ghl_educational_courses": { "fetched": 5, "upserted": 5 },
    "ghl_tools_resources": { "fetched": 2, "upserted": 2 }
  }
}
```
