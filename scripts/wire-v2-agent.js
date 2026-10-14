/**
 * wire-v2-agent.js — attach the LIVE agent's tools to the NEW (V2) agent.
 *
 * Vapi keeps tools at model.toolIds (NOT top-level). This script:
 *   1. GET live (92018c4f)  -> read model.toolIds (the 7 tools).
 *   2. GET v2 (39e25be8)    -> read its current model (prompt lives here).
 *   3. PATCH v2 with { model: { ...v2.model, toolIds: <live toolIds> } }.
 *      Only toolIds is added to the model; messages/provider/model/temperature
 *      are preserved verbatim, so the V2 PROMPT IS NOT TOUCHED.
 *   4. Re-GET v2 and confirm model.toolIds now matches live.
 *
 * Server URL: the live agent has NO assistant-level server URL — it is set at
 * the Vapi org level and inherited by every assistant, V2 included. So there is
 * nothing per-assistant to copy. If you ever want to force an assistant-level
 * server URL on V2, pass --server-url=<url> and it will be set as top-level
 * server.url; omitted by default to match live exactly.
 *
 * Run (PowerShell):
 *   $env:VAPI_API_KEY="<key>"; node scripts/wire-v2-agent.js --dry   # preview
 *   $env:VAPI_API_KEY="<key>"; node scripts/wire-v2-agent.js         # write
 */

const VAPI_BASE = 'https://api.vapi.ai';
const LIVE_ASSISTANT_ID = '92018c4f-f382-41b9-80e0-c46e8f2b505a';
const V2_ASSISTANT_ID   = (process.env.LANI_V2_ASSISTANT_ID || '').trim() || '39e25be8-2e81-4df5-a314-e741b3a31160';
const DRY = process.argv.includes('--dry');
const serverUrlArg = (process.argv.find(a => a.startsWith('--server-url=')) || '').split('=')[1] || null;

const KEY = process.env.VAPI_API_KEY;
if (!KEY) { console.error('Set VAPI_API_KEY first.'); process.exit(1); }
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function getAssistant(id) {
  const r = await fetch(`${VAPI_BASE}/assistant/${id}`, { headers });
  if (!r.ok) throw new Error(`GET ${id} -> http ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

(async () => {
  const live = await getAssistant(LIVE_ASSISTANT_ID);
  const v2   = await getAssistant(V2_ASSISTANT_ID);

  const liveToolIds = (live.model && live.model.toolIds) || [];
  const v2ToolIdsBefore = (v2.model && v2.model.toolIds) || [];
  console.log('live model.toolIds:', JSON.stringify(liveToolIds));
  console.log('v2   model.toolIds (before):', JSON.stringify(v2ToolIdsBefore));

  if (!liveToolIds.length) throw new Error('Live agent has no model.toolIds to copy — aborting.');
  if (!v2.model || typeof v2.model !== 'object') throw new Error('V2 has no model object — aborting.');

  // Merge ONLY toolIds into the existing V2 model. Everything else (messages =
  // the system prompt, provider, model, temperature) is carried over untouched.
  const nextModel = { ...v2.model, toolIds: liveToolIds };

  const patch = { model: nextModel };
  if (serverUrlArg) { patch.server = { url: serverUrlArg }; console.log('also setting top-level server.url =', serverUrlArg); }

  console.log('\nV2 model keys that will be written:', Object.keys(nextModel).join(', '));
  console.log('V2 system prompt preserved:', Array.isArray(nextModel.messages) && nextModel.messages.length > 0);
  if (DRY) { console.log('\n--dry: nothing written.'); return; }

  const p = await fetch(`${VAPI_BASE}/assistant/${V2_ASSISTANT_ID}`, {
    method: 'PATCH', headers, body: JSON.stringify(patch)
  });
  if (!p.ok) throw new Error(`PATCH V2 -> http ${p.status}: ${(await p.text()).slice(0, 400)}`);

  const after = await getAssistant(V2_ASSISTANT_ID);
  const v2ToolIdsAfter = (after.model && after.model.toolIds) || [];
  console.log('\nv2 model.toolIds (after):', JSON.stringify(v2ToolIdsAfter));
  console.log('v2 system prompt still present:', Array.isArray(after.model?.messages) && after.model.messages.length > 0);

  const ok = v2ToolIdsAfter.length === liveToolIds.length &&
             liveToolIds.every(id => v2ToolIdsAfter.includes(id));
  console.log(ok ? '\nOK — V2 now has the same 7 tools as live, prompt preserved.'
                 : '\nWARNING — toolIds do not match; inspect output above.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
