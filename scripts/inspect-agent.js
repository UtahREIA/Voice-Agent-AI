/**
 * inspect-agent.js — READ-ONLY. Prints where tools + server config actually live
 * on the live and V2 assistants, so we wire the right fields. Writes nothing.
 *
 * Run (PowerShell):
 *   $env:VAPI_API_KEY="<your vapi private key>"; node scripts/inspect-agent.js
 */

const VAPI_BASE = 'https://api.vapi.ai';
const IDS = {
  live: '92018c4f-f382-41b9-80e0-c46e8f2b505a',
  v2:   '39e25be8-2e81-4df5-a314-e741b3a31160'
};

const KEY = process.env.VAPI_API_KEY;
if (!KEY) { console.error('Set VAPI_API_KEY first.'); process.exit(1); }
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function getAssistant(id) {
  const r = await fetch(`${VAPI_BASE}/assistant/${id}`, { headers });
  if (!r.ok) throw new Error(`GET ${id} -> http ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function report(label, a) {
  const m = a.model || {};
  console.log(`\n===== ${label} =====`);
  console.log('id:', a.id, '| name:', a.name);
  console.log('top-level keys:', Object.keys(a).join(', '));
  console.log('model keys:', Object.keys(m).join(', '));
  console.log('a.toolIds:', JSON.stringify(a.toolIds || null));
  console.log('model.toolIds:', JSON.stringify(m.toolIds || null));
  console.log('model.tools (names):', JSON.stringify((m.tools || []).map(t => t?.function?.name || t?.type || '?')));
  console.log('a.server:', JSON.stringify(a.server || null));
  console.log('a.serverUrl:', JSON.stringify(a.serverUrl || null));
  console.log('a.serverMessages:', JSON.stringify(a.serverMessages || null));
}

(async () => {
  report('LIVE (92018c4f)', await getAssistant(IDS.live));
  report('V2 (39e25be8)', await getAssistant(IDS.v2));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
