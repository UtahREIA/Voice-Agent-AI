# GHL ↔ Supabase field/value gap report

Status: built 2026-10-13. Re-runnable (SQL below). Owner: David. Priority: HIGH.

## Why this exists
GHL builds every dropdown VALUE from the label someone typed, so a one-character
difference (a missing `s`, a typo, a double vs single underscore) silently creates a
value that **matches nothing** in the Supabase routing tables. The query just returns zero
rows and the caller falls through to a weaker answer — no error anywhere. This report
checks every shared field/value between GHL and Supabase and lists the mismatches so they
can be corrected before they bite.

## What "shared" means here (the four vocabularies)
The same concept is spelled differently per table. The bridge is `strategy_crosswalk`,
which maps every GHL dropdown value → a canonical key, per dimension (stage, strategy,
commercial_asset, goal, discovery). The matching tables then use the canonical/short forms,
and the code (`api/resources.js` SHORT_STAGE / TOPICS_BY_STRATEGY / MATRIX_STRATEGY and
`api/intake.js` RULE_STAGE_KEY) translates between them.

Shared dimensions this report checks:
- **Stage** — GHL `Where would you say you are...` (field `swDtahR8SAnG4S34s2a6`) ↔ crosswalk `stage` ↔ intake_routing_rules.stage_key ↔ ghl_* `educational_level`
- **Strategy** — GHL `What type of investing...` (`hf9VEhcVwgyNXP3qbzsA`) + `Commercial Asset types` (`fSCzPFTuniRg0Lce2CCf`) ↔ crosswalk `strategy`/`commercial_asset` ↔ education_routing_matrix.strategy ↔ ghl_* `educational_topics`
- **Goal** — GHL `What are you trying to accomplish...` (`t150aKjUz1KvU183CtJw`) ↔ crosswalk `goal`
- **Vendor categories** — GHL Vendor Partner fields (funding__financial, team__vendors, deals__opportunities, operations, development__land, education_technology__tools, attorney_subclass, contractor_speciality) ↔ vendor_routing_matrix

## Current findings (2026-10-13)

| Dimension | Direction | Result |
| --- | --- | --- |
| Vendor categories | matrix token → GHL value | **CLEAN** (0) — reconciled in the vendor alignment task |
| Vendor categories | GHL value → routing | **CLEAN** (0) — 22 services routed in the same task |
| Educator/course **levels** → crosswalk stage | GHL value → crosswalk | **CLEAN** (0) |
| Stage/strategy canonical → intake_routing_rules | crosswalk → routing | **CLEAN** (0) — every questionnaire option routes |
| Educator/course **topics** → crosswalk | GHL value → crosswalk | **3 GAPS** (below) |

### The 3 open gaps (educator/course topics with no crosswalk match)
1. **`syndication__funds`** — the crosswalk carries the plural `syndications__funds`; a real
   educator is tagged with the singular. That educator will not surface for syndication.
   **Fix:** add an additive crosswalk alias row: `ghl_value='syndication__funds'`,
   `canonical_key='syndication'`, `dimension='strategy'`. (CLAUDE.md already notes both
   spellings exist in the wild.)
2. **`tax_saving_stratigies`** — a typo ("stratigies") on a GHL educator record, so it maps
   to nothing. There is no standalone tax *strategy* education track (tax is a `goal`).
   **Fix (content decision):** correct the educator's topic in GHL to a real value, or decide
   tax education routes through a defined topic and add the crosswalk row.
3. **`mindset`** — a cross-cutting topic, not a strategy, so it does not route.
   **Fix (product decision):** leave unrouted, or add a crosswalk/education entry mapping it
   to a foundational/general track so mindset educators can surface.

## How to re-run it
Run these in the Supabase SQL editor (or ask Claude to run via the Supabase MCP). Each lists
mismatches; empty result = clean.

```sql
-- 1) Educator/course topics + levels that the crosswalk cannot translate
WITH topics AS (
  SELECT DISTINCT unnest(educational_topics) v FROM public.ghl_educators_mentors WHERE is_active
  UNION SELECT DISTINCT unnest(educational_topics) FROM public.ghl_educational_courses WHERE is_active),
cw_strat AS (SELECT ghl_value FROM public.strategy_crosswalk WHERE dimension IN ('strategy','commercial_asset','discovery')),
levels AS (
  SELECT DISTINCT unnest(educational_level) v FROM public.ghl_educators_mentors WHERE is_active
  UNION SELECT DISTINCT unnest(educational_level) FROM public.ghl_educational_courses WHERE is_active),
cw_stage AS (SELECT ghl_value FROM public.strategy_crosswalk WHERE dimension='stage')
SELECT 'topic not in crosswalk' gap, v value FROM topics WHERE v IS NOT NULL AND v<>'' AND v NOT IN (SELECT ghl_value FROM cw_strat)
UNION ALL
SELECT 'level not in crosswalk', v FROM levels WHERE v IS NOT NULL AND v<>'' AND v NOT IN (SELECT ghl_value FROM cw_stage)
ORDER BY 1,2;

-- 2) Questionnaire options (crosswalk) that route to nothing
SELECT 'strategy canonical not routed' gap, canonical_key, ghl_value FROM public.strategy_crosswalk c
  WHERE dimension='strategy' AND in_routing_rules AND NOT EXISTS (SELECT 1 FROM public.intake_routing_rules r WHERE r.strategy=c.canonical_key)
UNION ALL
SELECT 'stage canonical not routed', canonical_key, ghl_value FROM public.strategy_crosswalk c
  WHERE dimension='stage' AND in_routing_rules AND NOT EXISTS (SELECT 1 FROM public.intake_routing_rules r WHERE r.stage_key=c.canonical_key)
ORDER BY 1,2;

-- 3) Vendor categories: matrix tokens not in GHL, and GHL categories with no routing
--    (full queries in the vendor alignment work; both currently return 0)
```

## Note on the investor-questionnaire dropdown options
GHL's API returns custom-field definitions but NOT their picklist option values, so the
live dropdown options can't be diffed by API — `strategy_crosswalk` is the maintained record
of them. The strongest live signal is therefore the **actual values on real GHL records**
(educator topics/levels, vendor categories), which is what check 1 and the vendor checks
use. If an option is ever renamed in GHL, it surfaces here the moment one record carries the
new value, or via check 2 if a canonical key loses its routing.
