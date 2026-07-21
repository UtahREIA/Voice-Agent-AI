# Intake Loop Fix — Checklist

Findings from the George Testing call (2026-07-21) and the `getIntakeRouting`
schema review. Work top to bottom. Steps 1-4 are Vapi dashboard only and need
no deploy; step 5 is the deploy.

| # | Item | Where | Deploy? | Status |
| --- | --- | --- | --- | --- |
| 1 | Add `specific_need` parameter | Vapi | no | [ ] |
| 2 | Test call: Path B no longer loops | Vapi | no | [ ] |
| 3 | Replace tool description | Vapi | no | [ ] |
| 4 | Add enums to `blocker`, `stage`, `strategy` | Vapi | no | [ ] |
| 5 | Deploy `intake.js` (blocker floor + COVERED_BY) | Vercel | yes | [ ] |
| 6 | Verification call: Path A blocker routing | both | no | [ ] |
| 7 | Decision: tier on the three `deals` rules | Chris | n/a | [ ] |

Already done, no action needed:

- Supabase: four `ask_blocker_*` rows widened to include `exploring__new` and
  `getting_started`. Live now, inert until step 5.
- `api/intake.js`: `blocker` added to `FLOW.A.required`, `COVERED_BY` map added
  so `education_history` and `already_tried` stop double-asking. Committed
  locally, **not deployed**.

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

| Description says | Code actually does | Symptom on the call |
| --- | --- | --- |
| routing arrives at 3 dimensions | Path A needs 7-8; no count exists anywhere | Lani improvises questions to make progress |
| next tool is `getEducationMatch` / `getVendorMatch` | both remap to `getResourceStack` | she called `GetVendorMatch`, it returned nothing |
| pass these 7 dimensions | 23 dimensions are tracked | unlisted ones get under-reported, then re-asked |

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

For `strategy`, pull the current list straight from the source of truth rather
than copying it here, since rows get added:

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

---

## Step 7 — Decision for Chris

Once Path A collects a blocker, George's scenario changes tier. Scoring path A /
`getting_started` / `industrial` / `deals`:

| rule | score | priority | tier |
| --- | --- | --- | --- |
| Getting Started - Deal Finding | 15 | 31 | `3_educator` |
| Commercial - Industrial - Getting Started | 15 | 126 | `2_and_3` |

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
