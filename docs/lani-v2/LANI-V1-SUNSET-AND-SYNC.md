# Lani V1 Sunset List and Chat Sync Rules

**Approved by Chris on 2026-10-14.** Written by chat 5. V1 (live Lani, 92018c4f) keeps running until Chris finishes testing V2 and approves the switch.

What was done on approval (2026-10-14):
- 40 tracker items closed: 26 absorbed into the V2 prompt, 8 duplicates, 5 finished history rows, and the approval row.
- Every remaining open item was tagged at the start of its latest summary: [V1, sunset at switch], [V1, sunset at switch; lesson in spec 4b], [V1+V2], [V1+V2 data], [V1+V2 data rule], [V2], [Future] or [Not Lani].
- The V1 lessons were written into LANI-VENDOR-LOOKUP-SPEC.md, section 4b.
- Decision: find_resources matches vendors directly on GHL service keys.

Updated the evening of 2026-10-14, after David's review:
- The tracker accepts event_type "planned" and has a lani_scope column (V1, V2 or both). Rules 2 and 4 below use them.
- The routing tables stay until the paired V2 tests show find_resources gives the same or better results (Part 2).
- These docs now have a copy in the repo at docs/lani-v2/ (rule 5).

Labels:
- **Sunset at switch**: V1 only. Close in the tracker and turn off when V2 goes live.
- **Absorbed**: already written into the V2 prompt. Closed.
- **Carry to V2**: still matters for V2. Open.
- **Duplicate**: closed and tracked under the item named.

---

## Part 1. Vapi tools to sunset

All seven are V1 tools. They were removed from V2 (39e25be8) on 2026-10-14 and stay on live Lani until the switch.

| Tool | What it did | Replaced in V2 by |
|---|---|---|
| getIntakeRouting | Scripted question-by-question intake | The V2 prompt (dynamic assessment) |
| getResourceStack | Built the resource stack from the old routing tables | find_resources |
| getEducationMatch | Picked courses and education | find_resources |
| getVendorMatch | Picked vendors | find_resources |
| getMemberProfile | Looked up a returning caller mid-call | /api/member-lookup before the call (liveContext) |
| getCallerHistory | Pulled past calls mid-call | /api/member-lookup before the call |
| getUtahREIAContext | Loaded REIA context at call start | V2 prompt now, find_resources later |

The backend endpoints behind them (/api/intake, /api/resources, /api/education, /api/vendors, /api/member-profile, /api/caller-history, /api/context) sunset at the switch. **Do not delete the code yet.**

Phone calls: getMemberProfile and getCallerHistory also served inbound phone calls. The V2 member lookup runs only from the website page. Chris has not decided whether Lani takes phone calls. Logged as a low-priority, undecided tracker item ("Returning-caller recognition on inbound phone calls").

Also sunset at the switch: the V1 structured outputs (about 31 extractors), once the merged V2 outputs exist.

## Part 2. Tables

- intake_questions, intake_routing_rules, phase_intent_precedence (V1 intake). **Sunset at switch.**
- problem_taxonomy, problem_taxonomy_questions, problem_taxonomy_outcomes. The 12 situations now live in the V2 prompt. **Sunset at switch.**
- vendor_routing_matrix, blocker_service_mapping, education_routing_matrix. **Sunset at switch, but only after the paired V2 tests show find_resources plus the V2 prompt match or beat them** on: lender order by strategy, which vendor kind fits which blocker, commercial property types, and the parent-strategy fallback. Keep them active until then.

Keep: reia_resources, ghl_vendor_resources, ghl_educators_mentors, ghl_tools_resources, courses, events, vendor_referrals, voice_agent_calls, contacts.

## Part 3. Tracker items

Filter the latest row per item by its tag. The groups below match the tags.

### [V1, sunset at switch]
V1 intake and routing behavior, the secondary-questioning tool and taxonomy, the matrix remediation work, and the education matrix audits. 43 items. Close all at the switch.

### [V1, sunset at switch; lesson in spec 4b]
resources.js vendor matching (and both patches), strategy respect, the passive-investor fallback, and the educator selection bugs. Close at the switch. Their rules now live in the find_resources spec.

### [V1+V2]
Items that affect both versions: call saving, the contact-sync filter, SMS consent, vendor workflow hardening, the vendor If/Else switch, educator SMS, and the Event Register trigger. Data items (vendor and educator records, specialties, legal forms pricing, tools tiers, placeholder resources) and data rules (picklist authority, parent values, gap fields, spelling lock, loan_product) carry the data tags.

### [V2]
The V2 build: go-live checklist, the lookup, location matching, scoring, test page, returning members, outputs, naturalness, Spanish, speech recognition, the opening line check, the reconnect bug, the dashboard, the service catalog, routing outside the voice agent, test cards, the catalog refresh, referrals, and the Utah REIA resource type.

### [Future] and [Not Lani]
Kept open but out of the launch path.

---

## Part 4. Keeping chat 5 and chat 6 in sync

What went wrong on 2026-10-14: chat 6 attached the V1 tools to V2 while chat 5 was designing V2 without them. Neither chat saw the other's plan.

Rules:
1. **One owner per piece of V2.** Chat 5 (Chris) owns what Lani says and decides: the prompt, the rules, and which tools Lani carries. Chat 6 (David) owns how it runs: Vapi settings, server, code, sync and workflows.
2. **Plan before changing V2.** Before changing anything on a V2 or test assistant (prompt, tools, voice, transcriber, settings), log a row with event_type "planned" describing the change. Tool changes need Chris's approval first.
3. **Read before working.** At the start of every session, each chat reads the other chat's tracker rows from the last 48 hours.
4. **Tag every row.** Set lani_scope to V1, V2 or both on every new row. The bracket tags added to summaries on 2026-10-14 stay as history. V1-only work stops, except fixes that keep live Lani working.
5. **One spec, two copies.** The V2 build spec, the V2 lookup prompt and this doc live in the Claude Project (claude/ folder) and in the repo at docs/lani-v2/. Chat 5 owns them: when chat 5 changes one, it updates both copies and logs the change in the tracker. Chat 6 reads the repo copy and does not edit it; if code and spec disagree, raise it in the tracker before building.
