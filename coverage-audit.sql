-- coverage-audit.sql — Utah REIA Voice Agent
--
-- Periodic coverage report: for every caller-facing strategy, does each resource
-- category actually have something to return? Catches SILENT holes — a strategy
-- that matches nothing in a category returns an empty bucket, not an error, so
-- these only surface when an affected caller calls. Run this the way the
-- content-audit pattern is run (via the Supabase MCP or SQL editor).
--
-- IMPORTANT: the three map CTEs below (matrix_map, topic_map) must stay in sync
-- with the vocabulary maps in api/resources.js (SHORT_STAGE, TOPICS_BY_STRATEGY,
-- MATRIX_STRATEGY). If a strategy or spelling is added there, add it here too, or
-- this audit will report a false gap. The four-vocabulary problem is documented
-- in CLAUDE.md.
--
-- How to read the output (one row per strategy, booleans):
--   edu_track  — an education_routing_matrix track resolves (via matrix aliases)
--   educator   — a ghl_educators_mentors record matches by topic
--   course     — a ghl_educational_courses record matches by topic
--   vendor     — a vendor_routing_matrix row resolves (via matrix aliases)
--   tool       — a tools_routing_matrix row resolves (via matrix aliases)
--
-- A false is not automatically a bug: not_sure and mentoring_others are
-- education-only by design. A false IS a gap when intake routes that strategy to
-- the missing category — e.g. tax_optimization is routed to the vendor tier but
-- has no vendor row (see the confirmation query at the bottom).

with strat(s) as (values
  ('assisted_living'),('brrrr'),('buy_and_hold'),('commercial'),('creative_financing'),
  ('development'),('farm_land'),('fix_and_flip'),('hotel'),('house_hacking'),('industrial'),
  ('land_entitlement'),('mentoring_others'),('mid_term_coliving'),('mobile_home'),('multi_family'),
  ('not_sure'),('notes_lending'),('out_of_state'),('passive_investing'),('raising_capital'),
  ('retail'),('rv_parks'),('self_storage'),('short_term_rental'),('syndication'),
  ('tax_deeds_liens'),('tax_optimization'),('wholesale')
),
-- strategy -> acceptable routing-matrix values (self + MATRIX_STRATEGY alts)
matrix_map(s, mv) as (values
  ('assisted_living','assisted_living'),('assisted_living','commercial'),
  ('brrrr','brrrr'),('buy_and_hold','buy_and_hold'),('commercial','commercial'),
  ('creative_financing','creative_financing'),('development','development'),
  ('farm_land','farm_land'),('farm_land','commercial'),
  ('fix_and_flip','fix_and_flip'),('hotel','hotel'),('hotel','commercial'),
  ('house_hacking','house_hacking'),('house_hacking','buy_and_hold'),
  ('industrial','industrial'),('industrial','commercial'),
  ('land_entitlement','land_entitlement'),('land_entitlement','development'),
  ('mentoring_others','mentoring_others'),
  ('mid_term_coliving','mid_term_coliving'),('mid_term_coliving','short_term_rental'),
  ('mobile_home','mobile_home'),('mobile_home','commercial'),
  ('multi_family','multi_family'),('multi_family','commercial'),
  ('not_sure','not_sure'),('not_sure','not_sure_yet'),
  ('notes_lending','notes_lending'),('notes_lending','notes_and_lending'),
  ('out_of_state','out_of_state'),
  ('passive_investing','passive_investing'),('passive_investing','buy_and_hold'),
  ('raising_capital','raising_capital'),('retail','retail'),('retail','commercial'),
  ('rv_parks','rv_parks'),('rv_parks','commercial'),
  ('self_storage','self_storage'),('self_storage','commercial'),
  ('short_term_rental','short_term_rental'),
  ('syndication','syndication'),('syndication','raising_capital'),
  ('tax_deeds_liens','tax_deeds_liens'),('tax_deeds_liens','tax_deeds'),
  ('tax_optimization','tax_optimization'),
  ('wholesale','wholesale'),('wholesale','wholesaling')
),
-- strategy -> topic values on the ghl_* record tables (TOPICS_BY_STRATEGY)
topic_map(s, t) as (values
  ('fix_and_flip','fix__flip'),('buy_and_hold','buy__hold__rentals'),('wholesale','wholesaling'),
  ('brrrr','brrrr'),('creative_financing','creative_financing'),('raising_capital','raising_capital'),
  ('development','development'),('notes_lending','notes__lending'),('land_entitlement','land__entitlement'),
  ('short_term_rental','short_term_rental'),('mid_term_coliving','midterm__coliving_rentals'),
  ('tax_deeds_liens','tax_deeds_and_liens'),('house_hacking','house_hacking'),
  ('passive_investing','passive_investments'),
  ('syndication','syndications__funds'),('syndication','syndication__funds'),
  ('commercial','commercial'),('industrial','commercial'),('retail','commercial'),
  ('multi_family','commercial'),('self_storage','commercial'),('mobile_home','commercial'),
  ('hotel','commercial'),('assisted_living','commercial'),('farm_land','commercial'),('rv_parks','commercial')
),
edu_strats as (select distinct strategy v from education_routing_matrix where is_active and strategy is not null),
ven_strats as (select distinct strategy v from vendor_routing_matrix where is_active and strategy is not null),
tool_strats as (select distinct strategy v from tools_routing_matrix where is_active and strategy is not null),
edu_topics as (select distinct unnest(educational_topics) t from ghl_educators_mentors where is_active),
crs_topics as (select distinct unnest(educational_topics) t from ghl_educational_courses where is_active)
select
  st.s as strategy,
  (exists (select 1 from matrix_map m join edu_strats e on e.v=m.mv where m.s=st.s)) as edu_track,
  (exists (select 1 from topic_map tm join edu_topics e on e.t=tm.t where tm.s=st.s)) as educator,
  (exists (select 1 from topic_map tm join crs_topics c on c.t=tm.t where tm.s=st.s)) as course,
  (exists (select 1 from matrix_map m join ven_strats v on v.v=m.mv where m.s=st.s)) as vendor,
  (exists (select 1 from matrix_map m join tool_strats t on t.v=m.mv where m.s=st.s)) as tool
from strat st
order by st.s;

-- Confirmation query for the known tax_optimization gap: it routes to the vendor
-- tier but has no vendor strategy row, while 27 accounting vendors sit unbridged.
-- select
--   (select string_agg(rule_name || ' -> ' || routing_action || '/' || tier, '; ')
--      from intake_routing_rules where is_active and strategy='tax_optimization') as tax_opt_intake_rules,
--   (select count(*) from vendor_routing_matrix where is_active and strategy='tax_optimization') as tax_opt_vendor_rows,
--   (select count(*) from vendor_routing_matrix where is_active and investor_need='accounting') as accounting_vendor_rows;
