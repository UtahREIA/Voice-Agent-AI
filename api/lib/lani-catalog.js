/**
 * lani-catalog.js - builds Part B (the CATALOG section) of the Lani V2 system
 * prompt from the Supabase mirror tables.
 *
 * buildCatalog(data) is pure: same rows in, same text out. loadCatalogData()
 * does the reads. Nothing here writes anywhere.
 *
 * Rules carried from the spec:
 *   - Vendors use the same gate as api/resources.js: is_active,
 *     enroll_vendor_match and approval_status = 'Approved'.
 *   - Topic, level and commercial-asset values are GHL keys. PLAIN_WORDS maps
 *     them; an unmapped value passes through unchanged and is reported in
 *     counts.unmapped. A record is never dropped for an unmapped value.
 *   - Records named TESTING are intentional fixtures and are included as is.
 *   - No URL column is read, and any URL that shows up inside text is removed.
 *   - Every em dash in source text becomes " - ".
 */

// GHL key -> plain words. Add rows here as new GHL values appear; the build's
// counts.unmapped lists anything this table does not cover yet.
export const PLAIN_WORDS = {
  // educational_topics
  brrrr: 'BRRRR',
  buy__hold__rentals: 'buy and hold rentals',
  commercial: 'commercial',
  creative_financing: 'creative financing',
  development: 'development',
  fix__flip: 'fix and flip',
  house_hacking: 'house hacking',
  land__entitlement: 'land and entitlement',
  midterm__coliving_rentals: 'mid-term and co-living rentals',
  notes__lending: 'notes and lending',
  passive_investments: 'passive investments',
  raising_capital: 'raising capital',
  short_term_rental: 'short-term rentals',
  syndication__funds: 'syndications and funds',
  syndications__funds: 'syndications and funds',
  tax_deeds_and_liens: 'tax deeds and liens',
  wholesaling: 'wholesaling',
  // educational_level
  exploring__new: 'new and exploring',
  getting_started: 'getting started',
  active_investor: 'active investor',
  experienced_investor: 'experienced investor',
  veteran__operator: 'veteran operator',
  // commercial_asset_types
  assisted_living: 'assisted living',
  farm_land: 'farm land',
  hotel: 'hotel',
  industrial: 'industrial',
  mobile_home: 'mobile home parks',
  multi_family: 'multifamily',
  retail: 'retail',
  rv_parks: 'RV parks',
  self_storage: 'self storage'
};

// Same order as the spec: every matchable vendor category column, then the
// contractor specialty text column (its name really is spelled "speciality").
export const VENDOR_CATEGORY_COLUMNS = [
  'funding_financial', 'loan_product', 'deals_opportunities', 'team_vendors',
  'attorney_subclass', 'operations', 'development_land', 'education_tech_tools',
  'other_contractor'
];
export const VENDOR_SPECIALTY_COLUMN = 'contractor_speciality';

export const CATALOG_INTRO = 'This is everything you may recommend. Use exact names. Service labels after each vendor are internal. Describe the service in plain words when you speak.';
// Section headers, guidance included. Exact text; the prompt relies on it.
export const HEADERS = {
  reia: 'UTAH REIA RESOURCES (free, these lead)',
  free: 'FREE CALCULATORS',
  paid: 'PAID TOOLS AND FORMS (offer after free options, and say they are paid)',
  classes: 'CLASSES (name | topics | levels | access)',
  educators: 'EDUCATORS AND MENTORS (name | topics | levels they serve)',
  vendors: 'VENDORS (name | service)'
};
export const NO_TOPIC = 'no topic set';
export const NO_LEVEL = 'no level set';

export const NO_EVENTS_LINE = 'Upcoming events: none are loaded right now. If a caller wants an event, tell them their first event is free and that the team will follow up with the next date.';

const EM_DASH_RE = new RegExp('\\s*' + String.fromCharCode(0x2014) + '\\s*', 'g');
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** Clean one piece of source text: no em dashes, no URLs, single spaces. */
export function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(EM_DASH_RE, ' - ')
    .replace(URL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const byText = (key) => (a, b) => cleanText(a[key]).localeCompare(cleanText(b[key]));
const asArray = (v) => Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]);

/**
 * @param {object} data  { reia, events, tools, courses, educators, vendors } row arrays
 * @returns {{ text: string, names: string[], counts: object }}
 */
export function buildCatalog(data) {
  const unmapped = new Set();
  const plain = (v) => {
    const key = String(v).trim();
    if (!key) return '';
    if (Object.prototype.hasOwnProperty.call(PLAIN_WORDS, key)) return PLAIN_WORDS[key];
    unmapped.add(key);
    return cleanText(key);
  };
  const names = [];
  const missingTopic = [];
  const lines = ['CATALOG', CATALOG_INTRO, ''];

  // Tools and classes keep fixed field positions, so an empty topic or level
  // list renders a placeholder instead of dropping the field. A missing topic
  // is also counted (counts.missing_topic); the record is never dropped.
  const topicsField = (row, title) => {
    const t = asArray(row.educational_topics).map(plain).filter(Boolean);
    if (t.length) return t.join(', ');
    missingTopic.push(title);
    return NO_TOPIC;
  };
  const levelsField = (row) => {
    const l = asArray(row.educational_level).map(plain).filter(Boolean);
    return l.length ? l.join(', ') : NO_LEVEL;
  };

  // UTAH REIA RESOURCES, then upcoming events
  const reia = [...(data.reia || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || byText('title')(a, b));
  lines.push(HEADERS.reia);
  for (const r of reia) {
    const title = cleanText(r.title);
    names.push(title);
    lines.push(`${title}: ${cleanText(r.voice_description)}`);
  }
  const events = [...(data.events || [])].sort((a, b) =>
    String(a.event_date).localeCompare(String(b.event_date)) || byText('event_title')(a, b));
  if (events.length === 0) {
    lines.push(NO_EVENTS_LINE);
  } else {
    lines.push('Upcoming events:');
    for (const e of events) {
      const title = cleanText(e.event_title);
      names.push(title);
      const when = [cleanText(e.event_date), cleanText(e.event_time)].filter(Boolean).join(' ');
      const parts = [title, when, cleanText(e.event_location)].filter(Boolean);
      lines.push(parts.join(' | '));
    }
  }
  lines.push('');

  // FREE CALCULATORS / PAID TOOLS AND FORMS
  const tools = [...(data.tools || [])].sort(byText('resource_title'));
  const toolLine = (t) => {
    const title = cleanText(t.resource_title);
    names.push(title);
    // Raw check: cleanText strips URLs, so it would make every link look empty.
    const membersOnly = t.membership_required === true && !String(t.resource_url_nonmember || '').trim();
    const fields = [title, topicsField(t, title), levelsField(t)];
    if (membersOnly) fields.push('members only');
    return fields.join(' | ');
  };
  const freeTools = tools.filter(t => t.paid_resource !== true);
  const paidTools = tools.filter(t => t.paid_resource === true);
  lines.push(HEADERS.free);
  for (const t of freeTools) lines.push(toolLine(t));
  lines.push('');
  lines.push(HEADERS.paid);
  for (const t of paidTools) lines.push(toolLine(t));
  lines.push('');

  // CLASSES
  const courses = [...(data.courses || [])].sort(byText('course_name'));
  lines.push(HEADERS.classes);
  for (const c of courses) {
    const title = cleanText(c.course_name);
    names.push(title);
    const access = c.paid_education === true ? 'Paid'
      : c.membership_required === true ? 'Free for members'
      : 'Free';
    lines.push([title, topicsField(c, title), levelsField(c), access].join(' | '));
  }
  lines.push('');

  // EDUCATORS AND MENTORS: name | topics | levels
  const educators = [...(data.educators || [])].sort(byText('educators_name'));
  lines.push(HEADERS.educators);
  for (const e of educators) {
    const name = cleanText(e.educators_name);
    names.push(name);
    const assets = asArray(e.commercial_asset_types).map(plain).filter(Boolean);
    // With an asset type, "commercial: <asset>" replaces the bare commercial
    // topic so it is said once, not "commercial, commercial: <asset>".
    const topicKeys = asArray(e.educational_topics)
      .filter(k => !(assets.length && String(k).trim() === 'commercial'));
    const topics = topicKeys.map(plain).filter(Boolean);
    for (const a of assets) topics.push(`commercial: ${a}`);
    const levels = asArray(e.educational_level).map(plain).filter(Boolean);
    // An educator with no level in the data shows no levels: no trailing
    // empty segment, and nothing invented.
    lines.push([name, topics.join(', '), levels.join(', ')].filter(Boolean).join(' | '));
  }
  lines.push('');

  // VENDORS: company_name | all category values (internal labels, not mapped)
  const vendors = [...(data.vendors || [])].sort(byText('company_name'));
  lines.push(HEADERS.vendors);
  for (const v of vendors) {
    const name = cleanText(v.company_name);
    names.push(name);
    const seen = new Set();
    const labels = [];
    const add = (x) => { const c = cleanText(x); if (c && !seen.has(c)) { seen.add(c); labels.push(c); } };
    for (const col of VENDOR_CATEGORY_COLUMNS) for (const x of asArray(v[col])) add(x);
    for (const x of String(v[VENDOR_SPECIALTY_COLUMN] || '').split(',')) add(x);
    lines.push(labels.length ? `${name} | ${labels.join(', ')}` : name);
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    text,
    names,
    counts: {
      reia_resources: reia.length,
      events: events.length,
      free_tools: freeTools.length,
      paid_tools: paidTools.length,
      courses: courses.length,
      educators: educators.length,
      vendors: vendors.length,
      unmapped: [...unmapped].sort(),
      missing_topic: missingTopic.length,
      missing_topic_records: [...missingTopic].sort()
    }
  };
}

/**
 * Read every source table. Only the columns the catalog uses; no URL columns
 * except resource_url_nonmember, which is read for the members-only test and
 * never written into the text.
 */
export async function loadCatalogData(supabaseUrl, supabaseKey, fetchImpl = fetch, today = new Date().toISOString().slice(0, 10)) {
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const get = async (path) => {
    const r = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, { headers });
    if (!r.ok) throw new Error(`catalog read failed: ${path.split('?')[0]} http ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(`catalog read failed: ${path.split('?')[0]} returned non-array`);
    return rows;
  };
  const vendorCols = ['company_name', ...VENDOR_CATEGORY_COLUMNS, VENDOR_SPECIALTY_COLUMN].join(',');
  // Column names checked against information_schema: educational_topics and
  // educational_level exist on both ghl_tools_resources and ghl_educational_courses.
  const [reia, events, tools, courses, educators, vendors] = await Promise.all([
    get('reia_resources?is_active=eq.true&select=title,voice_description,priority&order=priority.asc'),
    get(`ghl_upcoming_events?is_active=eq.true&event_date=gte.${today}&select=event_title,event_date,event_time,event_location&order=event_date.asc`),
    get('ghl_tools_resources?is_active=eq.true&select=resource_title,educational_topics,educational_level,paid_resource,membership_required,resource_url_nonmember'),
    get('ghl_educational_courses?is_active=eq.true&select=course_name,educational_topics,educational_level,paid_education,membership_required'),
    get('ghl_educators_mentors?is_active=eq.true&select=educators_name,educational_topics,educational_level,commercial_asset_types'),
    get(`ghl_vendor_resources?is_active=eq.true&enroll_vendor_match=eq.true&approval_status=eq.Approved&select=${vendorCols}`)
  ]);
  return { reia, events, tools, courses, educators, vendors };
}
