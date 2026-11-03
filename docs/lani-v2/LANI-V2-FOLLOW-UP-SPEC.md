# Lani V2: follow-up system (build spec)

Drafted by chat 5 on 2026-11-03. **Status: Chris approved the approach on 2026-11-03.** Ready for David (chat 6) to review and build.

## Chris's decisions (2026-11-03)
1. **Team follow-ups go into a GHL workflow, not a loose task.** Once a contact is in the workflow, every further message is Angela's responsibility.
2. **Check-ins are personalized.** Each check-in is written for that caller, about their last call and their next step. No generic "how did it go" text.
3. **Timing depends on the call.** Some callers need a check-in in days, others in weeks or months. Lani's call record decides the timing per caller.

## Why
- Lani can only cover about three things on a call, but most callers need more help over time.
- Lani already promises follow-up ("I will make sure we get you connected", "someone from our team will follow up"). The call record captures these promises, but nothing acts on them today.

## Part 1. New fields in laniCallRecord
Add these to the laniCallRecord structured output (field text below becomes the Vapi description).

| Field | Type | What it captures |
|---|---|---|
| nextNeeds | string | Up to 3 kinds of help this caller will likely need at their next step that were not covered on the call, in plain words, comma separated. Empty if none. |
| checkInMessage | string | A text message to the caller, under 320 characters, from Lani at Utah REIA. Use their first name. Name the specific thing they were working on and the next step from this call, for example the property manager in Ogden or the securities attorney. Ask if they need more help with it, and invite them to reply or call Lani back. No links. Never call a deal, plan or strategy good, solid, safe or a fit. No advice. |
| checkInDays | integer | Days after the call to send the first check-in. 2 if there was a deadline within two weeks or something urgent. 7 if they are doing deals and were sent to a specific vendor. 14 if they are learning or getting ready. 30 if they are still deciding or the next step is months away. 0 for vendor callers, member questions and hang-ups. |
| secondCheckInDays | integer | Days after the first check-in for a second one, only for longer journeys such as someone learning a strategy, building toward a first deal, or with a goal more than six months out. 0 if no second check-in. |
| secondCheckInMessage | string | The second text, same rules as checkInMessage, about the next need after this one (use nextNeeds). Empty if secondCheckInDays is 0. |

## Part 2. Team follow-up workflow (Angela)
**When:** ghl-sync adds the tag `lani_team_follow_up` if any of these is true for the call:
- `missingHelp` is not empty
- `humanRequested` is true
- `teamFollowUp` is not empty
- the find_resources cache has a `no_match` need
- the caller is a vendor who wants to list or sponsor

ghl-sync also writes a GHL contact field "Lani Follow-Up Reason" with one line per reason (for example "Missing help: securities attorney"), followed by the call summary and recommendedNextStep.

**GHL workflow "Lani Team Follow-Up" (built in GHL):**
- Trigger: tag `lani_team_follow_up` added.
- Action 1: internal notification to Angela with the follow-up reason and a link to the contact.
- Action 2: task assigned to Angela, due in 2 business days, or same day if `urgent` is true.
- From here, all communication with the contact is Angela's.
- Remove the tag when the task is completed, so a later call can trigger it again.

## Part 3. Personalized check-in workflow
**When:** ghl-sync, for every completed investor call where checkInDays is above 0:
- writes "Lani Check-In Message" and "Lani Check-In Date" (call date plus checkInDays)
- writes "Lani Second Check-In Message" and "Lani Second Check-In Date" if secondCheckInDays is above 0
- writes "Lani Next Needs"
- adds the tag `lani_check_in` (removes and re-adds it on a new call, so the newest call always wins)

**GHL workflow "Lani Check-In" (built in GHL):**
- Trigger: tag `lani_check_in` added.
- Wait until "Lani Check-In Date". Send the text in "Lani Check-In Message".
- If "Lani Second Check-In Date" is set: wait until that date and send "Lani Second Check-In Message".
- **Stop the workflow if:** the contact replies, calls Lani again (the new call resets it), books with an educator, is in the Team Follow-Up workflow, or opts out.
- **Any reply:** add the contact to the Team Follow-Up workflow, so Angela handles it.
- Only texts contacts who gave consent on the web form (David's TCPA checkbox).

## Part 4. Lani remembers (later)
- caller-history already loads a returning member's past calls. Add the last call's recommendedNextStep and nextNeeds to the RETURNING MEMBER PROFILE.
- Lani opens with one line about it, for example "Last time we talked about a property manager in Ogden. Did that come together?"

## Tests before it counts as done
1. A test call that ends with the MISSING HELP line adds the Team Follow-Up tag, notifies Angela and creates one task.
2. A call with no promise does not.
3. A test call writes a personalized check-in message that names the call's real next step, with the right number of days, and the text arrives on the date (use a short test delay).
4. A reply to the check-in stops it and moves the contact to Angela.
5. Test contacts (TESTING records or Chris's test numbers) are marked TEST in the task title.
