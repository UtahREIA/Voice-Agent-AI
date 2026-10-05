# Vendor enrollment → Vendors & Partners object (build plan)

Status: PLANNED (2026-10-05). Not yet built.

## Goal
Stop storing a caller's vendor directory info on the **Contact** (as custom fields). Instead
drop it straight into the **Vendors & Partners** custom object as a **pending** record, let a
human approve it there, and have Lani recommend **only Approved** vendors.

## Target flow
1. Vendor calls. Vapi sends the webhook as today.
2. The GHL workflow uses **Create Associated Record for Contact** to create a Vendors & Partners
   record from the webhook values, with **Approval Status = Pending Approval**.
3. A human opens the object, fills in / confirms the structured match fields, and sets
   **Approval Status = Approved** (or Rejected).
4. The daily cron (`sync-ghl-objects.js`) syncs **all** records to Supabase `ghl_vendor_resources`,
   including the new status.
5. **The gate lives in the matching code:** Lani only ever surfaces records with
   `approval_status = Approved`. Pending and Rejected are ignored.
6. The vendor's directory info no longer lives on the Contact.

Why the gate moves to code: the object will now hold unvetted (pending) records, so "only what is
in the object is live" is no longer safe. The Approved-only filter is what preserves the vetting gate.

---

## Part 1 — GHL: Vendors & Partners object fields
Add these to the object if not already present:
- **Approval Status** (dropdown): `Approved`, `Pending Approval`, `Rejected`. Default **Pending Approval**.
  (A human sets this field, so a dropdown is fine; the webhook-reliability caveat about option
  fields only applies to fields the voice agent writes via webhook.)
- Intake fields to receive the voice-agent answers (free text is fine): Service Type, Investor Types,
  Market, REIA Connection, Enrollment Interest, Follow Up Preference, Vendor Summary.
- Contact info fields: vendor/company name, phone, email (so the caller's contact details sit on
  the object, not the Contact).

Note: the object already has the structured MATCH fields the cron reads (funding_financial,
deals_opportunities, team_vendors, operations, development_land, contractor_speciality, etc.).
The voice agent only collects free-text Service Type, so a pending record starts thin; the human
fills the structured fields in during approval. The Approved-only gate keeps thin pending records
from ever surfacing.

## Part 2 — GHL: workflow changes ("Utah REIA Voice Agent Lead")
1. **Remove the 7 vendor fields from the "Update contact field" step** (both the Contact Found and
   Contact Not Found paths). Keep all the investor/call fields (summary, stack summary, matches,
   booking, stage/strategy/blocker/goals, etc.) on the Contact as they are. Remove only:
   Vendor Service Type, Vendor Investor Types, Vendor Market, Vendor REIA Connection,
   Vendor Enrollment Interest, Vendor Follow Up Preference, Vendor Summary.
2. **Add a "Create Associated Record for Contact" step** into Vendors & Partners, placed where the
   flow has confirmed a vendor enrollment (today: the branch that fires "Vendor Enrollment Interest"
   internal notification + "Vet voice-agent vendor" task + "Confirmation to the Vendor" SMS). Map
   from the webhook, not from contact fields:
   - Name  <- firstName + lastName
   - Phone <- phone
   - Email <- vendorEmail (if present)
   - Service Type <- vendorServiceType
   - Investor Types <- vendorInvestorTypes
   - Market <- vendorMarket
   - REIA Connection <- vendorReiaConnection
   - Enrollment Interest <- vendorEnrollmentInterest
   - Follow Up Preference <- vendorFollowUpPreference
   - Vendor Summary <- vendorSummary
   - **Approval Status <- "Pending Approval"** (static)
3. **Fix vendor detection.** The two "If Voice Agent Vendor Service Type is Not Empty" / "If Vendor
   Enrollment" checks currently read the CONTACT field, which will now always be empty. Point them at
   the webhook value `{{inboundWebhookRequest.vendorServiceType}}` instead (or branch on
   `{{inboundWebhookRequest.profileType}} == Vendor`). This is the ripple that must change or vendors
   stop being detected.
4. **Repoint the team notification + vet task to the webhook.** The "Vendor Enrollment Interest"
   internal notification and the "Vet voice-agent vendor" task display the vendor's service type,
   investor types, market, REIA connection, follow-up preference, and summary. If any of those pull
   from the Contact's "Voice Agent Vendor ..." custom fields, they will show blank once Change 1
   removes those fields from the Contact. Repoint them to the inbound webhook values instead:
   Service Type `{{inboundWebhookRequest.vendorServiceType}}`,
   Investor Types `{{inboundWebhookRequest.vendorInvestorTypes}}`,
   Market `{{inboundWebhookRequest.vendorMarket}}`,
   REIA Connection `{{inboundWebhookRequest.vendorReiaConnection}}`,
   Enrollment Interest `{{inboundWebhookRequest.vendorEnrollmentInterest}}`,
   Follow Up Preference `{{inboundWebhookRequest.vendorFollowUpPreference}}`,
   Vendor Summary `{{inboundWebhookRequest.vendorSummary}}`.
   The notification and task now tell the team to go APPROVE the pending object record instead of
   creating it by hand. The vendor confirmation SMS stays as-is.

### Investor callers are unaffected
None of the Part 2 changes alter the investor path. Change 1 only removes vendor-only fields that
investors never populate; Changes 2 and 4 fire only on the vendor enrollment path; Change 3 reads an
empty webhook value for investors, so they flow down the normal investor path exactly as before.
Investors still write to the Contact as they do today; only vendors move to the object.

## Part 3 — Supabase migration (run when the connector is back)
```sql
-- add the column
ALTER TABLE public.ghl_vendor_resources ADD COLUMN IF NOT EXISTS approval_status text;
-- backfill so nothing already-live disappears when the code gate flips on
UPDATE public.ghl_vendor_resources
SET approval_status = 'Approved'
WHERE approval_status IS NULL AND is_active = true AND enroll_vendor_match = true;
-- everything else is treated as pending until a human approves it
UPDATE public.ghl_vendor_resources
SET approval_status = 'Pending Approval'
WHERE approval_status IS NULL;
```
Verify: `SELECT approval_status, count(*) FROM public.ghl_vendor_resources GROUP BY 1;`

## Part 4 — Code changes
1. `sync-ghl-objects.js`: map the object's Approval Status into `approval_status` (handle the
   array-wrapped option value, same pattern as enroll_vendor_match). Two spots: the daily-sync
   mapper (~line 192) and the single-record upsert (~line 435).
2. Add `approval_status=eq.Approved` to the vendor gate in the five query spots:
   - `context.js` line 45 and line 103
   - `vendors.js` line 325 (select) and keep the line 460 score bonus
   - `resources.js` line 399
   (Decision below: whether this replaces or sits alongside `enroll_vendor_match=eq.true`.)

## Part 5 — Rollout order (safety-critical)
1. Supabase column + backfill (Part 3).
2. Deploy the code filter + sync mapping (Part 4).
3. ONLY THEN flip the GHL workflow to auto-create pending records (Part 2).
Doing it in the other order would let unvetted pending vendors surface the moment someone calls.

## Gate decision — DECIDED: BOTH gates (2026-10-05)
Matching requires `approval_status = Approved` **AND** `enroll_vendor_match = true`. On approval the
team sets both. Code (Part 4) is written to this: all five queries now carry
`&approval_status=eq.Approved` on top of the existing `&enroll_vendor_match=eq.true`.

## Cron-clobber gotcha (must handle at go-live)
The backfill in Part 3 sets Supabase `approval_status='Approved'` for existing live vendors. But the
daily cron re-syncs each record FROM the GHL object, overwriting `approval_status` with whatever the
object holds. Existing object records created before this change have NO Approval Status set, so the
next cron run would overwrite the backfill with null and those vendors would vanish. Fix at go-live:
set **Approval Status = Approved on every existing (already-live) Vendors & Partners record in GHL**
(one-time), so the cron syncs 'Approved' for them. Do this before or together with the Supabase backfill.

## Go-live sequence (do in this order)
1. GHL: confirm the Approval Status field's real property key from the sync's logged field names, and
   tell the dev so the sync mapping key is pinned (currently mapped defensively against likely variants).
2. GHL: set Approval Status = Approved on all existing already-live object records (cron-clobber fix).
3. Supabase: run Part 3 (add column + backfill existing enroll_vendor_match=true -> Approved).
4. Deploy the code (Part 4). Until steps 1-3 are done, do NOT deploy, or the new filter hides every
   vendor that lacks approval_status='Approved'.
