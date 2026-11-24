# Scope: Partner Referral Notice (vendor-side notification)

Written for: David (code), Chris/ops (GHL workflow), Harmonie (copy).
Status: scoped, decisions locked 2026-11-24. Not yet built.

## Goal
When Lani delivers a partner to a caller (a `vendor_referrals` row is written), send
the **partner** a message so they can follow up with the caller. This is the vendor
side of "Vendor referrals: partners only"; the caller side (partner contact in the
follow-up text) and the referral log already ship (PR #8, live).

## Decisions (David, 2026-11-24)
1. **Content:** caller **name + need (service) + caller contact (phone/email)** so the
   partner can reach out directly.
2. **Delivery:** GHL **inbound webhook → new workflow** (same pattern as the caller
   follow-up); ops owns the copy/sends.
3. **Channel:** **SMS** to the partner's `company_phone` (all 8 enrolled partners have
   one; 5 have email — email is a later add).
4. **Trigger scope:** **every delivered referral** (billable or not), **excluding
   TESTING** records.

## Trigger point
`api/ghl-sync.js`, STEP 7 (the referral-log block). For each partner row the log
already builds for this call (non-TESTING, after the caller follow-up webhook is
accepted), also fire the partner notice. Reuse the log's idempotency so a retried
webhook never double-notifies (one notice per `vapi_call_id` + vendor).

## Data flow
`ghl-sync.js` POST → `GHL_PARTNER_WEBHOOK_URL` (new env var) → new GHL workflow → SMS.

Payload (one POST per delivered partner, or an array):
```
{
  partner_company_name, partner_phone, vendor_ghl_record_id,
  caller_name, caller_phone, caller_email, requested_service,
  vapi_call_id, referral_delivered_at
}
```

## Work split
- **David (code):** in `ghl-sync.js` STEP 7, after the `vendor_referrals` insert, POST
  the payload above to `GHL_PARTNER_WEBHOOK_URL` for each non-TESTING delivered partner.
  Non-fatal (try/catch, like the log). Add `GHL_PARTNER_WEBHOOK_URL` to Vercel env +
  `.env.example`. Dedupe aligned with the log rows.
- **Chris/ops (GHL):** create workflow "Voice Agent – Partner Referral Notice":
  trigger = inbound webhook; action = SMS to the partner phone with the caller's
  name/need/contact. Give David the webhook URL for the env var.
- **Harmonie (copy):** the SMS wording (brand voice, no em dashes, no URLs read aloud
  rules don't apply to SMS but keep it tight).

## Consent / privacy
- Caller gave TCPA consent at call start to be connected to resources, so sharing their
  contact with the **matched** partner is the service they opted into.
- Partners consented to receive referrals at enrollment (enroll_vendor_match = true).

## Prerequisites / notes
- **Only company-level contact is in the Supabase mirror.** The per-vendor
  `point_of_contact` / `point_of_contact_phone` GHL fields are NOT synced. Notices go to
  `company_phone`. To reach a named person instead, add those fields to the sync first
  (small `sync-ghl-objects.js` addition).
- **Real lenders not yet enrolled.** Conventus, Easy Street Capital, First Colony
  Mortgage sit at `enroll_vendor_match=false`, so flips/holds still route to TESTING and
  those partners won't be notified until enrolled (see CLAUDE.md open item 8).
- End-to-end live testing needs the GHL workflow + webhook URL to exist first; until
  then the code can be unit-tested with a stubbed fetch.
