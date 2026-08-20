# Voice Agent — Work Summary & How It Works

Prepared for the team meeting. Two parts:
1. **What was completed** — the fixes and features shipped.
2. **How the system works** — the Supabase-backed "brain" behind Lani, in plain terms.

---

## Part 1 — Completed work

### Recommendation quality (what Lani suggests)

| Item | Plain-English result |
| --- | --- |
| **Lender routing matrix** | Lenders now match the caller's investing type — hard money for flippers, mortgage/DSCR for buy-and-hold, SDIRA/advisor for passive, commercial bridge for commercial. Before, every funding caller got the same generic list. |
| **Routing scoring — Phase 1a** | Lani now uses the caller's **credit and capital** to shape the stack: weak credit or no money down surfaces creative/private-money financing and sinks conventional loans. |
| **Routing scoring — Phase 1b (the big one)** | Detects the **"all theory, no action" caller** (lots of learning, no deals done) and leads with execution — deal analysis, calculators, deal-finding, coaching — instead of yet another intro course. This is the core anti-guru "fit detection" idea, now live. |
| **tax_optimization → accounting vendors** | Tax-optimization callers are now connected to the tax/accounting vendors; the routing rule was pointing at a category label no vendor actually had. |
| **Education routing audit** | Checked all 17 strategies × 5 stages, confirmed mentor coverage on the gaps, and closed the one real hole (BRRRR now maps to a real learning track). |

### Conversation quality (how the call feels)

| Item | Plain-English result |
| --- | --- |
| **Intake state cache** | Fixes the "why are you asking me again?" loop. If the voice platform drops the info mid-call, the system now remembers it and keeps going instead of restarting. |
| **Ask-count cap** | A safety net: if one answer won't come through, the call moves on after two tries instead of getting stuck forever. |
| **Question pruning** | Cuts the low-value questions once the caller has told us enough (e.g. it stops asking "how do you want to learn?" after they've described what they've studied). Shorter, less repetitive calls. |
| **Path A / C2 reachability** | Every intended question can now actually be reached (a ceiling bug was silently skipping several). |
| **Question rewording** | "What have you learned" vs "what have you done" no longer feel like the same question. |
| **Name confirmation** | Lani reads the name back so a mis-heard name gets corrected instead of stored wrong. |
| **Transcriber keyterms + speaking settings** | Industry jargon (BRRRR, fix-and-flip, Utah REIA) transcribes cleanly, and Lani's questions stop getting chopped into fragments. |

### Bugs fixed

| Item | Plain-English result |
| --- | --- |
| **"No result returned" context bug** | Lani was silently receiving **none** of the live community knowledge (active vendors, events, member recognition) on every call — the data was being discarded. Fixed. |
| **Empty "Active Vendors" section** | A vendor section of Lani's pre-call knowledge had been permanently blank due to a filter checking a field that didn't exist. Now shows 82 vendors. |
| **Vendor data not syncing** | Several vendor fields (attorney type, tech/tools, contractor specialty, and more) weren't pulling from the CRM because the field names were mismatched. Fixed, plus a diagnostic so the next mismatch is caught immediately. |

### Infrastructure / data hygiene

| Item | Plain-English result |
| --- | --- |
| **Contact reconciliation** | A daily job removes CRM-deleted contacts from our database (they were piling up — ~625 orphans cleared). |
| **Retention purge** | A daily job clears call-activity data older than 90 days, including the new per-call cache. |
| **Resource-gap tracker** | Every time Lani can't match a caller, it's logged — so we can see what vendors/educators we're missing and what caller needs we haven't mapped yet. |

---

## Part 2 — How the system works (the Supabase "brain")

### The one-sentence version
**Lani's intelligence lives in Supabase, not in code.** The voice platform handles talking and listening; a small API reads Supabase tables to decide what to ask and what to recommend. That means we can change questions, routing, and recommendations by editing a table — no code deploy.

### The flow of a single call
1. **Caller speaks to Lani** (the voice layer — Vapi + ElevenLabs).
2. **After each answer, Lani calls our API** (`getIntakeRouting`).
3. **The API reads Supabase** to decide the next step:
   - `intake_questions` — the actual questions, their order, and which caller types/stages they apply to.
   - `intake_routing_rules` — how to route the caller once we know enough.
   - `intake_stages` — context per experience level.
4. **When enough is known, the API tells Lani to recommend** (`getResourceStack`).
5. **The recommendation is built from more Supabase tables:**
   - `vendor_routing_matrix` — which vendor/lender type fits this caller.
   - `education_routing_matrix` — which learning track fits.
   - `ghl_*` tables — the actual vendors, educators, courses, tools, and events (mirrored nightly from the CRM).
6. **Lani delivers the recommendation** and the call closes.

### Why "it lives in Supabase" matters
- **Questions** are rows in `intake_questions`. Change the wording or order = edit a row. No developer needed.
- **Who gets recommended** is decided by the routing matrices. Adding a vendor category or fixing a match = edit a row.
- **The actual vendors/educators/events** live in the CRM and sync to Supabase every night, so Lani always has current data.

### The routing tables (the decision-makers)
| Table | What it decides |
| --- | --- |
| `intake_questions` | What Lani asks, in what order, to whom |
| `intake_routing_rules` | Where to route the caller once enough is known |
| `vendor_routing_matrix` | Which lender/vendor type fits the caller's situation |
| `education_routing_matrix` | Which learning track fits |
| `ghl_*` (vendors, educators, courses, tools, events) | The real resources, synced nightly from the CRM |

### New mechanisms built this round
- **`intake_state`** — a per-call memory. It remembers what the caller has already answered so a dropped message doesn't restart the call. Self-cleans on the retention job.
- **Routing score re-rank** — after the resources are gathered, the system reorders them to fit the caller's credit, capital, and experience-vs-action gap (the anti-guru piece). All the signals were already being collected; now they actually shape the order.
- **`resource_gaps`** — a running log of what Lani couldn't serve, split into "a vendor/educator we're missing" vs "a caller need we haven't mapped." This is our demand signal for what to add next.

### The one non-negotiable rule (worth knowing for the meeting)
A capability only works if **three layers agree**: the question exists in Supabase, the voice platform has a matching field, and the code tracks it. If any one is out of step, the capability silently fails. Most of the debugging this round was finding and re-aligning those three layers.

### Current limitation to set expectations
Most vendors, educators, and mentors in the system are still **test placeholders**. The routing and matching are correct and proven, but real callers will only get real people once the vendors are vetted and enrolled at launch. No further code work is needed for that — it's a data/vetting step.
