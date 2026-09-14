# Voice Agent — Work Summary & How It Works

For explaining the completed work to Chris. Part 1 lists each completed item with a
**detailed, plain-English walkthrough of how it actually works** (the flow from the
caller through the system). Part 2 is the overall architecture.

---

## First: how ANY call works (the plumbing every fix rides on)

Read this once and the rest makes sense, because almost everything follows the same path.

1. **The caller talks to Lani.** The voice itself runs on **Vapi** — Vapi does the
   speech-to-text (hears the caller), runs the AI brain, and speaks back through
   **ElevenLabs** (Harmonie's cloned voice).
2. **When Lani needs to decide or fetch something, Vapi fires a "tool."** A tool is just
   an HTTPS POST from Vapi to one of our **Vercel** endpoints. The three that matter:
   - `GetUtahREIAContext` → `https://voice-agent-ai-nu.vercel.app/api/context` (runs at call start)
   - `getIntakeRouting` → `.../api/intake` (runs after every answer the caller gives)
   - `getResourceStack` → `.../api/resources` (runs once, to build the recommendation)
3. **The Vercel endpoint is a small program** (a serverless function). It reads and
   writes our **Supabase** database over Supabase's REST API to work out the answer.
4. **The endpoint returns JSON back to Vapi.** That JSON tells Lani the exact next
   question to ask, or the exact resources to recommend.
5. **Lani speaks it to the caller.** After the call ends, a separate endpoint
   (`/api/ghl-sync`) writes the call record into Supabase and pushes the contact to the
   **GHL** CRM, which fires the follow-up workflow (SMS/email with the links).

So the repeating pattern is:
**caller → Lani → Vapi tool → Vercel endpoint → Supabase → back to Vapi → Lani → caller.**
Every fix below is in one of those boxes: a Vercel endpoint, a Supabase table it reads,
or the Vapi config.

---

## Part 1 — Completed work (what it does + how it works)

### Recommendation quality — what Lani suggests

#### Lender routing matrix (lenders matched to the caller's strategy)
**What it does:** a flipper gets hard-money lenders, a buy-and-hold investor gets a
mortgage/DSCR lender, a passive investor gets a self-directed-IRA custodian, etc.
Before, every funding caller got the same generic list.
**How it works:** when the caller says funding is their blocker, Lani calls
`getResourceStack` → `/api/resources`. That endpoint queries the Supabase table
`vendor_routing_matrix`, filtering to the row that matches the caller's blocker
(`investor_need = 'funding'`) **and** their strategy (e.g. `fix_and_flip`). That row
carries a list called `vendor_categories` — the correct lender *types* in priority
order (for a flip: hard money first, then creative finance). The endpoint then pulls the
enrolled vendors from the `ghl_vendor_resources` table and, walking the categories **in
order**, matches each vendor's own service tags (`funding_financial`) against them, so
the best-fit lender comes out on top. Those lenders go into the JSON Lani reads back.
The whole "which lender for which strategy" decision is data in the matrix table — no
code change needed to adjust it.

#### Routing scoring — credit & capital re-rank (Phase 1a)
**What it does:** a caller with weak credit or no money down gets creative/private-money
financing surfaced first and conventional loans pushed down.
**How it works:** the caller's credit and capital answers are already collected by
`/api/intake` and passed along in the arguments to `getResourceStack`. Inside
`/api/resources`, after all the resources are gathered into category buckets, a small
scoring function (`reRank`) runs over every resource. It checks the caller's credit/
capital against keyword patterns (e.g. "rough", "no money down" = weak/low) and scans
each resource's name/description/tags: creative or private-money items get their
priority number nudged **down** (which sorts them **higher**), conventional-loan items
nudged up (sorts lower). The buckets are then re-sorted by that adjusted number before
the final pick. Nothing is deleted — it only re-orders — so the stack can never come out
empty.

#### Routing scoring — knowledge-execution gap (Phase 1b, the anti-guru piece)
**What it does:** a caller who has studied a lot but done nothing gets execution
resources (deal analysis, calculators, coaching) instead of yet another intro course.
**How it works:** same `reRank` function in `/api/resources`. It reads two signals
already collected during intake — `education_history` (books/courses/mentors = lots of
learning) and the action signals (`already_tried`, `deal_count`, `readiness` = whether
they've actually done anything). If it sees high learning + explicit low action, it
nudges execution/accountability resources up and beginner/"intro/101" theory down. This
is why on the last test call an all-theory beginner correctly led with an execution
track and no-credit private money instead of a starter course.

#### tax_optimization → accounting vendors
**What it does:** callers focused on tax optimization now get connected to the tax/
accounting vendors. Before, they matched nothing.
**How it works:** it was a data hole — there was no row in `vendor_routing_matrix` for
the tax-optimization strategy, and the old inactive rows pointed at a category label
(`cpa_tax_professional`) that no vendor actually carries. We added an active row for
`strategy = 'tax_optimization'` whose `vendor_categories` are the **real** tokens the
accounting vendors use (`accountant__tax_specialist`, `bookkeeper`, `cost_segregation`,
`1031_exchange`). Now when `/api/resources` runs for a tax caller, that row matches the
enrolled accounting vendors and they surface.

#### Education routing audit + BRRRR fix
**What it does:** confirmed every strategy has a learning path, and closed the one real
hole (BRRRR).
**How it works:** learning "tracks" live in the `education_routing_matrix` table, which
`/api/resources` queries by stage + strategy. We checked all 17 strategies × 5 stages,
cross-referenced the mentor table to confirm coverage, and found BRRRR had no track and
no fallback. We added a fallback in the endpoint's strategy map so a BRRRR caller's
education routes to the buy-and-hold track (its closest match) instead of coming back
empty.

### Conversation quality — how the call feels

#### Intake state cache (fixes the "why are you asking me again?" loop)
**What it does:** if the voice platform drops the info collected so far mid-call, Lani
keeps going instead of restarting and re-asking.
**How it works:** every time Lani calls `getIntakeRouting` → `/api/intake`, the endpoint
now reads and writes a Supabase table called `intake_state`, keyed on the unique **call
ID**. Each turn it takes whatever answers Vapi sent, merges them with what it already
saved for that call, and saves the merged set back. So if on some turn Vapi sends an
empty/partial set (a known Vapi glitch on longer calls), `/api/intake` fills the blanks
from the cache and still returns the correct next step — Vapi gets a valid answer and
the retry loop never starts. The caller never hears the re-ask.

#### Ask-count cap (safety net so no answer can trap the call)
**What it does:** if one answer just won't come through, the call moves on after two
tries instead of looping forever.
**How it works:** in the same `intake_state` cache, `/api/intake` also counts how many
times it has asked each non-essential question. If a question has been asked twice
without an answer landing, the endpoint skips it and proceeds to the recommendation with
what it has. Essential questions are never skipped.

#### Question pruning (shorter, less repetitive calls)
**What it does:** stops asking low-value questions once the caller has already told us
enough.
**How it works:** `/api/intake` builds a "prune list" each turn from what it knows. If
the caller's goal is learning-oriented it drops the financing/timing questions; once the
caller has described what they've studied (`education_history` is answered), it drops the
"how do you want to learn?" questions, since those aren't even used in the recommendation
and just add turns. Pruned questions are skipped in the endpoint's question-selection
loop.

#### Path A / C2 reachability
**What it does:** every intended question can now actually be reached (a ceiling bug was
silently skipping several).
**How it works:** `/api/intake` has a `FLOW` config that, per path, lists the required
questions, the nice-to-have ("desired") ones, the extras, and a soft cap on how many to
ask. The cap was set too low, so the extras never fired. We raised it and wired the goal
question into the active-investor path so all questions are reachable.

#### Question rewording + name confirmation
**What it does:** "what have you learned" vs "what have you done" no longer feel like the
same question, and mis-heard names get corrected.
**How it works:** the question text lives as rows in the Supabase `intake_questions`
table — we edited two rows so the wording is clearly distinct (no code change; the
endpoint reads the new text on the next call). Name confirmation is a rule we added to
the Vapi system prompt telling Lani to read the last name back and let the caller correct
it before moving on.

#### Transcriber keyterms + speaking settings
**What it does:** jargon (BRRRR, fix-and-flip, Utah REIA) transcribes cleanly, and Lani's
questions stop getting chopped into fragments.
**How it works:** both are Vapi settings, not code. We added a keyterm list to the
Deepgram transcriber so it expects those industry words, and we raised the "number of
words" threshold in the Stop-Speaking plan so a stray "yeah" or background noise no longer
interrupts Lani mid-sentence.

#### Stage gate + strategy respect (Item 13, layers 1-2)
**What it does:** a beginner who doesn't even have a strategy yet is no longer handed
lenders, and a buy-and-hold caller no longer gets an off-strategy (e.g. short-term-rental)
learning track.
**How it works:** in `/api/resources`, after the resource buckets are built, a gate checks
the caller's readiness — a foundational/undecided caller with no deal and no funding
blocker has the lender-type vendors filtered out of the vendor bucket entirely (a hard
exclude, not just a low rank); the other categories still fill the stack. For strategy
respect, the education lookup used to relax all the way to "anything for this stage,"
which pulled off-strategy tracks; we stop that last fallback for a caller who has a
definite strategy, while undecided callers still get the broad options.

#### Credit question for active investors
**What it does:** active investors now get asked the credit question too (when funding is
relevant), so their recommendation is credit-aware.
**How it works:** two coupled changes — in Supabase we opened the `ask_resources_credit`
question row to the active path and all stages, and in `/api/intake` we added `credit` to
the active-path funding follow-up, so an active investor whose situation is funding-
related is asked about credit, and that answer then feeds the credit-aware re-rank above.

### Bugs fixed

#### "No result returned" — Lani was getting no live knowledge
**What it does:** Lani now actually receives the live community data (active vendors,
events, member recognition) at the start of every call. Before, it was silently
discarded.
**How it works:** at call start Vapi fires `GetUtahREIAContext` → `/api/context`, which
queries Supabase for vendors/events/educators and returns a knowledge blob. The problem:
Vapi requires the response wrapped a specific way (`{ results: [{ toolCallId, result }] }`)
and the endpoint was returning a bare `{ result }`, so Vapi threw "No result returned" and
Lani got nothing. We fixed the endpoint to return the wrapped shape.

#### Empty "Active Vendors" section
**What it does:** that section of Lani's pre-call knowledge now lists 82 vendors; it had
been permanently blank.
**How it works:** `/api/context` filtered its vendor list on a column (`service_types`)
that doesn't exist on that table, so the filter always removed everything. We pointed it
at the real service columns the table actually has.

#### Vendor data not syncing from the CRM
**What it does:** vendor fields (attorney type, tools, contractor specialty, etc.) now
pull correctly from GHL.
**How it works:** a daily job (`/api/sync-ghl-objects`, run by a GitHub Actions cron)
pulls the vendor records from GHL and writes them into the `ghl_vendor_resources`
Supabase table. Several GHL field names were misspelled or renamed on GHL's side, so the
sync was reading the wrong keys and storing blanks. We corrected the key names and added a
diagnostic that logs GHL's actual field names each run, so the next mismatch is caught
immediately.

### Infrastructure / data hygiene

#### Contact reconciliation (removes CRM-deleted contacts)
**How it works:** a daily job (`/api/reconcile-contacts`, GitHub Actions cron) walks
every contact in Supabase, checks each one against the GHL API, and if GHL no longer has
that contact it deletes the contact and its related call data from Supabase. It cleared
~625 orphaned records.

#### Retention purge (90-day cleanup)
**How it works:** a daily job (`/api/purge-old-data`, cron) deletes call-activity rows
older than 90 days, including the per-call `intake_state` cache. It's gated by a secret
token and defaults to a dry run so it can't delete unless explicitly authorized.

#### Resource-gap tracker (demand signal)
**What it does:** every time Lani can't match a caller, it's logged, so we can see what
vendors/educators we're missing and what needs we haven't mapped.
**How it works:** inside `/api/resources`, at the points where a match comes back empty,
the endpoint writes a row to the Supabase `resource_gaps` table — recording whether it's a
"service gap" (a category we have no vendor for = go recruit one) or a "taxonomy gap" (a
need we don't even classify = go map it), plus the caller's own words. A read endpoint,
`/api/gaps`, aggregates those rows into a ranked list of the most common unmet needs.

---

## Part 2 — How the system works (the Supabase "brain")

### One-sentence version
**Lani's intelligence lives in Supabase, not in code.** Vapi handles talking and
listening; the Vercel endpoints read Supabase tables to decide what to ask and what to
recommend. So we change questions, routing, and recommendations by editing a table — no
code deploy.

### The routing tables (the decision-makers)
| Table | What it decides |
| --- | --- |
| `intake_questions` | What Lani asks, in what order, to whom |
| `intake_routing_rules` | Where to route the caller once enough is known |
| `vendor_routing_matrix` | Which lender/vendor type fits the caller's situation |
| `education_routing_matrix` | Which learning track fits |
| `ghl_*` (vendors, educators, courses, tools, events) | The real resources, synced nightly from the CRM |
| `intake_state` | Per-call memory so a dropped message doesn't restart the call |
| `resource_gaps` | Running log of what Lani couldn't serve (demand signal) |

### The one non-negotiable rule
A capability only works if **three layers agree**: the question exists in Supabase, Vapi
has a matching field, and the code tracks it. If any one is out of step, it silently
fails. Most of the debugging this round was re-aligning those three layers.

### Current limitation to set expectations
Most vendors, educators, and mentors are still **test placeholders**. The routing and
matching are correct and proven, but real callers only get real people once vendors are
vetted and enrolled at launch — a data/vetting step, not a code step.
