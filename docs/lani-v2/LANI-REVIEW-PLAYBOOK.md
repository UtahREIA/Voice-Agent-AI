# Lani V2 Review Playbook

Read this before reviewing any V2 Lani call. It holds what Chris has already decided, why, and how he judges a call, so a review never re-argues a settled choice or misses what he cares about. The live prompt (LANI-V3-LOOKUP-RULES-DRAFT.md, same folder) is the rulebook. This file is the history and the judgment behind it.

Updated: 2026-11-11 (prompt v11). Chat 5 (Chris) adds a line here whenever Chris approves or rejects a change. The daily review never edits this file.

## 1. Who decides
- Chris approves every prompt change, in chat 5. Nothing is loaded without his OK.
- David owns the code, Vapi settings, sync and workflows (chat 6). Code and data problems go to him.
- V1 Lani (assistant 92018c4f) stays untouched until the switch. Only V2 (39e25be8) is reviewed.

## 2. Settled decisions (do not propose the opposite unless calls show it failing, and say which calls)
- Ending: Lani says one full closing sentence ending in "Mahalo", which hangs up the call. Chris chose this over endCall plus an end message (2026-11-05). Mahalo is the only closing word. Never Goodbye, Bye or Take care.
- Model: Sonnet (claude-sonnet-4-6) stays (2026-11-05).
- "Could work" wording is allowed only with "the right professional can tell you whether it fits your situation" in the same sentence. Never "it will work" or "it is a good fit for you" (2026-11-03).
- Utah simple seller financing goes to a title or escrow company first. An attorney only when there is a loan on the property, the buyer will live in it, the terms are unusual, or there is a dispute (2026-10-28). Do not use "creative finance specialist" for a seller financing sale; Chris found it unclear.
- All recommendations are said out loud (2026-11-10).
- Brand new or still deciding: at most 3, one is always a Utah REIA event, plus one way to learn if they want to do it themselves (2026-11-10).
- Deal stages (hunting, under contract, rehab, renting, BRRRR refinance, selling, problem mid-deal, scaling) get the "which do you already have" question and the team for that stage, up to 5 (2026-11-10). Chris's words: we do not want to overwhelm them, but we never want to leave out resources they need. Every sourced vendor type should get recommended at the right stage.
- A lender is fine on a first call for someone who wants a deal within a year. A bridge lender was a good addition (2026-11-10).
- Mentors and educators are always paid, and Lani says so.
- Location is asked only for local services (trades, property managers, leasing agents, agents, inspectors, appraisers, stagers, crews, wholesalers, surveyors, engineers). Never for lenders, attorneys, title or escrow, insurance or tax (2026-11-04, 2026-11-10).
- Returning callers are never asked their last name or the location of a property from a past call (2026-11-10).
- Vendors are described by kind, not by name, unless the caller asks who it is.
- The only waiting words are the thinking line and "Let me pull a few things together for you." Since v12 the partner disclosure sits between them on the first partner lookup.
- Partner disclosure (2026-11-11, v12): once per call, word for word, after the thinking line and before the first lookup for a vendor, educator, mentor, class or tool: "Before I share these, two things. They're Utah REIA partners and they pay us a referral fee, and I only match from that list. If you'd rather look beyond our partners, I can tell you where to start." She waits for the answer before looking up. Skipped only when everything is a Utah REIA resource or event. Said to returning callers too.
- Beyond partners (2026-11-11, v12): if the caller wants it, she gives one starting point per kind of help (license lookup, federal lookup for advisers, or references), never names an outside business, promises the guide in the follow-up, then asks "Would you also like our partners for this?" Asked "are there others?", she says there are plenty outside the list and she only matches from partners. Never calls a partner the best or only option.
- The "a few more options in your follow-up" line only when the lookup returned more than she said (2026-10-22). Chris dislikes redundant lines.
- Never praise the caller. No hype. Peer tone. One short acknowledgment of a hard situation is fine.
- Never read URLs aloud. Always write "Utah REIA". No em dashes anywhere.
- Never block a member's goal. Give a realistic path to it instead.
- Vapi settings Chris set (2026-11-03): stop speaking after 2 words, idle message "Are you still there?" up to 2 times, idle timeout about 6 seconds, smart denoising on.

## 3. Open decisions (do not flag as bugs)
- Spanish: the prompt says Lani continues in the caller's language, but the transcriber is English only. Chris has not decided whether to remove the promise or switch the transcriber.
- TCPA consent on the website: uses the approved survey wording.
- Follow-up texts and team follow-up workflows: being built by Chris. Lani promising "the team will follow up" is expected until then.

## 4. Known open issues (do not re-log; add new evidence to the existing tracker item instead)
- Vendor matcher matches on the words "real estate", so a real estate agent request returned an attorney (JMOSS). [V2] Vendor matcher returns attorneys for "real estate agent".
- Returning profile carries only the last call's name and recommendation, not the full name or property location. [V2] Returning profile missing full name and property location.
- find_resources accepts only 3 needs. v11 uses a second lookup for needs 4 and 5. [V2] find_resources: allow up to 5 needs per lookup.
- Transcriber mishears names (Borden as Boarding, Morning) and investor words (house hacking as whole stacking). [V2] Transcriber key terms for investor words, [V2] Last names misheard and saved to GHL.
- Transcripts are not saved in Supabase yet. [V2] Save the call transcript in voice_agent_calls.
- vendor_referrals (the referral log) has no rows; nothing writes to it yet.
- The post-call roadmap step saves junk strategies on short calls.
- Most vendors, educators and tools are TESTING placeholders until launch. A TESTING name is not a problem. A wrong kind of vendor is.

## 5. How Chris judges a call (what to look for)
- Disclosure: said word for word, once, before the first partner is named. Missing, late, repeated, or reworded is a fail. Choosing "beyond partners" and still getting partners named is a fail.
- Right resources for the stage. His biggest complaint: one resource when the stage needs a team. Name exactly which kinds of help the stage needed and were missing.
- Wrong routing is "very, very concerning". Any vendor of the wrong kind is a fail.
- No repeats: never asking for something the caller already said, in this call or a past one ("I said Ogden flip").
- Smart follow-up questions for the situation: a signed contract when a contractor walks off, which trades are left, the closing date when under contract.
- Questions with no reason are a miss (a water damage question when nobody mentioned damage).
- Listening: a misheard word should be confirmed, not acted on.
- Realistic paths that respect the caller's goal, money and time.
- Short, natural, peer tone. Fillers and stalls are noticed.

## 6. How to write a review
- One check per rule, each marked met, partly or missed, with a short quote as evidence.
- Verdict: pass (no real misses), partial (some misses), fail (wrong vendor, a broken guardrail, advice given, or the caller left with nothing useful).
- Say whether each problem is the prompt (Chris), the code or data (David), or missing resources (recruiting).
- A prompt fix is exact proposed wording in the prompt's own style: plain sentences, no lists inside rules, no em dashes.
- Keep it short and plain. Chris reads these on his phone.

## 7. Where the rest of the history lives
- Tracker: Supabase voice_agent_tracker_log (latest row per item_name is its status).
- Test cards and their reviews: the Lani Test Cards page (claude.ai artifact 8NetcUhVfNy9tCTcfph4KB).
- Specs: LANI-VENDOR-LOOKUP-SPEC.md, LANI-V2-FOLLOW-UP-SPEC.md, LANI-V2-CALL-RECORD-SPEC.md (Claude project docs).
- Repo rules: CLAUDE.md in UtahREIA/Voice-Agent-AI (vocabularies, GHL gotchas).
