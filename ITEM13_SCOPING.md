# Item 13 — Resource Stack Hierarchy & Sequenced Delivery — Scoping

Status: **Layers 1-2 SHIPPED 2026-09-14** (commit 7a5fc6e); layers 3-4 gated on decisions.
The Asana card said "confirm before estimating the build in detail" because it overlaps
the roadmap engine. This document is that confirmation step; the hard-exclude rule was
confirmed with David and layers 1-2 built.

## Origin (what the card is about)

A test call (Path A, Getting Started, buy_and_hold, blocker strategy_clarity) returned
five resources at once with two failures:
1. **Relevance** — irrelevant resources for the caller's stage/strategy (two mortgage
   brokers to a strategy_clarity caller with no deal yet; an off-strategy short-term-
   rental resource for a buy_and_hold caller).
2. **Volume & hierarchy** — the one genuinely foundational resource was buried as item
   one in a flat list of five, not framed as the starting point.

Original design (three layers, applied in order): **stage gate**, **strategy respect**,
**tier ordering** (foundational → enabling → transactional), then a **1-2-then-invite**
delivery pattern.

## What is ALREADY handled (reduces the scope)

The routing-scoring re-rank shipped this cycle (`ROUTING_SCORING_DESIGN.md`, Phase 1a+1b)
already does **soft relevance ordering** — it reorders the stack by the caller's credit,
capital, and the knowledge-execution gap, so the best-fit resource floats up. On the
origin scenario, a strategy_clarity / no-deal caller would already get the education
track and execution tools surfaced above transactional lenders.

So Failure 1's *ordering* symptom is largely covered. **What is NOT yet covered:**
- **Hard exclusion** — the re-rank only nudges; a wrong-stage or off-strategy resource
  can still appear lower in the list instead of being removed.
- **Volume/hierarchy** — the stack still returns 5-6 items in a flat round-robin, with
  no "start here, come back for more" framing.

## Remaining scope (the real work)

### 1. Stage gate — hard exclusion (resources.js) — ✅ SHIPPED (7a5fc6e)
Hard-exclude resources that are wrong for the caller's stage, not just rank them low.
Concretely: a foundational-stage / strategy_clarity caller with no deal should not be
handed a transactional vendor (lender) unless funding is their explicit blocker.
- Lives in `resources.js`, in the vendor bucket builder (and applies to the blocker
  gate already there).
- Risk: over-exclusion → empty stack. Mitigate with the existing widen fallbacks and a
  guaranteed floor of at least the top education/tool resource.

### 2. Strategy respect (resources.js + matrices) — ✅ SHIPPED (7a5fc6e)
Implemented as: skip the education-track stage-only fallback for a definite-strategy
caller (the actual leak vector), while strategy-clarity/no-strategy callers still get it.
Don't surface resources tied to strategies the caller didn't select. A strategy_clarity
caller is the exception — they get strategy **education/direction**, never off-strategy
vendors.
- Vendors are currently matched by blocker (`investor_need`), not strategy, so an
  off-strategy vendor can leak. Add a strategy consistency check on the vendor bucket.
- Education/events already match on strategy/topic; tighten the "no strategy = open to
  all" fallback so it doesn't pull clearly off-strategy items.

### 3. Tier ordering (needs a tier label)
Order the stack foundational → enabling → transactional, because resources have
dependencies (a lender is useless before a strategy exists). This needs a **tier label
on resources**.
- **KEY OVERLAP:** the roadmap engine's existing phase structure + `phase_intent_precedence`
  config already encodes a version of this ordering. This piece may be **"wire the
  existing roadmap ordering into the live getResourceStack delivery"** rather than a
  from-scratch tier system. **Confirm with Chris before building this layer** — it is the
  one with real coupling risk.

### 4. Delivery pattern (resources.js + prompt)
Deliver **1-2 items from the highest-relevant tier**, framed as the starting point, then
invite back ("when you're ready to go deeper, call back") instead of dumping 5-6.
- A cap on what `getResourceStack` surfaces (resources.js) + Lani prompt logic for the
  framing.
- This is a **product/UX decision** (how many, what framing) — needs Harmonie/Chris sign-off
  on the wording and the cap number, since it changes the core delivery feel.

## Proposed sequencing (lowest-risk first)

1. ~~**Stage gate + strategy respect** (layers 1-2)~~ — ✅ **DONE (7a5fc6e).** Pure
   `resources.js`, no roadmap coupling. Needs a live test to confirm the origin scenario
   (Path A, getting_started, buy_and_hold, blocker strategy_clarity) no longer gets
   lenders or an off-strategy track.
2. **Delivery cap + framing** (layer 4) — needs the UX sign-off but is self-contained. ~0.5 day + sign-off.
3. **Tier ordering** (layer 3) — LAST, and only after confirming whether to reuse the
   roadmap engine's `phase_intent_precedence` vs build a standalone tier label. This is
   the coupling decision. ~1 day if reusing, more if from-scratch.

## Decisions needed before build
- **Layer 3:** reuse the roadmap engine's phase ordering, or a standalone tier label on resources? (Chris)
- **Layer 4:** how many resources to lead with (1 or 2), and the invite-back wording? (Harmonie/Chris)
- **Layer 1:** confirm the hard-exclude rule for transactional vendors — "never for a
  foundational/strategy_clarity caller unless funding is the explicit blocker" — matches intent.

## Revised effort estimate
Layers 1-2 (the safe, high-value relevance fix): **✅ shipped** (7a5fc6e) — needs a live test.
Layers 3-4: gated on the decisions above; ~1.5 days once decided.
So the original ~37 hr estimate was high — the re-rank absorbed the soft-ordering work,
layers 1-2 shipped in well under a day, and only layers 3-4 remain (both decision-gated).
