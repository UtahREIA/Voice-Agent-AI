#!/usr/bin/env node
/**
 * apply-services.js — apply the central service catalog to Supabase routing.
 *
 * Reads services/services.json (the single source of truth for vendor service
 * types) and, for each ACTIVE service, ensures its vendor_routing_matrix rows
 * exist in Supabase. ADDITIVE and IDEMPOTENT: it inserts rows that are missing
 * and never edits or deletes existing ones, so running it twice is safe.
 *
 * It deliberately does NOT write to GHL. GHL custom-object endpoints 403 from
 * outside GHL (Vercel/Supabase/local scripts), so the GHL picklist option must be
 * added in the GHL UI or via Claude's GHL MCP tools. The script prints that
 * checklist so nothing is forgotten — that is how "one place" covers both systems
 * without drift: Supabase is applied automatically, GHL is a printed one-liner.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/apply-services.js
 *   add  --dry  to report what it WOULD insert without writing.
 *
 * Every value in the catalog must follow the vendor_routing_matrix conventions
 * (see services/README.md and the utah-reia-routing-matrix skill): `token` is the
 * exact GHL double-underscore value, `strategy` is a canonical strategy_crosswalk
 * key or null, and `investor_need` is a blocker key (deals/funding/team/legal/...).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DRY = process.argv.includes('--dry');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, '..', 'services', 'services.json');

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
}

// Does an active matrix row already map this need (+strategy) to this service token?
async function rowExists(need, strategy, token) {
  const strat = strategy ? `strategy=eq.${encodeURIComponent(strategy)}` : 'strategy=is.null';
  const url = `${SUPABASE_URL}/rest/v1/vendor_routing_matrix`
    + `?investor_need=eq.${encodeURIComponent(need)}`
    + `&${strat}`
    + `&vendor_categories=cs.{${encodeURIComponent(token)}}`
    + `&is_active=eq.true&select=id`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`check failed ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return (await r.json()).length > 0;
}

async function insertRow(service, rule) {
  const body = [{
    investor_need: rule.investor_need,
    strategy: rule.strategy || null,
    vendor_categories: [service.token],
    vendor_subtypes: (rule.vendor_subtypes && rule.vendor_subtypes.length) ? rule.vendor_subtypes : null,
    connection_methods: (rule.connection_methods && rule.connection_methods.length)
      ? rule.connection_methods : ['vendor_directory', 'ai_recommendation'],
    priority: Number.isFinite(rule.priority) ? rule.priority : 5,
    is_active: true,
    ghl_field_source: service.ghl_field || null,
    notes: rule.notes || `Added via service catalog (${service.token})`
  }];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/vendor_routing_matrix`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`insert failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json())[0];
}

(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY) in the environment.');
    process.exit(1);
  }
  let catalog;
  try { catalog = JSON.parse(readFileSync(catalogPath, 'utf8')); }
  catch (e) { console.error(`Could not read ${catalogPath}: ${e.message}`); process.exit(1); }

  const services = Array.isArray(catalog.services) ? catalog.services : [];
  const active = services.filter(s => s.active);
  console.log(`Service catalog: ${services.length} total, ${active.length} active.${DRY ? '  (DRY RUN — no writes)' : ''}\n`);

  const ghlChecklist = [];
  let inserted = 0, skipped = 0, errors = 0;

  for (const s of active) {
    if (!s.token || !s.ghl_field) {
      console.log(`SKIP "${s.display_name || s.token || '(unnamed)'}": missing token or ghl_field`);
      continue;
    }
    ghlChecklist.push(`  - GHL field "${s.ghl_field}": add option "${s.token}"  (${s.display_name || ''})`);
    for (const rule of (s.routing || [])) {
      if (!rule.investor_need) { console.error(`ERROR ${s.token}: a routing rule is missing investor_need`); errors++; continue; }
      const label = `${s.token} -> need=${rule.investor_need}${rule.strategy ? `/strategy=${rule.strategy}` : ''} (priority ${rule.priority ?? 5})`;
      try {
        if (await rowExists(rule.investor_need, rule.strategy, s.token)) {
          console.log(`skip (exists)   ${label}`); skipped++; continue;
        }
        if (DRY) { console.log(`would insert    ${label}`); inserted++; continue; }
        await insertRow(s, rule);
        console.log(`inserted        ${label}`); inserted++;
      } catch (e) { console.error(`ERROR ${label}: ${e.message}`); errors++; }
    }
  }

  console.log(`\nSupabase vendor_routing_matrix: ${inserted} ${DRY ? 'would be inserted' : 'inserted'}, ${skipped} already present, ${errors} errors.`);
  console.log(`\nGHL step (do in the GHL UI or via Claude's GHL MCP — Vercel/scripts cannot, 403):`);
  console.log(ghlChecklist.length ? ghlChecklist.join('\n') : '  (no active services)');
  console.log(`\nAfter the GHL option exists, vendors tagged with that service sync in on the nightly run and become matchable once Approved.`);
  if (errors) process.exit(1);
})();
