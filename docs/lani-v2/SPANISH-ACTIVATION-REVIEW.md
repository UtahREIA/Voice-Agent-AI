# Spanish for Lani — Activation Review

**For:** Chris Borden (decision)
**Prepared by:** David (chat 6)
**Date:** 2026-11-17
**Ref:** voice_agent_tracker_log item 650 (Spanish transcriber decision)

## The question

Can we offer Lani in Spanish, and what does it actually take? The working assumption
was that this is an ElevenLabs (voice) setup task. It is not.

## Headline

**ElevenLabs is not the blocker.** Lani's current voice already supports Spanish.
The real work is the transcriber (speech-to-text) plus a one-line prompt instruction,
and both are Vapi changes, not ElevenLabs changes.

## How a Lani call flows

Caller speech -> Deepgram (speech to text) -> Claude (the brain) -> ElevenLabs (voice)
-> caller hears Lani. Spanish has to work at each stage below.

## Stage by stage

1. **Voice (ElevenLabs) — READY.** The current model `eleven_turbo_v2_5` is multilingual
   (32 languages incl. Spanish); the fallback is `eleven_multilingual_v2`. Harmonie's
   cloned voice can speak Spanish today with no change. Caveat: it is an English voice
   clone, so Spanish may carry a slight English accent. Optional upgrade: a Spanish-native
   voice or clone for accent quality.

2. **Transcriber (Deepgram) — THE MAIN BLOCKER.** It is currently locked to English
   (`language: "en"`). Spanish speech will not transcribe correctly until this changes to:
   - `"multi"` (nova-3 multilingual; handles English and Spanish in the same call), or
   - `"es"` (Spanish only).
   The current keyterm list is English real-estate vocabulary; for Spanish we would add
   Spanish equivalents.

3. **Brain (Claude) — READY, needs one prompt line.** Claude speaks Spanish natively.
   The system prompt just needs an instruction such as "respond in the caller's language."

4. **Greeting — minor.** The opening line is hardcoded English in the web widget, so a
   Spanish caller hears English until they speak. Optional: a bilingual opener, or
   detect-and-switch.

5. **Downstream content — English today.** Follow-up SMS, resource names, and GHL fields
   are English. Not required for Lani to *speak* Spanish, but it matters for a full
   Spanish experience.

## What it takes

**Minimum to turn Spanish on (low effort):**
- Set Deepgram `language` to `"multi"` (recommended) or `"es"`.
- Add the "respond in the caller's language" line to the prompt.
- Both are Vapi changes: a transcriber setting plus a prompt version and a dashboard publish.

**Full / polished Spanish experience (optional, fast-follow):**
- Spanish-native voice for accent quality.
- Bilingual greeting.
- Spanish follow-up SMS and localized resource text.

## Risk / notes

- `"multi"` mode is safe for English callers (it auto-detects) and is best for a mixed
  audience. `"es"` mode is Spanish-only and would degrade English calls, so it only makes
  sense if Spanish callers are routed separately.
- Any transcriber or prompt change is a Vapi dashboard publish, which has historically
  risked dropping the `laniCallRecord` structured output. Re-verify it after the change.

## Decision needed (Chris)

1. Do we commit to Spanish for launch, or drop the promise? (item 650)
2. If yes: `"multi"` (mixed EN/ES, recommended) or Spanish-only?
3. Do we want native-accent Spanish voice now, or as a fast-follow?

## Recommendation

If we want Spanish: ship the **minimum** first — Deepgram `"multi"` plus the prompt line —
and treat the Spanish voice, greeting, and SMS polish as a fast-follow. Keep Harmonie's
current voice for now; it already speaks Spanish.
