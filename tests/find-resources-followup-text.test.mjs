// Follow-up text test for api/find-resources.js (2026-11-23).
// Run: node tests/find-resources-followup-text.test.mjs   (no network; Supabase is mocked)
// Replays the find_resources calls from Chris's three 2026-11-23 test calls and
// checks that the matched partners (name + phone) reach the follow-up text that
// ghl-sync appends to the SMS. Before this fix only items with a URL did, so no
// lender ever reached the caller.
import assert from 'assert';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const V = (id, name, fin, lp, phone, site = '') => ({
  ghl_record_id: id, company_name: name, funding_financial: fin, loan_product: lp,
  company_phone: phone, company_website: site,
  deals_opportunities: [], team_vendors: [], attorney_subclass: [], operations: [],
  development_land: [], education_tech_tools: [], contractor_speciality: '', other_vendor_services: ''
});
const H = 'money_lender_private__hard_money', M = 'mortgage_broker';
const vendors = [
  V('bridge', 'Bridge Loan TESTING', [H], ['fha', 'va'], '+18015550108'),
  V('rental', 'Rental Financing TESTING', [M], ['bank_statement', 'dscr'], '+18015550168'),
  V('port', 'Portfolio Loans TESTING', [M], ['commercial_mortgage', 'construction', 'conventional', 'dscr'], '+18015550159'),
  V('mb', 'Mortgage Broker TESTING', [M], null, '+18015550111'),
  V('hm', 'Hard Money Lender TESTING', [H], null, '+18015550122', 'https://example.com/hm'),
];
const educators = [
  { ghl_record_id: 'e1', educators_name: 'ChrisB Testing', educational_topics: ['house_hacking'], educational_level: ['exploring__new', 'getting_started', 'active_investor'], is_active: true, educators_url: 'https://example.com/educators/chrisb-testing' },
];

let posted = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'POST' && u.includes('voice_agent_stack_links')) { posted = JSON.parse(opts.body); return { ok: true, status: 201, json: async () => ({}) }; }
  const body = u.includes('ghl_vendor_resources') ? vendors : u.includes('ghl_educators_mentors') ? educators : [];
  return { ok: true, status: 200, json: async () => body };
};
const { default: handler, buildSmsLinks, prettyPhone } = await import('../api/find-resources.js');

async function call(needs) {
  posted = null;
  let out;
  const res = { setHeader() {}, status() { return this; }, json(o) { out = o; return this; }, end() { return this; } };
  await handler({ method: 'POST', body: { message: { call: { id: 'test-call' }, toolCallList: [{ function: { arguments: JSON.stringify({ needs }) } }] } } }, res);
  return { lani: JSON.stringify(out), posted };
}

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); } };

check('phone formatting', () => {
  assert.strictEqual(prettyPhone('+18015550168'), '(801) 555-0168');
  assert.strictEqual(prettyPhone('8015550168'), '(801) 555-0168');
  assert.strictEqual(prettyPhone(''), '');
});
check('entries with neither phone nor link are left out', () => {
  assert.strictEqual(buildSmsLinks([{ type: 'vendor', name: 'X' }, { type: 'tool', status: 'no_match', name: '' }]), '');
});

// Call 3: self-employed rental (DSCR)
{
  const { lani, posted: p } = await call([{ type: 'vendor', service: 'mortgage broker for DSCR loans' }]);
  check('DSCR call: both lenders in the follow-up text with phones', () => {
    assert.ok(p, 'stack links were not written');
    assert.match(p.sms_links, /Rental Financing TESTING: \(801\) 555-0168/);
    assert.match(p.sms_links, /Portfolio Loans TESTING: \(801\) 555-0159/);
  });
  check('DSCR call: phone and service stored per partner for the referral log', () => {
    const r = p.links.find(l => l.id === 'rental');
    assert.strictEqual(r.phone, '+18015550168');
    assert.strictEqual(r.service, 'mortgage broker for DSCR loans');
  });
  check('DSCR call: Lani never receives phone numbers or links', () => {
    assert.ok(!/555-0168|\+1801|_phone|_url/.test(lani), lani.slice(0, 200));
  });
}

// Call 1: fourplex, FHA, plus a house hacking mentor and a tool with no match
{
  const { posted: p } = await call([
    { type: 'educator', topic: 'house hacking', level: 'new' },
    { type: 'vendor', service: 'mortgage broker for FHA loans' },
    { type: 'tool', topic: 'house hacking', level: 'new' },
  ]);
  check('FHA call: lender and mentor both in the text', () => {
    assert.match(p.sms_links, /Bridge Loan TESTING: \(801\) 555-0108/);
    assert.match(p.sms_links, /ChrisB Testing: https:\/\/example\.com\/educators\/chrisb-testing/);
    assert.ok(p.sms_links.startsWith('Your contacts and links:'));
  });
}

// A partner with a website gets phone and website on one line
{
  const { posted: p } = await call([{ type: 'vendor', service: 'hard money lender' }]);
  check('website is added after the phone when the partner has one', () => {
    assert.match(p.sms_links, /Hard Money Lender TESTING: \(801\) 555-0122, https:\/\/example\.com\/hm/);
  });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
