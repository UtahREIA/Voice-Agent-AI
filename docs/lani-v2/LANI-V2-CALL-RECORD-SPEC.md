# Lani V2: end-of-call record (build spec)

Drafted by chat 5 on 2026-10-20. **Status: approved by Chris on 2026-10-20 (fields and caller recap as written).** Ready for David to build (chat 6).

## Why
- V2 calls save again, but every saved row has a blank summary and no record of what was recommended.
- V2 runs 6 leftover structured outputs, and none of them captures a recommendation.
- The follow-up text, the GHL contact update, staff follow-up and educator rotation all need one reliable record of each call.

## The design in one line
Two sources, each doing what it is best at:
1. **What was recommended comes from the server, not the AI.** find_resources already caches every match by call ID (voice_agent_stack_links). That is exact: real IDs, real names, no guessing.
2. **Who the caller is comes from one structured output** that reads the transcript after the call: names, stage, strategies, goal, need, risk, location, flags, and a summary.

## Part 1. Server cache (David, small change)
In find_resources, the cache today keeps only matches that have a link (name, type, url). Change it to keep **every** match:
- `id` (GHL record ID), `name`, `type` (utah_reia, educator, class, tool, event, vendor), `url` (may be empty), `cost`, `status` of the need (ok, no_match, needs_location)
- Keep a list of the needs that came back **no_match**, so missing help is recorded even if Lani does not say it.
- If find_resources is called twice in a call, merge, do not overwrite.

This gives:
- **Educator rotation:** pick the educator recommended least recently, by counting educator IDs in this cache.
- **Referral billing:** vendor IDs for `vendor_referrals`, instead of matching vendor names by first word.
- **The follow-up text:** unchanged, it already reads this cache.

## Part 2. One structured output: `laniCallRecord`
- One Vapi structured output, type object, model Haiku 4.5.
- Only runs on calls with at least 4 caller messages, so hang-ups and wrong numbers skip it.
- Field names reuse the ones ghl-sync already reads, so the GHL update keeps working. ghl-sync change: if a structured output's result is an object, spread its fields into `structured` (one loop).
- Replaces the 6 leftover V2 outputs. The vendor output stays separate (same vendor field names as today).

| Field | Type | What it captures (this text becomes the field description in Vapi) |
|---|---|---|
| callerName | string | First and last name of the main caller as they gave it. Empty if not given. |
| otherPeople | string | First names of anyone else on the call, comma separated, with their relation if said, for example "Sandra (wife)". |
| profileType | enum: investor, vendor, both | What the caller is, from what they said. |
| investorStage | enum: exploring, getting_started, active, experienced, veteran | Their level in the strategy they want help with, judged by deals done, not how they described themselves. |
| strategies | string | Strategies they want to pursue, comma separated, in GHL Investing Interests wording (David supplies the exact list). |
| dealCount | string | Number of deals they said they have done, as a number if given. |
| goals | string | What they want the investing to do for them, in their words, one sentence. |
| specificNeed | string | The real need Lani worked out, one sentence. |
| blocker | enum: capital, deals, team, contractors, knowledge, time, credit, legal, none | The main thing standing in their way. |
| moneySource | enum: cash, retirement_account, home_equity, mix, unknown | Where the money they would use sits. |
| riskLevel | enum: low, medium, high, unknown | How much risk they can carry, from age, retirement, share of savings or what they said. |
| timePerWeek | string | Hours per week they said they have. |
| propertyLocation | string | City, county or state of the property if mentioned. |
| county | string | Utah county if known, for vendor matching and reports. |
| urgent | boolean | True if a deadline or emergency came up. |
| deadline | string | The deadline in their words, if any. |
| educatorMatch | string | Name of the educator Lani named on the call, if any. |
| bookingRequired | boolean | True if Lani told them she would send a booking link. |
| missingHelp | string | Kinds of help Lani said the team would connect them with, comma separated. |
| humanRequested | boolean | True if they asked for a real person. |
| teamFollowUp | string | Any other reason the team must follow up: listing or sponsoring, a legal or securities concern, something involving Utah REIA members or events. Empty if none. |
| recommendedNextStep | string | The single most important next step for this caller, one sentence. |
| summary | string | For staff: 2 to 3 plain sentences on who they are, what they need, and what Lani recommended. |
| stackSummary | string | **Goes in the follow-up text to the caller.** One or two friendly sentences written to them, under 300 characters, recapping what Lani recommended. No links (the links are added by the server). |

## What changes for whom
- **Chris:** approve the fields and the caller-facing recap (stackSummary).
- **David (chat 6):** the Part 1 cache change; create `laniCallRecord` in Vapi with the schema above and remove the 6 leftover V2 outputs; the one-loop spread in ghl-sync; map `strategies` to the GHL picklist; educator rotation reads the cache.
- **Chat 5:** after the first calls run, check 5 saved rows against their transcripts.

## Checks before it counts as done
1. A full test call saves a row with every field that came up filled in, and the summary matches the transcript.
2. The cache shows every match with its ID, including vendors without a website.
3. A hang-up after the greeting saves no extracted fields.
4. The follow-up text has the recap plus all links, and no link is read aloud on the call.
