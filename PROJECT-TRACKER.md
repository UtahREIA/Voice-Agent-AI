# Utah REIA Voice Agent (Lani) — Master Project Tracker

Last updated: 27 July 2026 (chat 3). Prior version covered vendor path, intake rebuild, priority fix, and Claude Code handoff.

**Workflow:** Brainstorm and decide in Claude Chat. Build in Claude Code from prompts Chat provides. Chat tracks state. Tracker stays accurate only if Claude Code session summaries are pasted back into Chat. Repo lives at `C:\Users\FTLIn\Voice-Agent-AI`.

**Deployment verification rule (standing).** Any time a pasted Claude Code summary says it deployed, pushed, redeployed, or committed-and-deployed to Vercel, Chat stops, verifies via Vercel MCP, and reports the actual build state before anything else proceeds. Origin: commit `1330cff` reported a clean tree and a SHA but never reached Vercel. Every deployment that DID reach GitHub built READY, so the silent failures are unpushed commits, not failed builds. Vercel project `voice-agent-ai`, team `team_M9Gkv9YgPQAwYY7sJdS5uNj9`, main branch. Sequence for Vapi-affecting changes: Vapi dashboard first, then push, then test.

**Operator note.** The person running this project is not Chris Borden and not David. Both appear in git history and prior summaries as team members only.

---

## OWNERSHIP (set 27 July 2026)

- **Chris owns:** Item 12 (secondary questioning / problem taxonomy), Item 13 (resource stack hierarchy), and the INTAKE QUESTION REVIEW section at the bottom of this file.
- **This chat owns:** everything else.

**Collision watch.** Items 1 and 4 sit on Chris's side of the line even though they are numbered on ours:
- Item 4 (education_history vs already_tried overlap) is already answered inside the Intake Question Review: keep both, reframe as knowledge-acquired vs action-taken. Editing it here would fork the decision.
- Item 1's option (b), "add blocker/already_tried to the table/FLOW properly," is an intake-table change, which is Review territory. Option (a), harden the prompt, is not.
Recommendation: leave 4 to Chris entirely; take Item 1 only if the answer is (a).

**Downstream dependency.** Item 14 (lender matrix) feeds Item 13's stage gate and tier ordering. Chris should know the lender categories before finalizing which resource categories get excluded per stage.

---

## STATUS LEGEND
- DONE = built, verified, deployed
- BUILT = code written and deployed, not yet verified on a live call
- DECIDED = decision made, not yet built
- OPEN = needs a decision or needs building
- BLOCKED = waiting on something external

---

## RECENTLY COMPLETED (deployed)

- **DONE** — Intake logic rewrite: sufficiency-based stopping (no stop-at-3), per-path required/desired/extras floors, goal as pruning switch, Path B fast-exit, Path V vendor walk. `args` bug fixed.
- **DONE** — Vendor path: 7 GHL custom fields created (location DNirEjy0ejVwbHsaBYrn), vendor fork in ghl-sync.js, tier renamed to `vendor_enroll` (no leading number), detection off `profileType`.
- **DONE** — Stale vendor field clearing on investor calls (Fix 2): dedicated PUT writes empty strings so a prior vendor call cannot contaminate a later investor call.
- **DONE** — Vendor fork simplified (Option A): fork no longer writes custom fields; the GHL workflow owns field-writing. Removes the new-contact race condition.
- **DONE** — Priority renumber (Fix A): all path/priority combos now unique in intake_questions. `ask_stage_new` moved to priority 2; Path V chain respaced.
- **DONE** — Name/branding: written form always "Utah REIA"; agent named Lani; index.html greetings introduce Lani across all three states.
- **DONE** — Spelling confirmation added at Turn 3; all stale "Turn 2" tool-call refs updated to Turn 3 in the prompt.
- **DONE (Claude Code)** — Returning-caller recall bug: no more fabricated "I recommended X" on cut-off calls (commit 4d89e1a).
- **DONE (Claude Code)** — Follow-up SMS links: real links now folded into the stackSummary SMS via voice_agent_stack_links cache (commit a39a4e0).
- **DONE (Claude Code)** — Educator booking now triggered whenever an educator is in the delivered stack (commit a39a4e0).

---

## BUILT, NOT YET VERIFIED ON A LIVE CALL

- **BUILT** — The six vendor structured outputs now emit (confirmed on the Jacob Donaud test: all 7 fields populated, vendor pending review tag applied). Still want one clean end-to-end pass with SMS actually delivered.
- **BUILT** — Vendor workflow branch (first If/Else on Vendor Service Type not empty). Needs the second tag-based If/Else removed so it stops mis-firing on stale tags. SEE OPEN ITEM 1.

---

## OPEN ITEMS (need decision or building)

### 1. OPEN — Lani improvises questions the tool never returned
On George's test call, Lani asked a blocker question and re-asked already_tried, neither preceded by a GetIntakeRouting call. The code is innocent (blocker is not in Path A FLOW; it cannot come from intake.js). She freelanced them. This is a prompt-adherence problem: the "only ask tool questions" rule is losing to the model's instinct to keep the conversation flowing.
DECISION NEEDED: (a) harden the prompt so she strictly relays only tool questions, or (b) accept that blocker/already_tried are sometimes reasonable on Path A and add them to the table/FLOW properly. Leaning (a) plus trimming the overlap in item 4.

### 2. DONE (deployed ff4fbb1) — context.js undefined headers reference
Was: `getUpcomingEvents` in context.js referenced `supabaseHeaders` but the variable is defined as `baseHeaders`, throwing "baseHeaders is not defined" on live calls and silently killing the contact/events lookup. Fixed the reference to `baseHeaders`. Deployed and verified READY. The error should no longer appear in logs.

### 3. OPEN — Education tracks have no URL
education_routing_matrix tracks carry no URL column, so the flagship "Commercial Real Estate Execution Track" recommendation cannot produce a link. This is why the follow-up SMS is thin. DECISION NEEDED: add a landing URL per track, or map tracks to course/resource pages that already have URLs.

### 4. OPEN — education_history and already_tried overlap on Path A
On George's call these two questions felt like duplicates to the caller ("you just asked me that"). For a new investor, "what education have you had" and "what have you tried" collapse. DECISION NEEDED: drop already_tried from Path A desired (keep it on Path B), or reword both to be clearly distinct. Leaning: drop from Path A.

### 5. DONE (deployed, tested live) — caller_type fork now works end to end
Built as Option 2 (web entry pre-sets caller_type; no voiced fork question, since a web call cannot start without a button/link press). Shipped:
- index.html (commit 43c9acb): "Partner with us" secondary text link below Begin Journey. Button sets caller_type='investor', link sets caller_type='vendor', both injected via overrides.variableValues.caller_type.
- Vapi: caller_type parameter confirmed present on getIntakeRouting; system prompt updated (caller_type woven through, hardcoded path=A removed, VENDOR PATH section added).
- intake.js resolvePath() forks to Path V when caller_type contains vendor and not investor.
- Diagnostic (commit ff4fbb1) confirmed the value flows: INTAKE DIAG log line.
VERIFIED on a live vendor test call: Partner with us link routes correctly to the vendor path under caller_type. The root cause that had blocked it (theorizing instead of logging the real value) was broken by adding the diagnostic and reading ground truth.
REMAINING sub-item: the "both" profile handling. Reframed into TWO builds:
- BUILD 1 (behavioral cross-door) — DONE, deployed f751f4d, READY. When a returning caller enters through the opposite door from their history, profile_type is set to 'Both' in Supabase (voice_agent_calls + contacts patch) and GHL. member-lookup.js now selects profile_type in all 4 history queries and returns prior_profile_type. ghl-sync.js has the cross-door check on both the vendor fork and investor path. Value string is 'Both' (capital B) to match 'Vendor'/'Investor'. The current call still runs the door clicked; becoming Both does not change this call's flow.
  - LIVE-TESTED AND PASSED (added chat 3, after this file was last saved). Three sequential calls confirmed the investor -> vendor -> Both profile progression works correctly. The misclassification risk noted below did not materialize.
  - Superseded risk note, kept for context: vendor detection keys on the substring "vendor"; the string "Both" contains neither "vendor" nor "investor", so a Both caller's NEXT call could misclassify. Test performed; routing was sane.
  - NEW GAP FOUND DURING THAT TEST (not previously tracked): on the third call Lani referenced only the first (investor) call and ignored the second (vendor) call. Cause: the recall logic picks the most recent call WITH A RECOMMENDATION, and vendor calls end in a handoff with no recommendation field populated, so vendor calls are invisible to recall. Fix direction: recall should consider vendor calls even when recommendation is null, or vendor calls should write a handoff summary into whatever field recall reads. NOT YET BUILT.
- BUILD 2 (organic mention) — NOT built. If a caller VOLUNTEERS dual intent mid-call (investor mentions offering a service, or vendor mentions they invest), profileType should become Both. Lani must NEVER probe for it — only catch volunteered intent. Plus the correction case: if the caller says the second door was an accident, Lani updates the profile back to single (a live profile write from conversation, a new capability). This is the calibration-sensitive, higher-risk build. Do after Build 1 is live-tested.
- The old intake.js "both → investor with TODO" is the interim; still fine, since the web flow never sets caller_type='both' directly.

### 6. OPEN — Vendor workflow: remove the second (tag-based) If/Else
The first If/Else on Vendor Service Type is per-call accurate. The second one branches on the persistent `vendor pending review` tag, which mis-fires when a vendor calls back as an investor. Remove it. Branch on the field, filter on the tag.

### 7. OPEN — Vendor review outcome workflow (approve/decline clears the tag)
Separate workflow, trigger on Tag Added. `vendor approved` and `vendor declined` both remove `vendor pending review` so the queue stays meaningful. SMS drafts written (approved / listed / declined). DECISION: automate the decline SMS or handle verbally (leaning verbal).

### 8. OPEN — Spam trap kills outbound to some numbers
The 807 test number got tagged `possible spamtrap` + `delete contact` with DND on across all channels, so confirmation SMS never sends. Need to find which workflow applies those tags and whether it will hit legitimate out-of-state vendors.

### 9. OPEN — Duplicate contacts on one phone number
Three contacts share +1 807-624-5868. The stale-field-clear lookup takes the first match, so duplicates could cause the wrong contact to be cleared. Clean these up.

### 10. OPEN — ElevenLabs pronunciation rule for "REIA"
Written form is clean ("Utah REIA") but the voice layer still needs a pronunciation-dictionary rule mapping REIA to the REEAH sound. Prompt cannot do this. Confirm the rule is set.

### 11. OPEN (parked) — Survey Routing Workflow
Pending Chris Borden's approval.

### 12. OPEN (designed, not built) — Secondary questioning / problem-to-solution bridge
**Origin:** Chris Borden test call (+18088565351, path B, tier 2_and_3, "note in default"). Lani fast-exited and delivered without diagnosing, because Path B triggers on specific_need being present. But the caller described a PROBLEM, not a SOLUTION, and the whole product premise is helping people who do not know what they need. She recommended no foreclosure/enforcement attorney until pushed.

**Core distinction:** solution-aware ("I need a litigation attorney" → route now, no questions) vs problem-aware ("I have a note in default" → needs secondary questions to narrow to a solution). Current code cannot tell these apart.

**Design decided (not yet built):**

1. **Problem taxonomy table.** Each row: the problem, a complexity tier, a question budget, the clarifying questions, and the solution class each answer maps to. Start with high-frequency, high-stakes problems; grow it over time.

2. **Complexity-tiered cap (not a flat number).** The question budget is a property of the problem, stored on the row:
   - Simple = 1 question
   - Moderate = 2-3 questions
   - Complex = up to 5 questions (high-stakes, multi-factor, e.g. note in default: judicial vs non-judicial, borrower responsive, keep vs exit, deficiency exposure)
   Constant rules across all tiers: every question must change the routing, and stop early if the problem resolves before the budget is spent. Budget is a ceiling, not a quota.

3. **Gate order: taxonomy first, Lani fallback second.**
   - Taxonomy match → use its defined questions and budget (controlled, auditable).
   - No taxonomy match → Lani judges solution-vs-problem in the moment and, if it is a problem, improvises a bounded round of clarifying questions. Fallback gets a conservative default budget (moderate, ~2-3), because unmapped = lower confidence + higher impatience risk.

4. **Output is a SOLUTION CLASS, not a vendor.** The taxonomy resolves to a solution class (e.g. "trust deed enforcement attorney + note sale resources") which then feeds the EXISTING vendor_routing_matrix and education_routing_matrix. Taxonomy = diagnosis; existing matrices = matching. Clean separation.

5. **Match chain with a confidence guardrail:**
   - Exact match → deliver normally.
   - Close match above a confidence line → deliver WITH honest framing ("the closest fit we have is X, they may point you in the right direction").
   - Below the line or no match → do NOT force a weak referral. Fall back to human escalation ("someone from our team will reach out directly"). Rationale: the callers most likely to be hurt by a bad match are exactly the ones who cannot tell a good referral from a bad one.

6. **Confidence line (v1 decision): Lani's judgment, not computed scoring.** Routing matrices do not currently emit a numeric score, so v1 uses Lani's in-the-moment judgment plus honest framing. Scored matching is roadmapped (see roadmap).

7. **Every secondary question prefaced with WHY.** Research-backed: "Let me ask a couple quick things so I get you to the right person" converts probing from interrogation to service. Total call budget target ~6 min, so name capture + intake + secondary must fit inside that.

8. **Two gap logs, tagged by type (build with this feature):**
   - **Service gap** (a solution class matched but nothing in the matrices serves it) → vendor/educator ACQUISITION signal to Chris. Real-time notification. Direct revenue implication: demand you are not serving.
   - **Taxonomy gap** (no problem matched, Lani had to improvise) → taxonomy GROWTH signal. Tells you which problems to map next. This is the discovery loop.
   Keep them separate so the vendor-acquisition signal is not buried in taxonomy noise.

**Still to decide before building:** the taxonomy table schema (columns), the first set of problems to seed it with, and the confidence-framing wording. NOTE: applies to BOTH Path A and Path B. Path B normally knows what it wants but not always, so Path B needs a conditional escape hatch into secondary questioning when the need is problem-shaped.

**Triggers for secondary questioning (any one fires the diagnostic before delivery):**
1. A problem-shaped need, e.g. "note in default" (Chris Borden call, +18088565351).
2. `blocker = strategy_clarity`. DECIDED as a near-hard rule: a strategy_clarity caller almost always gets 1-2 exploration questions before any resource is delivered, because by definition they are unsure of their direction. Confirmed on the Chris Doc test (+18088561789): buy_and_hold but exploring, blocker strategy_clarity, and the system surfaced an off-strategy short-term-rental resource with no context. Correct behavior: explore first ("you have a buy-and-hold, leaning toward more rentals or open to other approaches? time and capital picture?"), THEN surface a strategy direction as a framed suggestion ("based on that, X might be worth exploring, does that resonate?"), THEN the resources for that direction. A strategy suggestion must be framed and confirmed, never delivered as a bare vendor recommendation.
3. Lani's in-the-moment judgment on an unmapped need (the fallback).

### 13. OPEN (designed, not built) — Resource stack hierarchy and sequenced delivery
**Origin:** Chris Doc test call (+18088561789, path A, Getting Started, buy_and_hold, blocker strategy_clarity). The stack returned five resources at once: Strategy Selection & First Deal Track, Mortgage Broker TESTING, Toby Testing (short term rental), Summer BBQ, First Colony Mortgage. Two distinct failures.

**Failure 1 — relevance.** Three of five should not have surfaced for this caller:
- Two mortgage brokers: transactional resources handed to a strategy_clarity caller who cannot use a lender until he has a strategy and a deal. "I don't need a mortgage broker if I don't know what I'm doing."
- One short-term-rental resource: his strategy is buy_and_hold and he never mentioned STR. The matcher pulled an off-strategy resource.

**Failure 2 — volume and hierarchy.** The one genuinely foundational resource (Strategy & First Deal Track) got no priority; it was item one in a flat list of five, not framed as the starting point.

NOTE: all records here are placeholders ("TESTING"), but the CATEGORIES are real. So every flaw is a genuine logic flaw, not a data artifact. Fixing against placeholders now is correct; the same flaws would surface with real vendor names later.

**Design decided (not yet built) — three layers, applied in order:**

1. **Stage gate (fixes relevance failure 1).** Some resources are wrong for a stage and should be EXCLUDED, not ranked low. A transactional vendor (lender, etc.) is a non-match for a foundational-stage / strategy_clarity caller. This is a filter in the matcher before ranking. Connects to the existing deferred gap: intake_routing_rules and the matrices score by stage but do not strongly EXCLUDE by stage. May need stage-exclusion rules, not just stage-scoring. DECISION LEANING: hard exclusion (matcher cannot return the resource) over soft (Lani just does not lead with it), because hard is what actually fixes it. Requires defining per stage which resource categories are off the table.

2. **Strategy respect (fixes relevance, the STR bug).** Do not return resources tied to strategies the caller did not select. EXCEPTION: for a strategy_clarity caller, surface strategy EDUCATION / direction (via the secondary questions in item 12), never off-strategy VENDORS. That exception is what kills the STR-vendor recommendation without killing the legitimate strategy-exploration a confused new investor needs.

3. **Tier ordering (fixes volume failure 2).** Order whatever survives the gates by where it sits in the investor's journey:
   - Foundational — strategy clarity, direction-setting education (what a lost new investor needs first)
   - Enabling — tools and knowledge to act once direction is set
   - Transactional — vendors (lenders, contractors, title) needed once actually doing a deal
   Resources have DEPENDENCIES: a lender is useless before a strategy exists. So order is not "most relevant first" but "what do they need to do FIRST." Likely needs a tier label/column on resources so the matcher can sort by it.

**Delivery pattern:** Lani delivers the top 1-2 from the highest-relevant tier, framed as the starting point ("the best place to start is X; once you have that, there's more I can point you to"). At close, invite back ("when you're ready to go deeper, call back and we'll pull the next set"). Benefits: prevents overwhelm, respects dependency order, and creates a reason to return (engagement, good for a membership org). Applies mostly to Path A but can apply to Path B.

**Where it lives:** stage gate + strategy respect in resources.js / the routing matrices; tier ordering needs a tier label on resources; the 1-2-then-invite delivery is Lani prompt logic plus a cap on what getResourceStack surfaces.

**Still to decide before building:** hard vs soft stage exclusion (leaning hard); the exact per-stage exclusion rules; whether foundational/enabling/transactional is the right tier model or needs adjusting to the real catalog; the tier-label mechanism (column vs mapping).

**Testing-phase caveat:** because categories are real but records are placeholders, the item-12 service-gap log will be noisy (a category looks served by a placeholder when really no usable vendor exists yet). Do not misread the gap log during this phase.

### 14. OPEN — Lender routing matrix (lenders are not interchangeable)
Lenders offer different services and serve different investor types and asset types. A hard money lender for a fix-and-flip, a DSCR lender for a buy-and-hold rental, a commercial lender for flex space, and a private/creative-financing source are NOT interchangeable, but the current vendor matching treats "lender" as one bucket. Need a dedicated lender matrix (or a lender sub-dimension on the vendor matrix) that routes on: lending product type, investor type served, and asset type served. So a caller doing commercial flex space does not get handed a residential fix-and-flip lender. Ties into Map 2 (vendor matching keys on need-category + strategy) and into the RESPA/tier framework (Tier 5 RESPA-covered settlement providers vs Tier 4 RESPA-exempt business-purpose lenders). Design the matrix before seeding real lender records so the categories are right from the start.

### 15. OPEN — Data retention / purge process for old call data
No process currently purges old voice_agent_calls data. Need to (a) research and decide a retention window (how long call transcripts, summaries, structured outputs, and stack-link caches should be stored — consider privacy norms, any applicable regulation, and practical value of old call data), then (b) build a scheduled purge (Supabase scheduled job or the existing Vercel cron pattern) that deletes or anonymizes records older than the window. Decide per-table: voice_agent_calls, voice_agent_stack_links, readiness_surveys, and any transcript storage. Open question to resolve first: what is the retention window, and does anything require keeping vs deleting.

### 16. OPEN — Purge data for contacts deleted from GHL
When a contact is deleted in GHL, their associated voice-agent data in Supabase currently persists (orphaned). Need a process that detects GHL deletions and purges the corresponding Supabase records so deleted contacts do not leave data behind. Design question: how do we learn a contact was deleted — a GHL webhook on delete, or a periodic reconciliation that compares Supabase contacts/calls against GHL and removes those no longer present. Reconciliation is simpler and matches the existing nightly-sync pattern; a delete webhook is more immediate. Note the known constraint: GHL custom objects are not readable from external IPs (Vercel/Supabase get 403), so any reconciliation that needs custom-object reads must run through GHL MCP within a session, not an edge function. Confirm whether the contact-level delete signal is reachable from an edge function or also needs MCP.

---

## KNOWN-BUT-DEFERRED (design gaps, not urgent)

- `intake_routing_rules` scores only on stage/strategy/blocker. Goal, resources, already_tried are collected and passed to getResourceStack but do not steer rule selection.
- The blocker trio (capital/deals/team) all map to one `blocker` param; two of three are unreachable. Would need a conditional mechanism (parent_question_key + trigger_value) to make them live.
- `ask_vendor_investor_primary_need` maps to `vendor_primary_need`, which is in no Path V FLOW array, so it never fires. Relevant for "Both" callers.
- Two drifted applies_to_stages: `ask_resources_credit` is Path A only (designed for active too); `ask_support_network` fires for everyone (designed getting_started + active only).
- call_duration_secs comes back null on vendor calls (startedAt/endedAt path mismatch). Cosmetic.

---

## HARD CONSTRAINTS (never violate)

- Voice agent custom fields must be TEXT. Option-type fields do not receive webhook payloads.
- Additive-only on routing/intake tables: deactivate (is_active=false), never delete.
- Three-layer coupling: a dimension needs (1) intake_questions row, (2) Vapi tool param, (3) intake.js tracking. Break one and the agent repeats a question.
- Order comes from intake.js FLOW arrays, NOT the priority column. Priority only breaks ties within one param.
- Written form is always "Utah REIA". Pronunciation is a voice-layer rule.
- index.html greetings are single-quoted JS: no apostrophes ("I am Lani", never "I'm Lani").
- Nothing automated writes to vendor_resources. Human vets and promotes. That is the vetting gate.
- Closing word is "Mahalo", nothing else. Never read URLs aloud. No em dashes.

---

## IDs AND LOCATIONS

- Supabase project: kttzxjddtkgsitzehiid
- GHL main location: oMOSHj4e9WNfMfx8MkBo
- GHL vendor object location: DNirEjy0ejVwbHsaBYrn
- Vercel: voice-agent-ai-nu.vercel.app
- Vendor field IDs: Service Type ESvM4hhpSnQWiuluGard, Investor Types 1nvU9eGll7NYZ73YIR7e, Market vdrZr28gqAsDntrN6CPG, REIA Connection kzolZI3cyPGf4THu00T0, Enrollment Interest tvoRTYDCkAbIjslA7PGC, Follow Up Preference ttt3eBFkIUjIqV6JBrpF, Summary IzhYTD89SrsXDUZFGxLK

---

## CARRIED OVER FROM "David - Utah REIA voice agent project summary" CHAT

Reconciled against later work. Items already done there (Path V build, getVendorMatch zip, getCallerHistory tool, the four structured outputs commercialAssetTypes/wantsMentorConnection/wantsProfessionalConnections/wantsOffMarketDeals, Contact Found branch field population) are NOT relisted here because our sessions or that chat already closed them. Only genuinely still-open items appear below.

### Educators
- **OPEN** — Add Dr. Jason Williams to GHL, sync to Supabase ghl_educators_mentors. Ensure educators_url (booking URL) is populated before sync or stackSummary cannot produce a link.
- **OPEN** — Add Jeremy Davis to GHL, sync to Supabase. Same booking-URL requirement.
- **OPEN** — ElevenLabs Creator plan upgrade for Harmonie voice clone quality.

### GHL workflow
- **OPEN** — Add `Event Register New` as a trigger in the GHL-to-Claude-via-Supabase workflow.
- **OPEN** — Mohammed notification SMS in the workflow's educator branch (notify Mohammed when a caller is matched to him). NOTE: revisit as "educator notification" generally, since the system now supports multiple educators, not just Mohammed.

### Survey routing
- **OPEN** — Survey Routing Workflow full end-to-end test: confirm routing_results table populates and the survey routing webhook fires. (Distinct from the approval item; this is the test after approval.)

### Deployment hygiene
- **OPEN / VERIFY** — "Push all updated JS files to GitHub" was a pending item there (vendors.js, education.js, sync-educator.js, context.js, ghl-sync.js, member-lookup.js, caller-history.js, member-history.js). Likely superseded now that work runs through Claude Code with a clean working tree, but confirm none of these were left un-pushed from the pre-Claude-Code era.

### Future / roadmap (not urgent, parked)
- **OPEN** — Coverage gap report across logic tables. Systematically verify nothing is orphaned: every strategy maps to an archetype AND has education coverage, tool coverage, vendor/resource coverage. Surfaced when short_term_rental was found orphaned (no archetype) during archetype design — exactly the silent gap that goes unnoticed until an affected caller calls. Should also flag strategies present in one table but missing from a dependent one (e.g. a strategy in intake_routing_rules with no education_routing_matrix row). Run periodically; treat like the existing content-audit pattern. Prevents silent holes system-wide, not just in the roadmap tables.
- **OPEN** — Scored/numeric confidence matching in the routing matrices. The secondary-questioning match chain (item 12) uses Lani's judgment for the confidence line in v1. Later, have vendor_routing_matrix and education_routing_matrix emit a numeric match score so the close-match confidence line is computed (deliver if above N) rather than judged. Bigger project: requires a scoring model on the matrices.
- **OPEN** — Commonly-asked-question / problem tracker. Interactive log that captures what callers actually ask, feeding the problem taxonomy (item 12) so it grows from real calls rather than guesswork. Overlaps with the two gap logs in item 12.
- **OPEN** — Dashboard for Chris: call volume, top blockers, routing distribution, educator bookings (from voice_agent_calls and routing_results).
- **OPEN** — Post-call follow-up tracking: 72-hour check-in SMS ("Did you connect with the vendor?").
- **OPEN** — Multi-language support (Spanish path for the Latino investor community).
- **OPEN** — Inbound SMS routing as an alternative to voice calls.

### Reference
- Asana Chat 2 task GID: 1214411058392126 (current source of truth per that chat).
- Routing framework Google Drive doc ID: 1K-0UtZKnrWtV9-E-TwpZKZKuWwzwcX6gqaFmMutNR7c

---

## INTAKE QUESTION REVIEW (grounded in Maps 1, 2, 3)

Purpose of the review: every question must collect an answer in the SHAPE the maps actually route on, and must reveal genuine FIT (the anti-guru mission: right resource at the right time, not one expensive program sold to everyone). Maps are strong evidence of intent, not scripture; adjust where the goal demands it.

**What actually drives routing (confirmed from the maps):**
- Map 1: routes on stage + goal + strategy + readiness + current-need + resources. Readiness = "active vs learning" (NOT a 1-10 scale). Capital/credit/time = constraints that ELIMINATE strategies before routing.
- Map 2 (vendors): keys on need-category + strategy. "Investor selects need (Deals, Funding, Team, etc.) + strategy → match vendor categories." Capital/credit/time do NOT drive vendor matching.
- Map 3 (education): keys on stage + strategy. Stage = depth, strategy = topic. Has a "Not Sure Yet" track (Strategy Discovery Course, 1-on-1 mentoring) = the correct home for strategy_clarity callers. Has strategy-INDEPENDENT tracks: Mindset/Performance Psychology, Accountability Coaching. These serve the person, not the strategy = the fit-detection mission encoded.

**Verdicts per question:**
- strategy (A + B) — ESSENTIAL, topic axis for Maps 2 and 3. Keep.
- stage — ESSENTIAL, depth axis for Map 3. Keep.
- current need / blocker general — ESSENTIAL, need-category axis for Map 2 vendor match. Keep and ELEVATE.
- goal — Keep (Map 1 input, prunes the tree).
- readiness — REBUILD THE QUESTION. Dimension is real (Map 1 input) but the table asks a 1-10 scale; the map routes on "actively pursuing vs mostly learning vs learning while moving." Change question to capture active-vs-learning.
- capital / credit / time — Keep, but they matter for STRATEGY SELECTION, not for a caller who already knows their strategy + need. A Path B caller who knows both may not need them. Time is the softest of the three.
- learning_format (ask_resource_preference) — Keep. Map 3 resolves it (course vs mentor vs group vs tools).
- education_history AND already_tried — KEEP BOTH. Not a direct map input, but together they reveal the KNOWLEDGE-vs-EXECUTION gap (read 10 books, made 0 offers = execution problem, not a foundation problem). This is central to fit-detection and is exactly what the guru model ignores. Reframe as: education_history = knowledge acquired; already_tried = action taken. Make them clearly distinct so they stop feeling redundant (George call: caller said "you just asked me that").
- knowledge_intent — Keep (Map 1 "topics to learn").
- timeline — SOFT. Overlaps readiness. Reconsider once readiness is rebuilt to active-vs-learning.
- specific sub-blockers (ask_blocker_capital / deals / team) — RECONSIDER. All fill the one `blocker` param; two of three never fire in code. Only justified if they refine the Map 2 need-category. Otherwise redundant with the general need question.

**Opening question (caller_type) — the vendor-vs-investor fork:**
- Two priority-1 rows was the surface complaint. Real issue: `ask_caller_type` is a DEAD ROW (caller_type is in no FLOW array, pickNext never returns it), so `ask_stage_new` is what actually gets asked first. This is why vendors got asked the investor "getting started or active?" question.
- DECIDED direction: caller_type should be the true first question AND be reachable/forked in code (this is the "Option A" fork previously parked). Route: vendor → Path V; investor → stage → A/B; both → ask_vendor_investor_primary_need.
- REPHRASE, investor-first with a vendor nudge (not a cold switchboard): lead with the investor, let the vendor self-identify into a welcomed side door. e.g. "To point you in the right direction, are you looking to grow your own real estate investing, or are you a service provider hoping to connect with our investor community?"
- OPEN UX decision: ask caller_type out loud to everyone, OR have the web entry point pre-set investor (with a separate vendor entry) so Lani only asks when ambiguous. This is investor-first product; most web callers are investors. Tradeoff: friction on the common case vs catching the rare vendor.

**Cross-links:** strategy_clarity → Map 3 "Not Sure Yet" track (item 12/13). readiness rebuild + capital/credit as strategy-eliminators tie into the resource hierarchy (item 13). Mindset/Accountability tracks are the fit-detection destinations that make the anti-guru mission real.

**Still to decide before editing the table:** whether to collapse the sub-blockers into the general need question; final wording for the rebuilt readiness question; final distinct wording for education_history vs already_tried; the caller_type UX (voiced vs web-preset); and whether timeline survives.
