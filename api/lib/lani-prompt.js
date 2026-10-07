/**
 * lani-prompt.js - assembles the Lani V2 system prompt (Part A from
 * lani_prompt_parts + Part B from lani-catalog.js), validates it, and writes it
 * to the V2 Vapi assistant.
 *
 * Safety rails:
 *   - Target assistant comes ONLY from env LANI_V2_ASSISTANT_ID. Missing, or
 *     equal to the live assistant, refuses before any read or write.
 *   - Without VAPI_API_KEY it returns not_configured and does nothing else.
 *   - Writes to Vapi only when LANI_PROMPT_WRITE is exactly "true" and the
 *     caller did not ask for a dry run.
 *   - Any validation failure records a failed build and never touches Vapi.
 *   - Vapi update: GET the assistant, change ONLY the system message content in
 *     the full model object, PATCH the full model back, GET again and confirm
 *     every other model key is unchanged. A failed confirm restores the
 *     original model and records the build as failed.
 */

import { createHash } from 'crypto';
import { buildCatalog, loadCatalogData } from './lani-catalog.js';

export const LIVE_ASSISTANT_ID = '92018c4f-f382-41b9-80e0-c46e8f2b505a';
export const CATALOG_MARKER = '<<CATALOG>>';
export const MAX_PROMPT_CHARS = 60000;
const VAPI_BASE = 'https://api.vapi.ai';

const NAME_MARK_RE = /\[\[([^\[\]]+?)\]\]/g;

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Pure: Part A + catalog -> final prompt, or a failure naming what is wrong.
 * @returns {{ ok: true, text, hash, chars } | { ok: false, error, missing? }}
 */
export function assemblePrompt(partA, catalog) {
  if (typeof partA !== 'string' || !partA.includes(CATALOG_MARKER)) {
    return { ok: false, error: `Part A has no ${CATALOG_MARKER} marker` };
  }
  const nameSet = new Set(catalog.names);
  const wanted = [...new Set([...partA.matchAll(NAME_MARK_RE)].map(m => m[1]))];
  const missing = wanted.filter(n => !nameSet.has(n));
  if (missing.length) {
    return { ok: false, error: 'Part A names records missing from the catalog: ' + missing.join(', '), missing };
  }
  const text = partA
    .split(CATALOG_MARKER).join(catalog.text)
    .replace(NAME_MARK_RE, '$1');
  if (text.length > MAX_PROMPT_CHARS) return { ok: false, error: `Prompt is ${text.length} chars, over ${MAX_PROMPT_CHARS}` };
  if (text.includes('<<')) return { ok: false, error: 'Prompt still contains "<<"' };
  if (text.includes('[[')) return { ok: false, error: 'Prompt still contains "[["' };
  if (text.includes(String.fromCharCode(0x2014))) return { ok: false, error: 'Prompt contains an em dash' };
  return { ok: true, text, hash: sha256(text), chars: text.length };
}

/** Find the system message in a Vapi model object. */
export function getSystemContent(model) {
  const msgs = Array.isArray(model?.messages) ? model.messages : [];
  const sys = msgs.find(m => m && m.role === 'system');
  return sys ? String(sys.content ?? '') : null;
}

/** Copy of the model with ONLY the system message content replaced. */
export function withSystemContent(model, content) {
  const copy = JSON.parse(JSON.stringify(model));
  const sys = copy.messages.find(m => m && m.role === 'system');
  sys.content = content;
  return copy;
}

/**
 * Compare two model objects: every key except messages must be identical, and
 * the non-system messages must be identical. Returns a list of differences.
 */
export function modelDrift(before, after, expectedSystem) {
  const diffs = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (k === 'messages') continue;
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) diffs.push(k);
  }
  const others = (m) => JSON.stringify((m?.messages || []).filter(x => x?.role !== 'system'));
  if (others(before) !== others(after)) diffs.push('messages(non-system)');
  if (getSystemContent(after) !== expectedSystem) diffs.push('messages(system content)');
  return diffs;
}

/** Record names in a catalog section of an existing prompt (best effort). */
export function namesInCatalogText(text) {
  const out = new Set();
  const idx = (text || '').search(/^CATALOG$/m);
  if (idx < 0) return out;
  for (const raw of text.slice(idx).split('\n').slice(1)) {
    const line = raw.replace(/^[-*•]\s*/, '').trim();
    if (!line || /^[A-Z][A-Z &]+$/.test(line)) continue;           // section headers
    if (line.startsWith('This is everything') || line.startsWith('Upcoming events')) continue;
    // "name | ..." lines split on the pipe only (names can contain ": ");
    // "title: description" lines split on the first ": ".
    const name = (line.includes(' | ') ? line.split(' | ')[0] : line.split(/:\s/)[0]).trim();
    if (name) out.add(name);
  }
  return out;
}

/** Records added / removed versus the assistant's current prompt. */
export function catalogDiff(currentPrompt, catalog) {
  const before = namesInCatalogText(currentPrompt || '');
  const after = new Set(catalog.names);
  return {
    added: [...after].filter(n => !before.has(n)).sort(),
    removed: [...before].filter(n => !after.has(n)).sort(),
    note: 'removed is parsed from the current prompt text, best effort'
  };
}

/**
 * Full rebuild. Every dependency is injectable for tests.
 * @param {{ trigger: string, dry?: boolean, env?: object, fetchImpl?: Function, log?: object }} opts
 */
export async function rebuildLaniPrompt({ trigger = 'manual', dry = false, env = process.env, fetchImpl = fetch, log = console } = {}) {
  const VAPI_API_KEY = env.VAPI_API_KEY;
  if (!VAPI_API_KEY) return { ok: false, error: 'not_configured' };

  const assistantId = (env.LANI_V2_ASSISTANT_ID || '').trim();
  if (!assistantId) return { ok: false, error: 'refused: LANI_V2_ASSISTANT_ID is not set' };
  if (assistantId === LIVE_ASSISTANT_ID) return { ok: false, error: 'refused: target is the live assistant' };

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, error: 'not_configured: supabase' };

  const writeEnabled = env.LANI_PROMPT_WRITE === 'true' && !dry;
  const sb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const vapi = { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' };

  let partAVersion = null;
  const record = async (row) => {
    try {
      await fetchImpl(`${SUPABASE_URL}/rest/v1/lani_prompt_builds`, {
        method: 'POST',
        headers: { ...sb, Prefer: 'return=minimal' },
        body: JSON.stringify({ trigger, assistant_id: assistantId, part_a_version: partAVersion, ...row })
      });
    } catch (e) { log.error('LANI PROMPT | build row write failed | ' + e.message); }
  };
  const fail = async (error, counts = null, extra = {}) => {
    log.error('LANI PROMPT | failed | ' + trigger + ' | ' + error);
    await record({ status: 'failed', error: String(error).slice(0, 2000), counts, written_to_vapi: extra.written_to_vapi === true });
    return { ok: false, status: 'failed', error, ...extra };
  };

  // 1. Part A
  let partA;
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/lani_prompt_parts?is_active=eq.true&select=version,part_a&limit=1`, { headers: sb });
    const rows = r.ok ? await r.json() : null;
    if (!Array.isArray(rows) || !rows[0]) return await fail('no active lani_prompt_parts row');
    partAVersion = rows[0].version;
    partA = rows[0].part_a;
  } catch (e) { return await fail('Part A read failed: ' + e.message); }

  // 2. Catalog + assembly + validation
  let catalog;
  try {
    catalog = buildCatalog(await loadCatalogData(SUPABASE_URL, SUPABASE_KEY, fetchImpl));
  } catch (e) { return await fail('catalog build failed: ' + e.message); }
  const built = assemblePrompt(partA, catalog);
  if (!built.ok) return await fail(built.error, { ...catalog.counts, missing: built.missing || [] }, { missing: built.missing || [] });
  const counts = catalog.counts;

  // 3. Dry run: read the assistant for the diff, write nothing to Vapi.
  if (!writeEnabled) {
    let diff = null;
    try {
      const g = await fetchImpl(`${VAPI_BASE}/assistant/${assistantId}`, { headers: vapi });
      if (g.ok) diff = catalogDiff(getSystemContent((await g.json()).model), catalog);
      else diff = { error: `assistant read http ${g.status}` };
    } catch (e) { diff = { error: 'assistant read failed: ' + e.message }; }
    await record({ status: 'dry_run', counts, prompt_chars: built.chars, prompt_hash: built.hash, written_to_vapi: false });
    log.log(`LANI PROMPT | dry_run | ${trigger} | ${built.chars} chars | ${built.hash.slice(0, 12)}`);
    return { ok: true, status: 'dry_run', counts, prompt_chars: built.chars, prompt_hash: built.hash, catalog: catalog.text, diff };
  }

  // 4. Unchanged since the last ok build: stop.
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/lani_prompt_builds?status=eq.ok&assistant_id=eq.${encodeURIComponent(assistantId)}&select=prompt_hash&order=built_at.desc&limit=1`, { headers: sb });
    const rows = r.ok ? await r.json() : [];
    if (Array.isArray(rows) && rows[0]?.prompt_hash === built.hash) {
      await record({ status: 'unchanged', counts, prompt_chars: built.chars, prompt_hash: built.hash, written_to_vapi: false });
      log.log(`LANI PROMPT | unchanged | ${trigger}`);
      return { ok: true, status: 'unchanged', counts, prompt_hash: built.hash };
    }
  } catch (e) { return await fail('last build read failed: ' + e.message, counts); }

  // 5. Write: GET full model, swap only the system content, PATCH, confirm.
  let original;
  try {
    const g = await fetchImpl(`${VAPI_BASE}/assistant/${assistantId}`, { headers: vapi });
    if (!g.ok) return await fail(`assistant read http ${g.status}`, counts);
    original = (await g.json()).model;
  } catch (e) { return await fail('assistant read failed: ' + e.message, counts); }
  if (!original || typeof original !== 'object' || getSystemContent(original) === null) {
    return await fail('assistant has no model object with a system message', counts);
  }

  const next = withSystemContent(original, built.text);
  try {
    const p = await fetchImpl(`${VAPI_BASE}/assistant/${assistantId}`, {
      method: 'PATCH', headers: vapi, body: JSON.stringify({ model: next })
    });
    if (!p.ok) return await fail(`assistant PATCH http ${p.status}: ${(await p.text()).slice(0, 300)}`, counts);
  } catch (e) { return await fail('assistant PATCH failed: ' + e.message, counts); }

  let drift;
  try {
    const g2 = await fetchImpl(`${VAPI_BASE}/assistant/${assistantId}`, { headers: vapi });
    drift = g2.ok ? modelDrift(original, (await g2.json()).model, built.text) : [`confirm read http ${g2.status}`];
  } catch (e) { drift = ['confirm read failed: ' + e.message]; }

  if (drift.length) {
    // Put the original model back so a bad write never sticks.
    let restored = false;
    try {
      const r = await fetchImpl(`${VAPI_BASE}/assistant/${assistantId}`, {
        method: 'PATCH', headers: vapi, body: JSON.stringify({ model: original })
      });
      restored = r.ok;
    } catch (e) { /* reported below */ }
    return await fail(`confirm failed, changed: ${drift.join(', ')}; original ${restored ? 'restored' : 'NOT restored'}`,
      counts, { written_to_vapi: true, restored });
  }

  await record({ status: 'ok', counts, prompt_chars: built.chars, prompt_hash: built.hash, written_to_vapi: true });
  log.log(`LANI PROMPT | ok | ${trigger} | ${built.chars} chars | ${built.hash.slice(0, 12)}`);
  return { ok: true, status: 'ok', counts, prompt_chars: built.chars, prompt_hash: built.hash };
}
