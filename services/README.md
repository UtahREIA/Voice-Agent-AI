# Service catalog — add a vendor service in one place

Adding a new vendor service type used to mean editing several places by hand (the GHL
Vendors & Partners picklist and the Supabase routing tables), which drifts. This folder
makes the catalog the single source of truth: **edit `services.json` once, run one command,
and the routing flows into Supabase.** The GHL picklist is a printed one-line step, because
GHL custom-object endpoints cannot be written from outside GHL (they 403 — see CLAUDE.md).

## How to add a service
1. Add a block to `services.json` under `services` (copy the template, set `active: true`).
2. Run the apply command:
   ```
   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/apply-services.js --dry   # preview
   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/apply-services.js          # apply
   ```
   (Or ask Claude to run it via the Supabase MCP, so you don't handle the key locally.)
3. Do the one printed **GHL step**: add the `token` as an option on the named GHL field of the
   Vendors & Partners object. Do this in the GHL UI, or ask Claude to do it via the GHL MCP
   (`ghl_update_object_field`). This is the only manual-ish part, and it's unavoidable: GHL
   blocks writes to custom-object fields from Vercel/Supabase/scripts.

That's it. Once the GHL option exists, any vendor tagged with that service syncs into Supabase
on the nightly run and becomes matchable **once a human sets Approval Status = Approved**
(the vendor vetting gate still applies).

## The schema (each service block)
| Field | Meaning | Rule |
| --- | --- | --- |
| `token` | the service value | the **exact GHL double-underscore value** (e.g. `money_lender_private__hard_money`), snake_case. This is what lands in `vendor_categories`. |
| `display_name` | human label | free text, for humans only. |
| `ghl_field` | which Vendors & Partners field the option lives on | e.g. `funding__financial`, `team__vendors`, `deals__opportunities`, `operations`, `development__land`, `education_technology__tools`, `attorney_subclass`, `contractor_speciality`. Stored as `ghl_field_source`. |
| `active` | apply it or not | only `true` services are applied; the template stays `false`. |
| `routing[]` | when Lani recommends it | one entry per caller situation it answers. |

Each `routing` entry:
| Field | Meaning | Rule |
| --- | --- | --- |
| `investor_need` | the caller's blocker this service answers | a blocker key: `deals`, `funding`, `team`, `legal` (the vendor_routing_matrix vocabulary). |
| `strategy` | optional strategy narrowing | a **canonical `strategy_crosswalk` key** (e.g. `fix_and_flip`, `buy_and_hold`) or `null` for all strategies. |
| `priority` | tie-break order | integer, lower fires first. Default 5. |
| `connection_methods` | how the match is delivered | subset of `vendor_directory`, `ai_recommendation`, `warm_intro`. Defaults to directory + ai. |
| `vendor_subtypes` | optional speciality values | GHL subtype values; usually empty. |
| `notes` | audit note | free text. |

## What the apply command does
- Reads `services.json`, and for each **active** service's routing rules, **inserts** a
  `vendor_routing_matrix` row (`vendor_categories = [token]`, `ghl_field_source = ghl_field`,
  plus the rule fields) **only if an equivalent active row does not already exist**.
- It is additive and idempotent: it never edits or deletes rows, and re-running is safe.
- It prints the GHL picklist checklist and a summary (inserted / already-present / errors).

## What it intentionally does NOT do
- It does not write to GHL (403). The GHL option is the printed manual/MCP step.
- It does not change `strategy_crosswalk`, education or tools routing — this catalog is vendor
  service types only, by design. Those tables stay governed by the `utah-reia-routing-matrix` skill.
- It does not deactivate or retire services; retire a routing row the usual way
  (`is_active = false`) per the routing-matrix skill.

## Making it the full source of truth (optional, later)
Today the catalog holds new services you add going forward. To make it the complete record,
backfill the existing `vendor_routing_matrix` rows into `services.json` once (Claude can
generate that from the live table). After that, the file mirrors everything.
