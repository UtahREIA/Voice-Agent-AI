// Vendor matcher regression test for api/find-resources.js.
// Run: node tests/find-resources-matcher.test.mjs   (no network; Supabase is mocked)
// Fixture: a slice of ghl_vendor_resources taken 2026-11-11.
import fs from 'fs';
import assert from 'assert';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';
const fixture = JSON.parse(fs.readFileSync(new URL('./find-resources-vendors.fixture.json', import.meta.url)));
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('ghl_vendor_resources') ? fixture : []) });
const { default: handler } = await import('../api/find-resources.js');

async function lookup(needs) {
  let out;
  const res = { setHeader() {}, status() { return this; }, json(o) { out = o; return this; }, end() { return this; } };
  await handler({ method: 'POST', body: { needs } }, res);
  return JSON.parse(out.result).needs;
}
const first = async (service, city) => {
  const [n] = await lookup([{ type: 'vendor', service, ...(city ? { city } : {}) }]);
  return { status: n.status, names: (n.matches || []).map(m => m.name), closest: (n.matches || []).map(m => m.closest_fit) };
};

const cases = [
  // [service, city, expected first match (or status), names that must NOT appear]
  ['real estate agent', 'Ogden', 'Real Estate Agent TESTING', ['JMOSS', 'Real Estate Transaction Attorney TESTING', 'Entity Formation Registered Agent TESTING']],
  ['realtor', 'Ogden', 'Real Estate Agent TESTING', ['JMOSS']],
  ['leasing agent', 'Provo', 'Leasing Agent TESTING', ['Entity Formation Registered Agent TESTING']],
  ['real estate litigation attorney', null, null, ['Real Estate Agent TESTING']],
  ['entity formation attorney', null, 'Entity Formation Registered Agent TESTING', []],
  ['mortgage broker', null, 'Mortgage Broker TESTING', []],
  ['mortgage broker who knows owner occupied multi unit loans', null, 'Mortgage Broker TESTING', []],
  ['title company', null, 'Title Closing Escrow Officer TESTING', ['Loan Servicing Company TESTING']],
  ['tax professional', null, 'Accountant Tax Specialist TESTING', []],
  ['1031 exchange specialist', null, '1031 Exchange TESTING', []],
  ['landlord insurance', null, 'Insurance TESTING', ['Landlord Tenant Attorney TESTING']],
  ['landlord and tenant attorney', null, 'Landlord Tenant Attorney TESTING', ['Tenant Screening Service TESTING']],
  ['tenant screening service', null, 'Tenant Screening Service TESTING', []],
  ['securities attorney', null, 'Sec Securities Attorney TESTING', []],
  ['painter', 'Ogden', 'Painter TESTING', []],
  ['lawyer for a contractor dispute', null, null, ['Real Estate Agent TESTING', 'General Contractor TESTING']],
];

let failed = 0;
for (const [service, city, want, banned] of cases) {
  const r = await first(service, city);
  try {
    assert.equal(r.status, 'ok', `${service}: status ${r.status}`);
    if (want) assert.equal(r.names[0], want, `${service}: first match ${r.names[0]}`);
    for (const b of banned) assert.ok(!r.names.includes(b), `${service}: should not return ${b}`);
    console.log('ok  ', service.padEnd(56), '->', r.names.join(' | '));
  } catch (e) { failed++; console.log('FAIL', e.message, '| got:', r.names.join(' | ')); }
}

// Up to 5 needs per lookup (was 3).
const five = await lookup([1, 2, 3, 4, 5, 6].map(() => ({ type: 'vendor', service: 'hard money lender' })));
try { assert.equal(five.length, 5); console.log('ok   5 needs per lookup'); } catch (e) { failed++; console.log('FAIL needs cap', five.length); }

// A lawyer request is never treated as a local service, even with a local word in it.
const [law] = await lookup([{ type: 'vendor', service: 'lawyer for a contractor dispute' }]);
try { assert.notEqual(law.status, 'needs_location'); console.log('ok   attorney request does not ask for a location'); } catch (e) { failed++; console.log('FAIL attorney needs_location'); }

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
