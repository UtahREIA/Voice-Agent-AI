// Loan product routing test for api/find-resources.js (2026-11-19).
// Run: node tests/find-resources-loan-products.test.mjs   (no network; Supabase is mocked)
// Fixture: the 2026-11-11 vendor slice plus TESTING lenders tagged with the
// loan products Chris will tag in GHL (Loan Product (partner) field).
import fs from 'fs';
import assert from 'assert';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';
const base = JSON.parse(fs.readFileSync(new URL('./find-resources-vendors.fixture.json', import.meta.url)));
const lenders = [
  { ghl_record_id: 'conv', company_name: 'Conventional Lending TESTING', funding_financial: ['mortgage_broker'], loan_product: ['conventional', 'fha', 'va', 'heloc__home_equity'] },
  { ghl_record_id: 'dscr', company_name: 'Dscr Loan TESTING', funding_financial: ['mortgage_broker'], loan_product: ['dscr', 'bank_statement', '1099__pl'] },
  { ghl_record_id: 'rental', company_name: 'Rental Financing TESTING', funding_financial: ['mortgage_broker'], loan_product: ['dscr', 'blanket__portfolio'] },
  { ghl_record_id: 'port', company_name: 'Portfolio Loans TESTING', funding_financial: ['mortgage_broker'], loan_product: ['blanket__portfolio', 'commercial_mortgage', 'sba'] },
  { ghl_record_id: 'bridge', company_name: 'Bridge Loan TESTING', funding_financial: ['money_lender_private__hard_money'], loan_product: ['bridge', 'construction'] },
  { ghl_record_id: 'newcon', company_name: 'New Construction Contractor TESTING', contractor_speciality: 'new_construction' },
  { ghl_record_id: 'apprc', company_name: 'Commercial Appraiser TESTING', team_vendors: ['appraiser_commercial'] },
];
const fixture = [...base, ...lenders];
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('ghl_vendor_resources') ? fixture : []) });
const { default: handler } = await import('../api/find-resources.js');

async function lookup(needs) {
  let out;
  const res = { setHeader() {}, status() { return this; }, json(o) { out = o; return this; }, end() { return this; } };
  await handler({ method: 'POST', body: { needs } }, res);
  return JSON.parse(out.result).needs;
}
const run = async (service) => {
  const [n] = await lookup([{ type: 'vendor', service }]);
  return { status: n.status, names: (n.matches || []).map(m => m.name), closest: (n.matches || []).map(m => m.closest_fit) };
};

const DSCR = ['Dscr Loan TESTING', 'Rental Financing TESTING'];
const BLANKET = ['Rental Financing TESTING', 'Portfolio Loans TESTING'];
const NOT_LENDERS = ['Loan Servicing Company TESTING', 'General Contractor TESTING', 'New Construction Contractor TESTING', 'Commercial Appraiser TESTING'];
const cases = [
  // [service Lani sends, first match must be one of, names that must not appear, expect closest fit?]
  ['DSCR lender', DSCR, ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['mortgage broker for DSCR loans', DSCR, ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['FHA mortgage broker', ['Conventional Lending TESTING'], ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['mortgage broker for VA loans', ['Conventional Lending TESTING'], ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['conventional mortgage broker', ['Conventional Lending TESTING'], ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['mortgage broker for bank statement loans', ['Dscr Loan TESTING'], ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['mortgage broker for 1099 loans', ['Dscr Loan TESTING'], ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  ['blanket loan lender', BLANKET, NOT_LENDERS, false],
  ['portfolio lender', BLANKET, NOT_LENDERS, false],
  ['commercial mortgage broker', ['Portfolio Loans TESTING'], ['Commercial Appraiser TESTING', 'Mortgage Broker TESTING'], false],
  ['SBA lender', ['Portfolio Loans TESTING'], NOT_LENDERS, false],
  ['construction lender', ['Bridge Loan TESTING'], ['New Construction Contractor TESTING', 'General Contractor TESTING'], false],
  ['bridge lender', ['Bridge Loan TESTING'], NOT_LENDERS, false],
  ['home equity line of credit lender', ['Conventional Lending TESTING'], NOT_LENDERS, false],
  ['hard money lender', ['Hard Money Lender TESTING', 'Bridge Loan TESTING'], ['Mortgage Broker TESTING', ...NOT_LENDERS], false],
  // A product no partner offers falls back to the untagged general broker, marked closest fit.
  ['mortgage broker for ITIN loans', ['Mortgage Broker TESTING'], NOT_LENDERS, true],
  ['mortgage broker for foreign national loans', ['Mortgage Broker TESTING'], NOT_LENDERS, true],
  // A plain broker request with no product still finds brokers, tagged or not, not as closest fit.
  ['mortgage broker', ['Mortgage Broker TESTING', 'Conventional Lending TESTING', 'Dscr Loan TESTING', 'Rental Financing TESTING', 'Portfolio Loans TESTING'], NOT_LENDERS, false],
  ['loan servicing company', ['Loan Servicing Company TESTING'], ['Mortgage Broker TESTING'], false],
];

let failed = 0;
const RUNS = 20; // random tiebreaks: repeat so an unlucky order cannot hide a bug
for (const [service, oneOf, banned, closest] of cases) {
  let msg = '';
  try {
    for (let i = 0; i < RUNS; i++) {
      const r = await run(service);
      msg = r.names.join(' | ');
      assert.equal(r.status, 'ok', `status ${r.status}`);
      assert.ok(oneOf.includes(r.names[0]), `first match ${r.names[0]}`);
      for (const b of banned) assert.ok(!r.names.includes(b), `should not return ${b}`);
      assert.equal(r.closest[0], closest, `closest_fit ${r.closest[0]}`);
    }
    console.log('ok  ', service.padEnd(46), '->', msg);
  } catch (e) { failed++; console.log('FAIL', service, ':', e.message, '| got:', msg); }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
