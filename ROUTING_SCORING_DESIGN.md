# Routing Scoring Redesign — Design

Status: proposed (2026-08-18). Author: David + Claude. For review before build.

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
