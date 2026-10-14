# Routing Scoring Redesign — Design

Status: **Phase 1a + 1b SHIPPED** (2026-08-18). Phase 2 optional/pending. Author: David + Claude.

## How it works — as built, plain English (Phase 1a + 1b)

*(For explaining to Chris. The design detail is below; this is the mechanism as it now runs.)*

**Where it runs:** inside the `/api/resources` endpoint — the one Lani calls as
`getResourceStack` to build a recommendation. It's a small scoring function named
`reRank`.

**The inputs were already there.** When Lani calls `getResourceStack`, the arguments Vapi
sends include everything the intake collected — the caller's `credit`, `capital`,
`already_tried`, `education_history`, `deal_count`, `readiness`. Before this work those
just sat unused; now `reRank` reads them.

**The mechanism (soft re-order, never delete):**
1. `/api/resources` gathers matching resources into five buckets (vendors, education,
   tools, educators, events), each with a priority number (lower sorts higher).
2. `reRank` runs over every resource and computes a small +/- adjustment to its priority
   from the caller's signals.
3. The buckets are re-sorted by the adjusted number, then the final stack is picked.
   Because it only nudges the order and never removes anything, the stack can't come out
   empty.

**Phase 1a (credit / capital):** if the caller's credit reads weak or capital reads low,
any resource whose name/description/tags mention creative or private/hard money is nudged
**up**; anything mentioning conventional or bank loans is nudged **down**. Result: a
no-money-down, rough-credit caller sees creative and private-money financing first.

**Phase 1b (knowledge-execution gap):** if `education_history` shows lots of learning
(books/courses/mentors/BiggerPockets) **and** an action signal shows little done (0 deals,
"haven't made an offer", "still learning"), then execution/accountability resources (deal
analysis, calculators, coaches, deal-finding) are nudged **up** and beginner "intro/101"
theory is nudged **down**. Result: the perpetual student stops getting handed another
course.

That's the whole thing — signals that were already collected now tilt the ordering, in
one function, in one file, with **no database or plumbing changes**.

---

## The problem

The intake routing scores a caller on only **three** things — stage, strategy, and
blocker — when deciding what to recommend. It *collects* far more (goal, capital,
credit, education history, what they've already tried, readiness), but none of it
shapes the recommendation.

Consequence: two callers with the same stage/strategy/blocker get the **same
recommendation even when their situations are opposite** — e.g. one tapped out on
credit vs one with strong credit, or one who has read everything but never done a
deal vs one who has done deals but never studied. That last case is exactly the
**knowledge-execution gap** the anti-guru mission is built to detect, and right now
the routing is blind to it.

## Current mechanism (two layers)

1. **`intake_routing_rules` scoring** (`intake.js`, ~line 551): each rule may match on
   `stage_key` (+10), `strategy` (+5), `blocker` (+5); a specified-but-mismatched
   dimension **excludes** the rule; highest score wins, ties broken by priority.
   The winning rule supplies only the **tier** and the **voice_bridge** (framing) —
   it no longer picks the resources.
2. **`getResourceStack`** (`resources.js`): does the actual resource selection, on
   stage / strategy / blocker / topics.

### The finding that makes this easy

`intake.js` already passes **all the rich signals** into `getResourceStack`'s
`tool_args` (`mergedArgs`, ~line 602): `goal, capital, credit, education_history,
already_tried, readiness` all arrive at `resources.js`. **They are simply never
used for ranking.** So the highest-value work needs **no new data plumbing** —
only new logic in `resources.js`.

## Design — Phase 1: soft re-rank in `resources.js` (the high-value work)

Do **not** hard-filter (risk: empty stacks) and do **not** expand rule-matching
combinatorially (risk: rule explosion). Instead add a **signal-based soft re-rank**:
after the category buckets are built and before the final round-robin/`top`
selection, adjust each resource's effective priority by bounded weight deltas from
the caller's signals. Nothing is ever zeroed out — the best-fit just floats up.

### Signal → adjustment

| Signal | Effect on ranking |
| --- | --- |
| `already_tried` names a resource/category | **down-weight** matching resources — don't re-serve what they've already done |
| `credit` weak ("no", "bad", "poor", "rebuilding") | **up** creative finance, private/hard money, credit-repair education; **down** conventional mortgage |
| `capital` low ("little to no money down") | **up** wholesale, creative, house-hacking, private money; **down** capital-heavy (conventional buy-hold, commercial) |
| `goal` = scaling / systems | **up** systems, team, operations, portfolio-lending; **down** beginner foundational |
| `goal` = first deal / learning | **up** foundational education + execution tools |
| **`education_history` HIGH + `already_tried` LOW** (the gap) | **up** execution / accountability resources over more courses — the anti-guru core |
| `readiness` = actively doing | **up** transactional (lenders, deals); learning-oriented → **up** education |

### Where it hooks

`resources.js` sorts each bucket by `priority` then round-robins into `top`. Add a
`reRank(resource, signals)` that returns a small priority delta, applied before the
sort. Signals are normalized to **bands** (weak/strong, low/high, scaling/first-deal)
with keyword matching — the same pattern as the existing `learningGoal` regex, which
keeps it robust against free-text answers.

## Design — Phase 2 (optional, later): rule-level signals for framing

Add nullable columns to `intake_routing_rules` (`goal`, `credit_band`,
`capital_band`) and extend the scoring loop (+2 each, mismatch-tolerant: a rule that
*specifies* a signal and matches gets a bonus; a rule that doesn't specify it is
unaffected). This lets a specific rule supply a tailored **tier / voice_bridge** —
e.g. a "scaling investor maxed out on conventional" rule with a bespoke bridge line.
Lower priority than Phase 1, because framing matters less than which resources surface.

## Risks & mitigations

- **Empty/thin stacks** → soft weights only, never hard-exclude; the existing `widen`
  fallbacks still guarantee a floor.
- **Free-text signal values** (credit/capital/goal aren't clean enums) → normalize to
  bands via keyword matching, like `learningGoal`. Start conservative.
- **Over-tuning** → ship the 2-3 highest-value signals first, watch real calls, expand.

## Recommended sequencing

1. **Phase 1a** — `already_tried` down-weight + credit/capital lender bias. *(highest value, lowest risk)*
2. **Phase 1b** — the knowledge-execution-gap re-rank. *(mission-critical)*
3. **Phase 2** — rule-level `goal`/`credit`/`capital` columns for framing.

## Test scenarios

- **Weak-credit flipper** → creative/private money floats up, conventional sinks.
- **High-education / low-action caller** → execution tools + accountability over more courses.
- **Scaling investor** (8 rentals, tapped out on conventional) → systems + portfolio lending, not beginner content.
- **Low-capital beginner** → wholesale/creative/house-hack, not capital-heavy strategies.

## Effort

Phase 1a+1b: ~1-1.5 days (all in `resources.js`, no schema/plumbing changes).
Phase 2: ~0.5-1 day (additive columns + a few scoring lines).

---

# Phase 3 — Numeric match-confidence score (design, not yet built)

Status: **DESIGN** (2026-10-14). Addresses the Asana task "Scored / numeric confidence
matching." Distinct from Phase 1: Phase 1 decides the **order** of the stack; Phase 3
decides **whether to present a specific close match with confidence** in the
secondary-questioning / problem-to-solution chain.

## The problem
In the secondary-questioning chain, Lani maps a caller's stated problem to a specific
resource (an educator, a vendor kind, an education track) and then decides whether the
match is close enough to deliver with confidence ("I found someone who specializes in
exactly that"). Today that decision is **Lani's own judgment**, so it is inconsistent
and un-tunable. Chris's ask: have the matrices emit a **numeric match score** so the
"deliver if above N" line is **computed**, not judged.

## Design — a 0-100 match score per candidate

Each candidate resource is scored against the caller's resolved dimensions (stage,
strategy/topic, blocker/need, asset type). Weighted overlap, normalized to 0-100 by the
max achievable for that resource type:

| Dimension | Signal | Points |
| --- | --- | --- |
| Strategy / topic | caller strategy exactly in the resource's `educational_topics` / matrix `strategy` | +50 |
| Strategy / topic | a related strategy via `strategy_crosswalk.parent_strategy` | +25 |
| Stage / level | caller stage in the resource's `educational_level` / matrix `stage` | +25 |
| Need / blocker (vendors) | vendor serves the caller's blocker/need | +20 |
| Asset type | commercial sub-asset / asset-type match when relevant | +15 |
| Investor type (vendors) | `investor_types` overlap | +10 |

Score = sum(matched points) / max-achievable-for-that-type * 100. A candidate missing a
dimension simply can't earn its points, so partial matches score lower — which is the
desired behavior.

## Confidence bands + the threshold N
N lives in `app_settings` (e.g. `match_confidence_threshold = 60`) so Chris can tune the
bar with **no deploy** (same pattern as `vendor_match_radius_miles`).

- **score >= N** → high confidence: deliver with a specific claim ("specializes in exactly that").
- **N-15 to N** → medium: still deliver, softer language ("a strong option for this").
- **< N-15** → low: do NOT claim a close match. Ask one more secondary question, or fall
  back to a broader / foundational resource. Never a silent "no match."

## Where it hooks
- `resources.js` / `vendors.js` / `education.js` compute `match_score` per returned
  candidate and include it in the tool response (alongside the existing fields).
- Lani's prompt/logic reads the band (not the raw number) to choose the confidence line —
  replacing her judgment with the computed rule.
- Weights start as **code constants** (simplest). Only if per-dimension tuning is wanted
  later do they move to a small `scoring_weights` config table.

## Relationship to Phase 1
Complementary and independent: Phase 1 `reRank` nudges **order**; Phase 3 gates the
**"I found a close match" claim**. A stack can be well-ordered (Phase 1) yet still contain
only weak matches, in which case Phase 3 keeps Lani from over-claiming.

## Risks & mitigations
- **Mis-set threshold** → N is configurable in `app_settings`; start conservative (60), tune on real calls.
- **Suppressing all matches** → below-threshold always delivers a softer/foundational fallback, never silence.
- **Missing dimensions** → score only on present dimensions; this correctly lowers confidence rather than erroring.

## Effort
~1-1.5 days: the scoring function in the three match endpoints + the `app_settings`
threshold + the prompt/logic change to use the bands. No schema changes if weights stay
in code. Validate with the Phase 1 test scenarios plus: a dead-center strategy+stage
match should score high; a stage-only (wrong-strategy) match should fall below N.
