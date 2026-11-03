# Lani V2: follow-up system (build spec)

Drafted by chat 5 on 2026-11-03. **Status: Chris approved building layers 1 and 3 first (2026-11-03).** Layers 2 and 4 come after. Ready for David (chat 6) to review and build.

## Why
- Lani can only say about three things on a call, but most callers need more help over time.
- Lani already promises follow-up ("I will make sure we get you connected", "someone from our team will follow up"). The call record captures these promises (missingHelp, humanRequested, teamFollowUp, and no_match needs in the cache), but nothing acts on them today. No staff task is created.

## Layer 1. Promise tasks (build first)
When a call ends, ghl-sync creates one GHL task on the contact if any of these is true:
- `missingHelp` is not empty
- `humanRequested` is true
- `teamFollowUp` is not empty
- the find_resources cache has a `no_match` need for the call
- the caller is a vendor who wants to list or sponsor

Task details:
- **Title:** "Lani follow-up: [first name] [last name]"
- **Body:** the call `summary`, then one line per reason (for example "Missing help: securities attorney"), then `recommendedNextStep`
- **Assigned to:** the staff member Chris names (default Angela until he says otherwise)
- **Due:** 2 business days after the call. Same day if `urgent` is true.
- Test calls (TESTING vendors or Chris's test numbers) create the task with "TEST" in the title so they can be cleared in bulk.

Done when: a test call that ends with the MISSING HELP line creates one task with the right reason, and a call with no promise creates none.

## Layer 3. Automatic check-in text (build first)
A GHL workflow sends one text 7 days after a completed Lani call:
- **Starts when:** a tag such as `lani_call_completed` is added by ghl-sync, with the call date in a field.
- **Text (draft for Chris to edit):** "Hi [first name], it is Lani from Utah REIA. Checking in on your next step. Did you get a chance to connect with [first resource]? Reply here or call me back anytime and we can line up what comes next."
- **Stops if:** the contact calls Lani again, replies, books with an educator, or opts out.
- **Reply handling:** any reply creates a task for staff (same assignee as Layer 1).
- Uses the TCPA consent David is adding to the web form. No text goes to anyone without consent.

Done when: a test contact gets the text 7 days later (or after a short test delay), and a reply creates a task.

## Layer 2. Next needs list (later)
- Add one field to `laniCallRecord`: `nextNeeds`, the kinds of help this caller will likely need at their next step that were not covered on the call (up to 3, plain words).
- ghl-sync saves it to a GHL contact field "Lani Next Needs".
- The Layer 3 text can then name the next need instead of only checking in.

## Layer 4. Lani remembers (later)
- caller-history already loads a returning member's past calls. Add the last call's `recommendedNextStep` and `nextNeeds` to the RETURNING MEMBER PROFILE.
- Lani opens with one line about it, for example "Last time we talked about a property manager in Ogden. Did that come together?"

## Decisions for Chris
1. Who gets the follow-up tasks (default: Angela).
2. Final wording of the 7-day text.
3. Whether a second check-in at 30 days is wanted.
