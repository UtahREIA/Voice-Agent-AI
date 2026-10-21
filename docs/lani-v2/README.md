# Lani V2 specs

Copies of the Lani V2 planning documents, so the build chat (chat 6, David) can read them from the repo. The originals live in the Claude Project "Investor Mapping and Routing System", folder claude/.

| File | What it is |
|---|---|
| LANI-VENDOR-LOOKUP-SPEC.md | Build spec for find_resources, location matching, end-of-call outputs and referral billing |
| LANI-V3-LOOKUP-RULES-DRAFT.md | Lani V2 prompt, lookup version (no catalog). Loads onto the test assistant once find_resources is attached |
| LANI-V1-SUNSET-AND-SYNC.md | What retires from V1 at the switch, and the rules that keep chat 5 and chat 6 in sync |
| LANI-V2-CALL-RECORD-SPEC.md | What gets saved after each call: the find_resources cache (exact recommended items) and the laniCallRecord structured output |

Rules:
- Chat 5 (Chris) owns these files. When one changes, chat 5 updates both copies and logs the change in voice_agent_tracker_log with lani_scope = V2.
- Chat 6 reads them and does not edit them. If code and spec disagree, raise it in the tracker before building.
- Docs only. Nothing here is read by the app.
