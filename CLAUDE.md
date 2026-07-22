# Utah REIA Wayfinder — Voice Agent

AI voice agent (persona: **Lani**) that diagnoses a caller's needs and routes them to matched resources. Callers are either investors (routed to vendors/educators/events) or vendors (enrolling themselves in the directory).

## Stack

| Piece | Role |
| --- | --- |
| **Vapi** | Voice AI. Owns the system prompt, tool schemas, structured outputs, voice layer. |
| **Vercel** | Hosts the API. `https://voice-agent-ai-nu.vercel.app` |
| **Supabase** | Routing intelligence + call records. Project `kttzxjddtkgsitzehiid` |
| **GHL** | CRM + post-call workflow. Location `DNirEjy0ejVwbHsaBYrn` |
| **ElevenLabs** | Harmonie's voice clone for Lani |

GitHub repo **must stay public** (Vercel Hobby plan blocks collaborator deploys on private repos).
`package.json` **must keep** `"type": "module"` or every API file fails on Vercel with an export error.

## Key files

- `api/intake.js` — decides the next question or the routing action. Called by the Vapi `getIntakeRouting` tool after every caller answer.
- `api/ghl-sync.js` — end-of-call sync. Forks vendor vs investor, pushes to GHL, writes call records.
- `api/resources.js` — combined resource stack (vendors, education, mentors, tools, events). Returns up to 5.
- `index.html` — web call widget. **Overrides the Vapi dashboard greeting** via `overrides.firstMessage`.

## Architecture rules

**Routing intelligence lives in Supabase, not in code.** Question text and order come from the `intake_questions` table. Conversation flow stays in Vapi. Don't hardcode questions.

**Three coupled layers.** This applies to *dimensions* and to *tools*. Both need all three layers to agree, and the tool version is the more dangerous of the two.

A **dimension** only works if:
1. `intake_questions` row exists in Supabase
2. Vapi `getIntakeRouting` tool schema has a matching parameter
3. `intake.js` tracks that param

Break any one and the agent asks a question, can't report the answer, and asks it again. Repeat loops are almost always this. **This failure is loud** — the caller hears the repeat and complains.

A **tool** only works if:
1. the endpoint exists in `api/`
2. a Vapi tool points at that endpoint's URL
3. something (`intake.js` `routing_action`, or the prompt) names it

**This failure is silent.** Name a tool that doesn't exist in Vapi and there is no error anywhere: `intake.js` returns 200, the log prints the action you expected, and the agent quietly calls whichever tool it *does* have. That substitute returns a real answer, so the call sounds fine. `getResourceStack` was written, routed to, and documented on 2026-06-26 but never created in Vapi, and it went unnoticed for 26 days because every call still produced a plausible recommendation.

Before adding a `routing_action` value or a tool name in a prompt, confirm the Vapi tool exists. To detect drift: compare the `action:` field in the Vercel intake log against which tool the transcript shows the agent actually called. Nothing surfaces that mismatch automatically.

Current tools: `getIntakeRouting` → `/api/intake`, `getEducationMatch` → `/api/education`, `getVendorMatch` → `/api/vendors`. `routing_action` also accepts two no-tool sentinels, `escalate` and `1_info`, which mean "say the voice_bridge and call nothing".

**Additive-only edits.** Routing tables deactivate rows (`is_active=false`), never delete. Same for the HTML maps: append with visual distinction, never restructure.

**Stopping is sufficiency-based, not count-based.** Each path declares a required floor, a desired set, extras, and a soft ceiling. Goal acts as a pruning switch (a learning-oriented goal prunes credit/time/readiness/timeline). No hard question count anywhere.

Paths: **A** = discovery (new/exploring), **B** = resource-seeker (fast-exits once `specific_need` is known), **V** = vendor enrollment.

## GHL gotchas (learned the hard way)

- **Voice agent custom fields must be TEXT.** SINGLE_OPTIONS/MULTIPLE_OPTIONS do not reliably receive webhook payloads. This is why the vendor fields are TEXT and why the existing MULTIPLE_OPTIONS form fields were NOT reused.
- **GHL field values are immutable.** System-generated, snake_case, double underscores. Never edit them.
- Vendor category fields append `_partner` in API responses (e.g. `funding__financial_partner`).
- Booleans return as arrays of strings: `["true"]`.
- Logo/image fields return as arrays of objects with a `url` property.
- Custom object endpoints **403 from external IPs** (Vercel, Supabase edge). Only reachable via GHL MCP tools.
- **Update Contact Field never blanks a field.** Empty values are ignored, not written. Stale data survives. This is why `ghl-sync.js` has a dedicated clearing PUT with no empty-filter.

## Supabase gotchas

- `execute_sql` for INSERT/UPDATE, `apply_migration` for DDL. ~60-70KB per call limit.
- Check constraints have no ALTER. Must DROP then ADD with the full value list.
- Upsert needs the `on_conflict` **query param**, not just the header.
- Array columns need explicit `::text[]` cast in raw SQL.
- Always run a COUNT verification before a migration to prevent double-insertion.

### Four stage/strategy vocabularies (the biggest time sink in the whole project)

The same concept is spelled four different ways depending on which table you touch. Nothing enforces this and nothing errors when it mismatches — the query just returns zero rows and the code falls through to a weaker fallback, so you get a plausible wrong answer instead of a failure.

| vocabulary | used by | stage example | strategy example |
| --- | --- | --- | --- |
| **long stage** | Vapi enums, `intake_questions.applies_to_stages`, `educational_level` on every `ghl_*` table | `active_investor`, `exploring__new` | n/a |
| **short stage** | `intake_stages`, `intake_routing_rules.stage_key`, `education_routing_matrix.stage`, `tools_routing_matrix.stage` | `active`, `exploring` | n/a |
| **topics** | `educational_topics` on every `ghl_*` table | n/a | `fix__flip`, `buy__hold__rentals` |
| **matrix strategy** | `education_routing_matrix.strategy` | n/a | `notes_and_lending`, `tax_deeds`, `not_sure_yet` |

Callers always send the **long** form. Translate before querying anything else. The maps live in `api/intake.js` (`RULE_STAGE_KEY`) and `api/resources.js` (`SHORT_STAGE`, `TOPICS_BY_STRATEGY`, `MATRIX_STRATEGY`).

**`getting_started` is spelled identically in every vocabulary.** That is why bugs here hide: test with `getting_started` and everything works, so the other four stages look fine when they are matching nothing at all. Always test with `active_investor` too.

Other traps in the same family:
- `education_routing_matrix` has **no `industrial`/`retail`/`multi_family` rows**, only `commercial`. All commercial asset types must collapse to `commercial`. `vendor_routing_matrix` *does* have them.
- `commercial_asset_types` is empty on every active record. Don't match on it.
- `vendor_routing_matrix.investor_need` shares the **blocker** vocabulary (`deals`, `funding`, `team`, `legal`), so blocker is the right filter for picking vendor kind.
- Both `syndications__funds` and `syndication__funds` exist as topics. Match either.
- Both `wholesale` and `wholesaling` exist as matrix strategies. Match either.

## Vendor path (Path V)

Vendor calls in → Lani runs vendor questions → `ghl-sync.js` vendor fork fires → contact tagged **"Vendor Pending Review"** → workflow notifies the team → **a human vets and manually promotes** them into the `vendor_resources` custom object → the daily cron syncs that object to Supabase `ghl_vendor_resources` → vendor goes live.

**Nothing automated writes to `vendor_resources`.** The human is the only path in. That vetting gate is deliberate.

The vendor fork **does not write custom fields**. The GHL workflow does. Most vendors are brand new, so they don't exist in GHL/Supabase yet. The workflow's Contact Not Found branch creates them ~30s after the webhook. Any timed lookup from the serverless function races that creation and fails. Don't reintroduce a v2 field write here.

Detection: `tier === 'vendor_enroll'` OR `profileType` contains "vendor" and not "investor".
`profileType` is the existing structured output. Don't add a `callerType`, it duplicates this.
Tier is `vendor_enroll` (no leading number) so it can't collide with `3_educator` / `2_and_3`.
"Both" callers currently route to the **investor** path.

### Vendor custom field IDs (location DNirEjy0ejVwbHsaBYrn)

| Field | ID |
| --- | --- |
| Voice Agent Vendor Service Type | `ESvM4hhpSnQWiuluGard` |
| Voice Agent Vendor Investor Types | `1nvU9eGll7NYZ73YIR7e` |
| Voice Agent Vendor Market | `vdrZr28gqAsDntrN6CPG` |
| Voice Agent Vendor REIA Connection | `kzolZI3cyPGf4THu00T0` |
| Voice Agent Vendor Enrollment Interest | `tvoRTYDCkAbIjslA7PGC` |
| Voice Agent Vendor Follow Up Preference | `ttt3eBFkIUjIqV6JBrpF` |
| Voice Agent Vendor Summary | `IzhYTD89SrsXDUZFGxLK` (LARGE_TEXT) |

## Naming / voice

- **Written form is always "Utah REIA".** Pronunciation ("REEAH") is handled at the ElevenLabs voice layer via a pronunciation rule, NOT by misspelling it in the prompt. The old "REE-AH" hack is gone.
- Agent name is **Lani**. Older docs and some GHL/Supabase references still say "Nani" and need a sweep.
- `index.html` greeting strings are **single-quoted JS**. No apostrophes, or the whole script breaks silently. Use "I am Lani", never "I'm Lani".
- Closing word is **"Mahalo"** and nothing else. Never Goodbye/Bye/Take care.
- Never read URLs aloud. They go in the follow-up SMS.
- No em dashes in any output.

## Current open items

1. **The six vendor structured outputs aren't emitting.** Last test showed them completely absent from `Structured data extracted` (not empty, missing). `stackSummary` populated fine. Either they weren't attached to the assistant at call time, or Lani is folding everything into the summary. Next vendor test call + reading that log line resolves it. If still missing while attached, sharpen each output's description ("extract verbatim even if you also summarized it elsewhere").
2. `intake_routing_rules` only scores on stage/strategy/blocker. Goal, resources, already_tried are collected and passed through, but don't steer rule selection.
3. Two drifted `applies_to_stages`: `ask_resources_credit` is Path A only (designed for active too), `ask_support_network` fires for everyone (designed for getting_started + active only). Both still true as of 2026-07-22.
4. ~~Blocker trio all priority 5~~ — no longer true, they are 4/5/6/7. Only `ask_blocker_general` (priority 4) is reachable anyway, since `byParam` takes the lowest-priority row per param and all four fill `blocker`. Ties across *different* params are harmless for the same reason.
7. **`getResourceStack` does not exist in Vapi yet.** `api/resources.js` is written and matching correctly, but nothing calls it until the tool is created. See `FIX_CHECKLIST.md` steps 13-15. Until then callers get one category (`getEducationMatch`/`getVendorMatch`), not the intended 5-6 mixed stack.
5. Prompt polish: Lani skipped the last name on the last test, and asked the stage question twice before accepting "I'm a vendor".
6. Survey Routing Workflow pending Chris Borden's approval.

## People

- **Chris Borden** — decision maker, final approver
- **Harmonie Borden** — brand, ops, Lani's voice
- **David** — tech lead, all implementation. PowerShell on Windows.
- **Angela** — communications. **Bebe** — design.

## Debugging

The single most useful line in the Vercel logs is `Structured data extracted:`. It shows exactly what Vapi emitted. If a field is empty in GHL, check there first: if the key isn't in that object, it's a Vapi structured-output problem, not a code problem.
