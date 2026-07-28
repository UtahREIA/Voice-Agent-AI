# Utah REIA Voice Agent (Lani) — Session Handoff

Snapshot as of 2026-07-23. Written to hand off to a fresh session. Start by
reading `FIX_CHECKLIST.md` (full step-by-step audit trail) and `CLAUDE.md`
(architecture rules and gotchas).

## What we were doing

Debugging and fixing the intake -> routing -> resource-recommendation pipeline,
triggered by two test-call transcripts (George Testing, then Jonathan Johnson)
that showed repeated questions and wrong recommendations. All code work is
committed and pushed to `main` (repo `UtahREIA/Voice-Agent-AI`), auto-deploying
to Vercel.

## The big discovery

`getResourceStack` — the tool meant to return a mixed 5-6 resource stack — was
written and routed to on 2026-06-26 but **never created in Vapi**. For 26 days
every call silently substituted a single-category tool and still sounded fine.
This is the "three coupled layers" failure applied to a tool instead of a
question, and the tool version fails silently, which makes it more dangerous.
Now documented in `CLAUDE.md`.

## What got fixed and shipped (all live on main)

1. **Duplicate questions** — `education_history` and `already_tried` were asked
   back to back. Added `COVERED_BY` in `intake.js` so they satisfy each other.
2. **Blocker never collected on Path A** — widened the four `ask_blocker_*`
   rows to new/getting_started stages and added `blocker` to `FLOW.A.required`.
3. **Stage vocabulary mismatch** — `intake_routing_rules` used short keys
   (`active`) while everything else used long (`active_investor`). Only
   `getting_started` matched in both, which hid that **128 of 164 rules were
   dead**. Added `RULE_STAGE_KEY` in `intake.js`; added 2 missing aliases in
   `education.js`.
4. **`resources.js` fully rewritten** — was matching on almost nothing (four
   vocabularies, no translation; educators picked by `limit=1`). Now returns a
   mixed 5-6 stack by default, or up to 5 of one category on request, matched
   on stage/strategy/blocker. Modes: all, vendor, education, educator, tool,
   event.
5. **`getResourceStack` created in Vapi + intake routing flipped to it** —
   `routing_action` no longer picks the tool. Every caller gets the combined
   stack unless they explicitly ask for one category (`resource_request` ->
   `mode`). Rules still supply tier and voice_bridge.
6. Credit question reworded (old one confused a caller); deal-finding tier set
   to `2_and_3`; `1_info` and `escalate` handled as no-tool sentinels.

## Last test-call result (2026-07-23)

`GetResourceStack` **fired for the first time in the project's history** and
returned a correct commercial stack (Commercial Real Estate Execution Track at
#1, not the old BRRRR mismatch). The feature works end to end. Confirmed the
same output via direct curl to `/api/resources`.

## Still open — next steps, in priority order

1. **Returning-caller recall is buggy** (`context.js` / `caller-history.js`,
   untouched by this work). On the last call it fabricated a completed
   recommendation ("I recommended David Duster, how did that go?") for a call
   that was actually cut off mid-intake, and mangled the name ("David Tester"
   -> "Davey" / "David Duster"). **This is now the top priority.**
2. **Intake flow is still unproven by voice.** The last call was treated as a
   returning caller and skipped every question, so the George/Jonathan fixes
   (blocker asked, no already_tried repeat, reworded credit) have not run on a
   live call. Test with a **fresh, unknown caller** — a name and phone with no
   prior record — so recall does not fire.
3. **Step 17** — re-paste the `getIntakeRouting` tool description in Vapi. It
   still names `getEducationMatch` / `getVendorMatch`, but the code now emits
   `getResourceStack`. Corrected text is in `FIX_CHECKLIST.md` step 3.
4. **Test data read aloud** — several Supabase records are literally named
   "Wholesaler TESTING", "Frankie Testing", etc. and get spoken on live calls.
5. **`baseHeaders is not defined`** — a live ReferenceError in `ghl-sync.js`
   silently failing the Supabase contact write. Untouched by this work.
6. **`commercial_asset_types` not syncing to `ghl_educators_mentors`** (and
   `ghl_educational_courses`). Root cause found and half-fixed: the daily bulk
   cron in `sync-ghl-objects.js` never mapped the field, though the webhook path
   did, so the column is empty on every record. Code now maps it with fallback
   keys plus a diagnostic, committed and deployed. **Two things remain, both
   need live connectors:**
   - Confirm the real GHL key. GHL mangles multi-select keys (double underscore
     + `_partner`, e.g. `deals__opportunities_partner`), so the plain
     `commercial_asset_types` may be wrong. Read **Blair Testing**'s educator
     object via the GHL MCP (custom object endpoints 403 from external IPs, so
     GHL MCP is the only way) and check the actual property key. Or trigger the
     cron (`/api/sync-ghl-objects`) and read the `SYNC DIAG — educator ... prop
     keys:` line in the Vercel log, which dumps every key.
   - Backfill existing rows once the key is confirmed, then re-verify the
     resource stack, since `resources.js` can match educators/courses on
     `commercial_asset_types` (CLAUDE.md currently says that column is empty and
     to not match on it — revisit that note once this is fixed).

## Parked for Chris (decisions, not bugs)

- `ask_caller_type` never fires — it is in no `FLOW` list, so nothing routes a
  caller into vendor Path V. Likely why vendor calls take two tries. One-line
  fix but it changes what every caller hears first.
- The priority-1 "duplicate" Chris spotted is harmless: priority is scoped per
  path and only breaks ties within a dimension. No cleanup needed for
  correctness.

## Test scenarios (also in FIX_CHECKLIST.md step 16)

**Call 1 — Path A, fresh caller.** "Just getting started" / "commercial
industrial flex space" / "buying two more properties this year" / "I cannot
find the right deals" / "funds ready to invest" / "strong credit, could get a
bank loan" / "books and podcasts, never had a mentor" / "ten to twenty hours".
Expect 5-6 mixed resources. Credit question must be the NEW wording. She must
NOT ask what you already tried after the education question.

**Call 1b — narrowing, same call.** After the stack: "Can you just show me the
vendors?" Expect vendors only, then an offer to widen rather than padding.

**Call 2 — Path B, fresh caller.** "I am already active, I have four rentals" /
"I need a property manager". Should fast-exit to a recommendation. If she asks
"what specifically do you need right now" twice, that is the old infinite loop.

## Key facts / coordinates

- Supabase project `kttzxjddtkgsitzehiid`.
- Vercel project `voice-agent-ai`, team `team_M9Gkv9YgPQAwYY7sJdS5uNj9`, prod
  URL `https://voice-agent-ai-nu.vercel.app`.
- Decisive log lines in Vercel runtime logs: `Intake routing —` (shows action,
  mode, tier, matched rule) and `getResourceStack args:` (shows the dimensions
  the stack received). Also `Structured data extracted:` in the ghl-sync log.
- The single most important check that `getResourceStack` is really wired:
  `POST /api/resources` appearing in the Vercel log. It had never appeared
  before this work.
- **Four stage/strategy vocabularies** are documented in `CLAUDE.md`. Always
  test with `active_investor`, never only `getting_started` — it is spelled
  identically in every vocabulary and hides mismatches.
- When resuming: the Supabase and Vercel MCP connectors need to be live in the
  session. If tool calls to them fail, they have not repopulated yet.
