# Intake Loop Fix — Checklist

Findings from the George Testing call (2026-07-21), the `getIntakeRouting`
schema review, and the Jonathan Johnson verification call (2026-07-22).

Steps 1-6 are the original pass. Steps 7-11 came out of the verification call
and the `getResourceStack` discovery that followed it.

| #  | Item                                              | Where  | Deploy? | Status |
| -- | ------------------------------------------------- | ------ | ------- | ------ |
| 1  | Add`specific_need` parameter                    | Vapi   | no      | [x]    |
| 2  | Test call: Path B no longer loops                 | Vapi   | no      | [x]    |
| 3  | Replace tool description                          | Vapi   | no      | [x]    |
| 4  | Add enums to`blocker`, `stage`, `strategy`  | Vapi   | no      | [x]    |
| 5  | Deploy`intake.js` (blocker floor + COVERED_BY)  | Vercel | yes     | [x]    |
| 6  | Verification call: Path A blocker routing         | both   | no      | [x]    |
| 7  | Remove the`getResourceStack` remap              | Vercel | yes     | [x]    |
| 8  | Fix the stage vocabulary mismatch                 | Vercel | yes     | [x]    |
| 9  | Add 2 missing aliases to`education.js`          | Vercel | yes     | [x]    |
| 10 | Stop Lani inventing questions                     | Vapi   | no      | [ ]    |
| 11 | Decision: tier on the three`deals` rules        | Chris  | n/a     | [ ]    |

Steps 7, 8 and 9 shipped together. Re-run the step 6 call to verify, and add a
Path B call (an active investor) since that is the path steps 7 and 8 unblocked.

**Correction to an earlier version of this document.** Step 7 was originally
written as "stop Lani calling the wrong tool" and blamed the tool description,
and step 3 was marked as having failed to apply. Both were wrong. There is no
`getResourceStack` tool in Vapi at all, so `intake.js` was naming a tool that
does not exist and Lani was substituting the nearest one she had. The
description was never the problem and step 3 is marked done.

Already done, no action needed:

- Supabase: four `ask_blocker_*` rows widened to include `exploring__new` and
  `getting_started`. Live.
- Supabase: `ask_resources_credit` reworded (2026-07-22). The original wording
  drew "I don't think I can understand that question" on the Jonathan Johnson
  call. Replaced with Lani's own successful rephrase, keeping the
  "without getting too personal" softener.
- `api/intake.js`: `blocker` added to `FLOW.A.required`, `COVERED_BY` map added
  so `education_history` and `already_tried` stop double-asking. Live in
  `origin/main` at 4eaf3e0.

---

## Before you start

Open these in tabs:

- Vapi dashboard, your assistant, **Tools** → **getIntakeRouting**
- Vercel project `voice-agent-ai-nu`, **Logs**
- Supabase project `kttzxjddtkgsitzehiid`

The parameters panel has a **Visual / JSON** toggle top right. The JSON view is
faster and less error-prone for these edits. Leave **Lock schema (no additional
properties)** unchecked, as it is now.

---

## Step 1 — Add `specific_need`

**Do this first.** It is a live loop hitting real callers and needs no deploy.

Any caller who says they are already investing resolves to Path B, whose entire
required floor is `specific_need` (`api/intake.js`, `FLOW.B`). The tool asks
"What specifically do you need right now?", the caller answers, and Lani has no
parameter to report it in. The value stays empty, so the tool returns the same
question again. Forever.

1. Tools → getIntakeRouting → Parameters → **JSON** toggle
2. Add this property alongside the existing 23:

```json
"specific_need": {
  "type": "string",
  "description": "What the caller specifically needs right now, in their own words. Example: a lender, a contractor, off-market deals, a property manager. Required to complete Path B for active investors."
}
```

3. Save, then publish the assistant.

Verify: the parameter list should now show 24 entries, with `specific_need`
sitting between `already_tried` and `vendor_market` in the visual list (the
panel sorts by name length, and all three are 13 characters).

---

## Step 2 — Test call: confirm Path B no longer loops

Do this before touching anything else, so you know step 1 worked in isolation.

1. Place a web call via `index.html`
2. Give a name, then say **"I am already active, I have four rentals"**
3. Lani should ask "What specifically do you need right now?"
4. Answer **"I need a property manager"**

Pass: she moves on to a recommendation.
Fail: she asks "What specifically do you need right now?" a second time. If so,
`specific_need` is not reaching the tool. Check the Vercel log for the request
body and confirm the key is present.

---

## Step 3 — Replace the tool description

The current description tells the model three things the code does not do, and
each one causes a specific misbehaviour you have already seen on calls.

| Description says                                       | Code actually does                         | Symptom on the call                               |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------- |
| routing arrives at 3 dimensions                        | Path A needs 7-8; no count exists anywhere | Lani improvises questions to make progress        |
| next tool is`getEducationMatch` / `getVendorMatch` | both remap to`getResourceStack`          | she called`GetVendorMatch`, it returned nothing |
| pass these 7 dimensions                                | 23 dimensions are tracked                  | unlisted ones get under-reported, then re-asked   |

Replace the whole description with:

```
Returns either the next intake question or the routing decision.
Call after every caller answer.

Pass every dimension you have learned so far on EVERY call, not just
the newest one. Omitting a dimension you already collected will make
the tool ask for it again.

Read the result:
- action "ask_more": ask next_question word for word. Do not skip
  ahead, do not substitute your own wording, do not call another tool.
- any other action: say voice_bridge, then call the tool named in
  action using tool_args exactly as given. This is usually
  getResourceStack.

There is no question count. Keep calling until it stops returning
ask_more.
```

Save and publish.

---

## Step 4 — Add enums to `blocker`, `stage`, `strategy`

Every parameter is currently a bare `string`. These three are compared with
strict `===` against the Supabase rules (`api/intake.js`, the scoring block), so
free text silently fails to match and the call quietly falls back to a weaker
rule. No error appears anywhere.

`blocker` is the one that matters most, because step 5 makes Path A collect it.
Without the enum, step 5 buys you the question but not the routing.

```json
"blocker": {
  "type": "string",
  "description": "The single biggest thing holding the caller back, normalized to one of the listed values. Pick the closest match. Use escalation only if the caller is frustrated or asks for a human.",
  "enum": [
    "analysis_paralysis", "build_network", "capital", "connections",
    "deal_analysis", "deals", "education", "escalation", "legal",
    "management", "mindset", "numbers_confidence", "strategy_clarity",
    "take_action", "team"
  ]
},
"stage": {
  "type": "string",
  "description": "Where the caller is in their investing journey.",
  "enum": [
    "exploring__new", "getting_started", "active_investor",
    "experienced_investor", "veteran__operator"
  ]
}
```

Note the **double underscore** in `exploring__new` and `veteran__operator`.
These come from GHL-generated field values and are immutable; a single
underscore will not match.

And `strategy`, the 29 values currently live in `intake_routing_rules`:

```json
"strategy": {
  "type": "string",
  "description": "The investing strategy the caller is pursuing or most interested in, normalized to one of the listed values. The spoken question only offers a few examples, so map whatever they say to the closest value. Use industrial for warehouse, flex space or distribution; commercial only as the general fallback when they say commercial without naming an asset type. Use not_sure if they have not settled on a strategy.",
  "enum": [
    "assisted_living", "brrrr", "buy_and_hold", "commercial",
    "creative_financing", "development", "farm_land", "fix_and_flip",
    "hotel", "house_hacking", "industrial", "land_entitlement",
    "mentoring_others", "mid_term_coliving", "mobile_home", "multi_family",
    "not_sure", "notes_lending", "out_of_state", "passive_investing",
    "raising_capital", "retail", "rv_parks", "self_storage",
    "short_term_rental", "syndication", "tax_deeds_liens",
    "tax_optimization", "wholesale"
  ]
}
```

`strategy` carries more mapping work than the other two. `ask_strategy_general`
only says "rentals, flipping, wholesaling, short-term rentals, or something
else", so almost every real answer arrives as something the question never
offered, and the description is the only thing turning it into one of these 29.
George's "commercial industrial flex space" is the typical case.

If you add strategy rows later, re-pull the list and update the enum, or the new
rows will be unreachable the same way the blocker rules were:

```sql
select distinct strategy from intake_routing_rules
where is_active = true and strategy is not null order by strategy;
```

Save and publish.

---

## Step 5 — Deploy `intake.js`

The code change is committed locally but not live. It does two things:

- adds `blocker` to `FLOW.A.required`, so new investors get asked their blocker
  instead of Lani improvising it, and the ~10 `getting_started` blocker rules in
  `intake_routing_rules` stop being unreachable
- adds `COVERED_BY`, so `education_history` and `already_tried` satisfy each
  other and stop reading as the same question twice

```powershell
git add api/intake.js
git commit -m "Collect blocker on Path A and stop education/already_tried double-ask"
git push
```

Vercel auto-deploys from `main`. Wait for the deployment to go green before
step 6.

The expected Path A sequence afterwards is eight questions:

```
1. stage      3. goal      5. capital   7. education_history
2. strategy   4. blocker   6. credit    8. time_availability
```

---

## Step 6 — Verification call

Replay George's scenario: a commercial investor who cannot find deals.

1. Web call, give a name
2. "I am just getting started"
3. "Commercial industrial, flex space"
4. "Getting two additional properties"
5. Lani should now ask the blocker question **as question 4**, driven by the
   tool rather than improvised
6. "I have not come across the right deal yet"

Then read the Vercel log for this line, emitted by `api/intake.js`:

```
Intake routing — path: A | stage: getting_started | blocker: deals | action: getResourceStack | tier: ...
```

What to check:

- `blocker:` is `deals`, not a sentence. A sentence means step 4's enum did not
  take and no blocker rule will ever match.
- `path:` is `A`
- Lani asks the blocker question once, and `already_tried` never appears

Also check `Structured data extracted:` in the `ghl-sync` log. Per CLAUDE.md,
if a key is missing from that object it is a Vapi structured-output problem, not
a code problem.

### Result — Jonathan Johnson call, 2026-07-22 17:24

```
17:24:51 POST /api/intake 200
Intake routing — path: A | stage: getting_started | blocker: deals | action: getResourceStack | tier: 3_educator
```

Passed:

- `blocker: deals`. The step 4 enum normalized "cannot find deals" into the
  exact token, so the rule matched.
- `tier: 3_educator` came from **Getting Started - Deal Finding**, a rule that
  was unreachable before this work. The whole chain is proven end to end.
- `already_tried` was never asked. The original complaint is fixed.
- The blocker question was correctly **skipped**, not missing. Jonathan
  volunteered it inside his goal answer ("A commercial investor. Cannot find
  deals"), so `haveAnswer('blocker')` was already true. This is the sufficiency
  model working as intended, and it is why the sequence ran seven questions
  rather than the eight predicted above.

Failed:

- The tool returned `action: getResourceStack`. Lani called
  **getEducationMatch**. See step 7.
- Tier landed on `3_educator`, confirming the step 11 concern with live data.

---

## Step 7 — Remove the `getResourceStack` remap

**There is no `getResourceStack` tool in Vapi.** `intake.js` remapped every
Path A and Path B routing decision to it, so it has never once worked. Lani was
not disobeying; she was handed a tool name that does not exist and substituted
the closest one she had.

Proof from the Jonathan call:

```
17:24:51  POST /api/intake     -> action: getResourceStack
17:24:54  POST /api/education  -> Education match: Commercial Real Estate Execution Track
```

`/api/resources` was never called. No `getResourceStack args:` line exists in
any log. The tools that do exist are `getEducationMatch` (-> `/api/education`)
and `getVendorMatch` (-> `/api/vendors`). The comment at `api/resources.js:7`
claiming all three route to `resources.js` is false, and `resources.js` is
currently dead code.

Fix applied in `api/intake.js`:

- deleted the remap so the rule's own `routing_action` passes through
- both catch-all fallbacks now name `getEducationMatch` instead
- added a `VALID_ACTIONS` guard, because two live rules carry a tier value in
  the action column and would otherwise tell Lani to call a tool named `1_info`:

| rule                                | priority | routing_action |
| ----------------------------------- | -------- | -------------- |
| Property Listings - Wholesale Strategy | 8     | `1_info`     |
| Property Listings - Deals Blocker      | 10    | `1_info`     |

Those two rows should be corrected in Supabase rather than left to the guard.
The guard logs a warning naming the rule when it fires.

### Why not wire up getResourceStack instead

It was considered and rejected for now. `resources.js` runs, but
`api/resources.js:124` fetches `education_routing_matrix` with **no stage or
strategy filter** (top 5 by priority for everyone), and the tools query is the
same. Only its vendor query filters on strategy. A live smoke test with
Jonathan's exact inputs returned a BRRRR track, a fix-and-flip rehab estimator
and two test records, where `/api/education` returned the correct Commercial
Real Estate Execution Track.

Wiring it up today would trade a correct answer for a generic one. Doing it
properly means giving the education and tools queries the same stage/strategy
fallback chain `education.js` already has, which is its own piece of work.

---

## Step 8 — Fix the stage vocabulary mismatch

Two incompatible vocabularies for the same concept:

| used by                                                            | values                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `intake_routing_rules.stage_key`, `intake_stages.stage_key`     | `active`, `experienced`, `exploring`, `veteran`, `getting_started` |
| `intake_questions.applies_to_stages`, `intake.js`, the Vapi enum | `active_investor`, `experienced_investor`, `exploring__new`, `veteran__operator`, `getting_started` |

The scoring block compares `rule.stage_key === stage`, so `'active'` never
equals `'active_investor'` and the rule is dropped as a mismatch.
**`getting_started` is the only value spelled the same in both**, which is why
both test calls routed correctly and nothing looked broken.

Of 164 stage-specific rules, only the 36 `getting_started` ones could ever
match. The other 128 were dead: 36 active, 34 exploring, 30 experienced,
28 veteran. The `intake_stages` lookup was failing the same way, so
`stage_context` was null for every caller except `getting_started`.

Concrete effect, active investor running fix and flip who cannot find deals:

| | rule matched | tier | action |
| --- | --- | --- | --- |
| before | Property Listings - Deals Blocker | `1_info` | `1_info` (not a tool) |
| after  | Active - Needs Deals              | `2_vendor` | `getVendorMatch` |

Fix applied in `api/intake.js`: a `RULE_STAGE_KEY` map, applied to the
`intake_stages` query and the rule scoring only. Question filtering keeps the
long form, since `applies_to_stages` is authored that way. The routing log line
now prints both forms.

---

## Step 9 — Add the 2 missing aliases to `education.js`

`api/education.js:68` has a `stageMapping` for this exact problem, but it is
incomplete. It maps `active_investor` and `veteran__operator`, and misses:

- `exploring__new` -> `exploring`
- `experienced_investor` -> `experienced`

Unmapped values fall through to `rawStage` and match nothing in
`education_routing_matrix`, so those two stages silently get the fallback track.
Two lines added to the existing map, no new structure.

`api/vendors.js` was checked for the same bug. It accepts `stage` and logs it
but never uses it in a query, so no third instance exists.

---

## Step 10 — Stop Lani inventing questions

Two off-script questions across two calls:

- George call: the blocker question, improvised with no tool call before it.
  This one is now fixed at the source, since Path A collects `blocker` properly.
- Jonathan call: "Roughly, what range are you working with? Under 10010 to or
  more than that?" There is no capital-range row in `intake_questions`. The
  numbers came out garbled and the question sounds intrusive.

The architecture assumes every question comes from Supabase. Anything Lani
invents is untracked, unroutable, and cannot be tuned without a code change.
The new tool description added a line for this ("do not skip ahead, do not
substitute your own wording"), which is already live from step 3. If the next
test call still shows invented questions, the instruction needs to move into
the system prompt, since the prompt outranks the tool description.

Do **not** fix this by adding a capital-range row. That creates a new dimension
requiring all three coupled layers, for a question nobody asked for.

---

## Step 11 — Decision for Chris

Once Path A collects a blocker, George's scenario changes tier. Scoring path A /
`getting_started` / `industrial` / `deals`:

| rule                                      | score | priority | tier           |
| ----------------------------------------- | ----- | -------- | -------------- |
| Getting Started - Deal Finding            | 15    | 31       | `3_educator` |
| Commercial - Industrial - Getting Started | 15    | 126      | `2_and_3`    |

They tie on score, and the tiebreak is lowest priority number wins, so the
blocker rule takes it and the tier drops from `2_and_3` to `3_educator`. The
resource stack is unaffected, since both remap to `getResourceStack`, but the
GHL tier field changes and that is what the workflow routes on. In practice a
commercial investor who cannot find deals stops being tagged for the vendor
side, which is how George got PropStream on the test call.

Recommendation: promote the three `deals` rules to `2_and_3`. Someone who cannot
find deals wants a vendor as much as a course. Needs Chris's sign-off, then:

```sql
update intake_routing_rules set tier = '2_and_3'
where is_active = true and blocker = 'deals';
```

---

## Rollback

- **Steps 1, 3, 4 (Vapi):** revert the parameter or description in the dashboard
  and republish. Nothing else depends on them.
- **Step 5 (code):** `git revert` the commit and push. Safe on its own, since
  the widened Supabase rows are inert without `blocker` in `FLOW.A.required`.
- **Supabase blocker rows:** to undo the widening, restore the original stage
  list. Follow the additive-only rule and do not delete the rows.

```sql
update intake_questions
set applies_to_stages = ARRAY[
  'active_investor','experienced_investor','veteran__operator'
]::text[]
where question_key in (
  'ask_blocker_general','ask_blocker_capital','ask_blocker_deals','ask_blocker_team'
);
```

---

## Known, not covered here

Logged so they are not lost, but out of scope for this pass:

- `ask_caller_type` is unreachable. `caller_type` is in no `FLOW` list, so
  `pickNext()` can never return it. The vendor fork has no question that leads
  into it, which is likely the "asked the stage question twice before accepting
  I'm a vendor" open item.
- Question order comes from the `FLOW` arrays in code, not the `priority` column
  in `intake_questions`. CLAUDE.md says the table owns order; it does not. The
  code order is the better one, so the doc is what should change.
- Name capture takes three turns (first, last, then spell both). Prompt-level,
  not code.
