# Lani resource lookup, location matching and referral billing (build spec)

Decided by Chris, 2026-10-09. Widened on 2026-10-12: every resource type now comes from a lookup during the call, not just vendors. Updated 2026-10-14: V1 lessons, local flag, hold line, up to 3 needs, direct matching on GHL service keys, endpoint built, tool approved for the test assistant. Owner for the build: David. Rules and prompt changes: Chris's chat (chat 5).

## Status (2026-10-14)
- `/api/find-resources` is built, deployed and tested by David (commits 483f8e5, 8063ee9).
- Chris approved the Vapi tool for a **test copy** of V2, with a facts-only description (section 3).
- Still to do: create and attach the tool to the test assistant (David), load the lookup prompt onto it (chat 5), the plain-words catalog in services.json (David), and the merged end-of-call output (chat 5 drafts, David wires).

## Why
- The resource list in Lani's instructions is a snapshot. It goes stale, events included, unless a nightly rebuild runs.
- The list grows with every vendor, educator and course. It makes every turn and every after-call output cost more.
- All of this data already lives in Supabase, synced nightly from GHL.
- So Lani's instructions keep only the rules for how to think. She looks up the specific resources once she knows what the caller needs.
- The assessment stays hers. She works out the need with her rules first, then looks up who fits. This is not the old question-then-lookup flow.

## The three moments where data is used
1. **Start of the call: member lookup.** This happens before Lani speaks, so there is no pause.
   - Website calls: the page already collects the phone number and calls `/api/member-lookup`. The result goes in as `liveContext`.
   - Phone calls: not decided. If added, use the caller ID the same way (Vapi assistant-request or server-side variables). Tracker item "Returning-caller recognition on inbound phone calls".
2. **During the call: `find_resources`.** This happens once Lani knows what kind of help fits, or when the caller asks a question that needs the data. Usually one call per conversation.
3. **End of the call:** one merged structured output records what was recommended. The referral log records partner referrals for billing.

## 1. GHL fields (done by Chris)
- **Area Serviced.** Object: Vendor Partner. Key `custom_objects.vendor_resources.area_serviced`, dropdown (multiple).
  - Values: `serves_all_of_utah`, `serves_nationwide`, and all 29 Utah counties.
- **Partner flag:** Enroll Vendor Routing set to true (`enroll_vendor_match`). Only these vendors receive referrals. Do not use `affiliate_partner`.

## 2. Sync into Supabase (done by David, 2026-10-13)
Map `area_serviced` into existing columns on `ghl_vendor_resources`:
- county values to `service_counties`
- `serves_all_of_utah` to `serves_statewide = true`
- `serves_nationwide` to `serves_national = true`

## 3. Vapi tool: `find_resources`
- **Description (approved, facts only; behavior rules live in the prompt):**
  "Looks up real Utah REIA resources: Utah REIA resources, educators, classes, tools, events and vendors. Send one to three needs. Returns up to two matches per need, each with an exact name, a one-line description and its cost, plus a status for each need: ok, no_match or needs_location."
- **Input:** `needs`, a list of 1 to 3 items. Each has:
  - `type`: utah_reia, educator, class, tool, event or vendor
  - `topic`: the strategy, such as raising capital, in plain words
  - `level`: new, getting started, active, experienced or veteran
  - `service`: for vendors, the kind of help in plain words, such as "securities attorney"
  - `city` or `county`: for local vendors
  - `state`: two letters, only if the property is outside Utah
- **Plain words:** the server maps plain words to service keys and topics using the central service catalog (`services.json`), so Lani never needs internal labels.
- **Output:** per need, a status (ok, no_match, needs_location) and up to 2 matches. Each match has: id, exact name, one plain sentence, cost (free, free for members, paid, partner, first event free), booking_link for educators, closest_fit, and coverage_warning for out-of-state vendors.
- **Speed:** under about half a second.
- **Hold line:** leave the tool's request-start message blank. Lani says her own natural line before the lookup, so a Vapi message would make her speak twice.
- **Tools on V2:** find_resources is the only tool V2 carries (plus endCall). Do not attach other tools without Chris's approval.

## 4. Picker rules (shared by the tool and web routing, item 52)
- **Utah REIA resources:** match by need, and these lead.
- **Educators, classes, tools:**
  - The topic must match. An exact topic match beats a related one.
  - The levels must include the caller's level. No levels set means any level.
  - Free beats paid when the fit is equal.
  - Among equal educators, pick the one recommended least recently. The merged end-of-call record (section 5) supplies this history, so no separate table is needed.
- **Events:** only events dated today or later, matched by topic or networking.
- **Vendors:**
  - Only approved, active, Enroll Vendor Routing vendors.
  - The service must match.
  - The area must match: county in `service_counties`, or `serves_statewide` for a Utah property, or `serves_national`.
  - Then pick the partner referred least recently, from `vendor_referrals`, with a random tiebreak.
- **Ranking:** David's 0 to 100 match score design (ROUTING_SCORING_DESIGN.md, Phase 3) can rank candidates within these rules.
- **Local or not local comes from data, not the prompt.** Each service type carries a local flag (approved list, tracker item "Location-specific service types", 2026-10-13). Local types include all contractors and trades, appraisers, inspectors, stagers, leasing agents, property managers, STR cleaning, co-hosts and turnover crews, furniture suppliers, STR permit consultants, agents, wholesalers, bird dogs, surveyors, engineers, geotechnical, environmental and zoning consultants. Architects are not local.
- If a local type is requested with no city or county, return needs_location for that need, so Lani asks and looks up again.
- If the property is outside Utah, return coverage_warning on lenders, attorneys, insurance and title, so Lani says the partner may not cover that state.

## 4b. Rules carried over from V1 (must hold)
Each of these was a live V1 bug. find_resources must not repeat them.
- **Match vendors directly on GHL service keys,** specialty first. Do not route through vendor_routing_matrix or blocker_service_mapping. Those tables stay active until the paired V2 tests show find_resources plus the V2 prompt match or beat them, then retire at the switch.
- **Every vendor category is matchable:** funding, deals, team, attorney, contractor, operations, development, and education and tech. V1 could match only 2 of 8.
- **Never fall through to unfiltered results.** If nothing fits, return no_match for that need.
- **Never swap in a different strategy silently.** If the closest result is for a related strategy, mark closest_fit so Lani says so. V1 sent passive investors buy and hold content.
- **Educators: match on topic and level across every educator,** not a subset. V1 considered only 10 of 44.
- **Parent values are not matchable** when a sub-type exists: attorney, contractor, mortgage_broker. Match the sub-type only.
- **other_contractor and other_vendor_services are gap fields,** not match fields.
- **Test records:** excluded by name (TESTING) until launch. Chris's team deletes all TESTING vendors, educators, classes and tools in GHL before launch, so no is_test flag is needed.
- **The GHL picklist is the authority** for service keys.

## 5. End-of-call outputs
- Replace the current set with one merged investor output and one vendor-caller output. Today only 6 outputs run on V2, and none records a recommendation.
- The investor output records:
  - each recommended item's id and name, taken from the `find_resources` results
  - educator and booking need
  - county
  - no_match or missing help
  - caller summary, strategies, stage and goal
- Use Haiku 4.5. Add a minimum-messages condition so hang-ups skip extraction.

## 6. Referral log (table built by David): the billing record
`vendor_referrals`, one row per partner sent to a person:
- vendor ID and name, service kind, county
- source (voice, web, staff) and how it was picked
- call ID and contact ID
- message ID and delivered time
- billable flag, void reason, test flag

Rules:
- A referral is billable when the follow-up message with the partner's contact details is delivered.
- The same partner to the same person within 30 days bills once.
- Test calls are never billable.
- The log is append-only. A correction is a new row that voids the original.
- There is a monthly statement per partner.

## 7. Testing
- Build on a copy of V2 (a test assistant) so the current V2 keeps working.
- Point a test copy of the website page at it, so returning-member calls can be tested with a real phone number (index-new.html).
- Test guard: test calls save data but never text real contacts or log billable referrals.
- Chris runs no test calls until find_resources is wired to the test assistant.
- Run the same test cards on both assistants and compare quality and speed before switching.

## 8. Prompt changes (chat 5)
Drafted in LANI-V3-LOOKUP-RULES-DRAFT.md:
- The CATALOG is removed.
- Lookup rules: call `find_resources` once the need is clear, or when the caller asks something that needs data, and never name anything that did not come from a lookup.
- Send the state when the property is outside Utah. Ask for a location on needs_location. Use the MISSING HELP line on no_match. Say "closest fit" on closest_fit.
- Name items exactly as returned. Describe vendors by kind unless asked.
- One to three recommendations per call, then a mentor-style invite to call back as they reach their next stage.
- Natural speech beats, including a thinking line before each lookup.

## What this replaces
- **The nightly prompt rebuild (item 65) and the 80,000-character cap:** no longer needed once the CATALOG leaves the prompt. Keep the current V2 snapshot until the switch. Chat 5 refreshes it by hand on request.
- **The earlier vendor-only `find_vendor` design.** It is folded into `find_resources`.
- **All 7 V1 tools** (getIntakeRouting, getResourceStack, getEducationMatch, getVendorMatch, getMemberProfile, getCallerHistory, getUtahREIAContext). See LANI-V1-SUNSET-AND-SYNC.md.

## Before billing starts (Chris)
Have an attorney review per-referral fees for lenders and mortgage brokers, title and escrow, and real estate agents (RESPA and Utah licensing). A flat partner fee is a common alternative.

## Prerequisites (Chris's team)
- Decide which real vendors become partners (only 4 real partners today).
- Fill in Area Serviced for partners whose service is local.
- Add the missing educators.
- Delete TESTING records in GHL before launch.

## Reuse
- `api/member-lookup.js`: start-of-call profile.
- `api/vendors.js` (V1): area matching, the county scorer and statewide fallback.
- `services.json`: plain words to service keys, and a good home for the local flag.
- `api/lib/lani-catalog.js`: the filters for events dated today or later, and the levels and topics mapping.
