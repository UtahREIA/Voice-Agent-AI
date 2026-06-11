// Map 2 Vendor Matching — queries vendor_routing_matrix from Supabase
// Accepts all diagnostic dimensions, returns matched vendor categories and specific vendors
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Extract tool arguments from all possible Vapi request formats
  // Vapi sends arguments nested inside toolCallList[0].function.arguments as a JSON string
  function extractArgs(body) {
    if (body && (body.blocker !== undefined || body.stage !== undefined || body.investor_need !== undefined)) {
      return body;
    }
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (args) return typeof args === 'string' ? JSON.parse(args) : args;
    } catch(e) {}
    return body || {};
  }

  const vapiArgs = extractArgs(req.body);
  const {
    blocker,
    strategy,
    investor_need,
    stage,
    already_tried,
    zip_code,
    city,
    state
  } = vapiArgs || {};

  console.log('Vendor args — blocker:', blocker, 'strategy:', strategy, 'need:', investor_need, 'stage:', stage);

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    // --- STEP 1: Map blocker/need to vendor_routing_matrix investor_need values ---
    // The matrix uses specific investor_need keys — map caller inputs to those keys
    const needMapping = {
      // Blocker mappings
      'capital':          'funding',
      'funding':          'funding',
      'money':            'funding',
      'lender':           'funding',
      'loan':             'funding',
      'deals':            'deals',
      'deal_flow':        'deals',
      'finding_deals':    'deals',
      'team':             'contractors',
      'contractors':      'contractors',
      'contractor':       'contractors',
      'legal':            'legal',
      'attorney':         'legal',
      'education':        'education',
      'management':       'property_management',
      'property_management': 'property_management',
      'connections':      'team_building',
      'build_network':    'team_building',
      'calculators':      'calculators',
      'tools':            'calculators',
      'deal_tools':       'calculators',
      'market_data':      'market_data',
      'comps':            'market_data',
      'data':             'market_data',
      'networking':       'networking',
      'partners':         'networking',
      'joint_venture':    'networking',
      'accountability':   'accountability',
      'coaching':         'accountability',
      'mentor':           'accountability',
      'guidance':         'accountability',
      'accounting':       'accounting',
      'tax':              'accounting',
      'tax_optimization': 'accounting',
      'insurance':            'insurance',
      'title':                'title',
      'escrow':               'title',
      'closing':              'title',
      'title_escrow':         'title',
      'appraisal':            'appraisal',
      'inspection':           'inspection',
      'inspector':            'inspection',
      'meth_testing':         'inspection',
      'home_inspection':      'inspection',
      'development_land':     'development_land',
      'land':                 'development_land',
      'entitlement':          'development_land',
      'zoning':               'development_land',
      'syndication':          'capital_raising',
      'raising_capital':      'capital_raising',
      'capital_raising':      'capital_raising',
      'private_money':        'funding',
      'hard_money':           'funding',
      'dscr':                 'funding',
      'mortgage':             'funding',
      'construction':         'contractors',
      'rehab':                'contractors',
      'renovation':           'contractors',
      'remodel':              'contractors',
      'electrician':          'electrical',
      'plumber':              'plumbing',
      'plumbing':             'plumbing',
      'hvac':                 'hvac',
      'roofing':              'roofing',
      'flooring':             'flooring',
      'drywall':              'drywall',
      'painting':             'painting',
      'framing':              'framing',
      'concrete':             'concrete',
      'foundation':           'foundation',
      'landscaping':          'landscaping',
      'demolition':           'demolition',
      'restoration':          'restoration',
      'direct_mail':          'deals',
      'skip_tracing':         'market_data',
      'lists':                'market_data',
      'va':                   'team',
      'virtual_assistant':    'team',
      'marketing':            'team',
      'cpa':                  'accounting',
      'bookkeeper':           'accounting',
      'asset_protection':     'legal',
      'entity_formation':     'legal',
      'llc':                  'legal',
      '1031':                 'legal',
      'tax_strategy':         'accounting',
      'property_manager':     'operations',
      'pm':                   'operations',
      'coach':                'accountability',
      'guidance':             'accountability',
      'partners':             'networking',
      'joint_venture':        'networking',
    };

    // Fix title_escrow → title (actual matrix key)
    const needKeyFix = { 'title_escrow': 'title', 'team_building': 'team', 'property_management': 'operations' };

    // --- STRATEGY NORMALIZATION ---
    const strategyMapping = {
      'fix_and_flip':       'fix_and_flip',
      'fix__flip':          'fix_and_flip',
      'flipping':           'fix_and_flip',
      'flip':               'fix_and_flip',
      'buy_and_hold':       'buy_and_hold',
      'buy__hold':          'buy_and_hold',
      'buy__hold__rentals': 'buy_and_hold',
      'rentals':            'buy_and_hold',
      'rental':             'buy_and_hold',
      'brrrr':              'brrrr',
      'wholesale':          'wholesale',
      'wholesaling':        'wholesale',
      'short_term_rental':  'short_term_rental',
      'str':                'short_term_rental',
      'airbnb':             'short_term_rental',
      'vrbo':               'short_term_rental',
      'creative_financing': 'creative_financing',
      'creative_finance':   'creative_financing',
      'subject_to':         'creative_financing',
      'seller_finance':     'creative_financing',
      'development':        'development',
      'new_construction':   'development',
      'land_development':   'development',
      'notes_lending':      'notes_lending',
      'notes_and_lending':  'notes_lending',
      'note_investing':     'notes_lending',
      'lending':            'notes_lending',
      'raising_capital':    'raising_capital',
      'capital_raising':    'raising_capital',
      'private_money':      'raising_capital',
      'syndication':        'syndication',
      'commercial':         'commercial',
      'multi_family':       'multi_family',
      'multifamily':        'multi_family',
      'house_hacking':      'house_hacking',
      'out_of_state':       'out_of_state',
      'remote_investing':   'out_of_state',
      'passive_investing':  'passive_investing',
      'tax_deeds':          'tax_deeds_liens',
      'tax_deeds_liens':    'tax_deeds_liens',
      'farm_land':          'farm_land',
      'land_entitlement':   'land_entitlement',
      'assisted_living':    'assisted_living',
      'self_storage':       'self_storage',
      'mobile_home':        'mobile_home',
      'hotel':              'hotel',
      'retail':             'retail',
      'industrial':         'industrial',
      'rv_parks':           'rv_parks',
      'mid_term_coliving':  'mid_term_coliving',
      'tax_optimization':   'tax_optimization',
    };

    const rawNeed = (investor_need || blocker || '').toLowerCase().replace(/ /g, '_');
    const mappedNeed = needMapping[rawNeed] || rawNeed;
    const needKey = needKeyFix[mappedNeed] || mappedNeed;

    const rawStrategy = (strategy || '').toLowerCase().replace(/ /g, '_');
    const strategyKey = strategyMapping[rawStrategy] || rawStrategy;

    console.log('Vendor routing — raw need:', rawNeed, '→ mapped need:', needKey, '| strategy:', strategyKey);

    // --- STEP 2: Query vendor_routing_matrix ---
    // Try stage + need + strategy first, then need + strategy, then need only
    let matrixRows = [];

    // Try exact need + strategy match first
    if (needKey && strategyKey) {
      const exactResp = await fetch(
        `${SUPABASE_URL}/rest/v1/vendor_routing_matrix?investor_need=eq.${encodeURIComponent(needKey)}&strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&select=investor_need,vendor_categories,vendor_subtypes,connection_methods&order=priority.asc&limit=3`,
        { headers: baseHeaders }
      );
      matrixRows = await exactResp.json();
    }

    // Fall back to need only if no strategy match
    if (!Array.isArray(matrixRows) || matrixRows.length === 0) {
      if (needKey) {
        const needResp = await fetch(
          `${SUPABASE_URL}/rest/v1/vendor_routing_matrix?investor_need=eq.${encodeURIComponent(needKey)}&strategy=is.null&is_active=eq.true&select=investor_need,vendor_categories,vendor_subtypes,connection_methods&order=priority.asc&limit=3`,
          { headers: baseHeaders }
        );
        matrixRows = await needResp.json();
      }
    }

    // Fall back to strategy only if still no match
    if (!Array.isArray(matrixRows) || matrixRows.length === 0) {
      if (strategyKey) {
        const stratResp = await fetch(
          `${SUPABASE_URL}/rest/v1/vendor_routing_matrix?strategy=eq.${encodeURIComponent(strategyKey)}&is_active=eq.true&select=investor_need,vendor_categories,vendor_subtypes,connection_methods&order=priority.asc&limit=3`,
          { headers: baseHeaders }
        );
        matrixRows = await stratResp.json();
      }
    }

    if (!Array.isArray(matrixRows)) matrixRows = [];

    // Extract vendor categories and subtypes from matrix rows
    const searchTerms = new Set();
    const searchSubtypes = new Set();
    matrixRows.forEach(row => {
      row.vendor_categories?.forEach(c => searchTerms.add(c.toLowerCase()));
      row.vendor_subtypes?.forEach(s => searchSubtypes.add(s.toLowerCase()));
    });

    // Default search terms if nothing matched in matrix
    if (searchTerms.size === 0) {
      if (needKey.includes('fund') || rawNeed === 'capital') searchTerms.add('money_lender_private__hard_money');
      else if (needKey.includes('contract')) searchTerms.add('contractor');
      else if (needKey.includes('deal')) searchTerms.add('real_estate_agent');
      else if (needKey.includes('legal')) searchTerms.add('attorney');
      else if (needKey.includes('manag')) searchTerms.add('property_manager');
      else searchTerms.add('real_estate_agent');
    }

    // Step 2 — query ghl_vendor_resources (synced from GHL custom objects)
    // This replaces vendor_profiles as the source of truth for vendor data
    // ghl_vendor_resources contains company_name, phone, description, and partner categories
    const vendorResp = await fetch(
      `${SUPABASE_URL}/rest/v1/ghl_vendor_resources?select=company_name,company_phone,business_description,funding_financial,deals_opportunities,team_vendors,attorney_subclass,operations,development_land,education_tech_tools,other_vendor_services,investor_types,enroll_vendor_match,service_areas,service_zip_codes,service_counties,serves_statewide,serves_national,service_radius_miles,primary_zip_code&is_active=eq.true&limit=50`,
      { headers: baseHeaders }
    );
    const vendors = await vendorResp.json();

    const alreadyTriedList = already_tried
      ? already_tried.toLowerCase().split(',').map(s => s.trim())
      : [];

    const terms = Array.from(searchTerms).map(t => t.toLowerCase());

    // --- LOAD CONFIG ---
    // Fetch configurable radius and other settings from vendor_match_config
    let radiusMiles = 100; // default
    let maxVendors = 3;
    let requireEnrolled = false;
    try {
      const configResp = await fetch(
        `${SUPABASE_URL}/rest/v1/vendor_match_config?select=config_key,config_value`,
        { headers: baseHeaders }
      );
      const configs = await configResp.json();
      if (Array.isArray(configs)) {
        configs.forEach(c => {
          if (c.config_key === 'radius_miles') radiusMiles = parseInt(c.config_value) || 100;
          if (c.config_key === 'max_vendors_returned') maxVendors = parseInt(c.config_value) || 3;
          if (c.config_key === 'require_enrolled') requireEnrolled = c.config_value === 'true';
        });
      }
    } catch(e) {
      console.error('Config fetch error:', e.message);
    }

    // --- HAVERSINE DISTANCE CALCULATION ---
    // Returns distance in miles between two lat/lng points
    function haversineDistance(lat1, lon1, lat2, lon2) {
      const R = 3958.8; // Earth radius in miles
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // --- CALLER LOCATION LOOKUP ---
    // Look up caller lat/lng from zip code in zip_code_locations table
    const callerZip = (zip_code || '').replace(/[^0-9]/g, '').slice(0, 5);
    const callerCity = (city || '').toLowerCase();
    const callerState = (state || 'UT').toUpperCase();
    let callerLat = null;
    let callerLon = null;

    if (callerZip) {
      try {
        const zipResp = await fetch(
          `${SUPABASE_URL}/rest/v1/zip_code_locations?zip_code=eq.${callerZip}&select=latitude,longitude,city,county&limit=1`,
          { headers: baseHeaders }
        );
        const zipData = await zipResp.json();
        if (Array.isArray(zipData) && zipData.length > 0) {
          callerLat = zipData[0].latitude;
          callerLon = zipData[0].longitude;
          console.log('Caller location resolved:', callerZip, '→', callerLat, callerLon);
        }
      } catch(e) {
        console.error('Zip lookup error:', e.message);
      }
    }

    // Match vendors against matrix categories, subtypes, and geographic radius
    const scoredVendors = Array.isArray(vendors) ? vendors
      .map(v => {
        const vendorName = (v.company_name || '').toLowerCase();
        if (alreadyTriedList.some(tried => vendorName.includes(tried))) return null;
        if (requireEnrolled && !v.enroll_vendor_match) return null;

        // --- GEOGRAPHIC FILTER using Haversine distance ---
        let geoScore = 0;
        let distanceMiles = null;

        if (v.serves_national) {
          geoScore = 5; // national vendor — always included
        } else if (v.serves_statewide && callerState === 'UT') {
          geoScore = 4; // statewide Utah vendor — always included
        } else if (callerLat && callerLon && v.latitude && v.longitude) {
          // Calculate exact distance using Haversine formula
          distanceMiles = haversineDistance(callerLat, callerLon, v.latitude, v.longitude);
          if (distanceMiles <= radiusMiles) {
            // Score inversely proportional to distance — closer = higher score
            geoScore = Math.max(1, Math.round(10 - (distanceMiles / radiusMiles) * 9));
          } else {
            return null; // outside radius — exclude
          }
        } else if (callerZip && v.service_zip_codes?.includes(callerZip)) {
          geoScore = 10; // exact zip match
        } else if (callerCity && v.service_areas?.some(a => a.toLowerCase().includes(callerCity))) {
          geoScore = 7; // city match
        } else if (!callerZip && !callerLat) {
          geoScore = 3; // no location provided — include with low geo score
        } else if (v.service_areas?.some(a =>
          a.toLowerCase().includes('salt lake') ||
          a.toLowerCase().includes('utah county') ||
          a.toLowerCase().includes('wasatch')
        )) {
          geoScore = 2; // Wasatch Front default
        }

        if (geoScore === 0) return null;

        const allServices = [
          ...(v.funding_financial || []),
          ...(v.deals_opportunities || []),
          ...(v.team_vendors || []),
          ...(v.attorney_subclass || []),
          ...(v.operations || []),
          ...(v.development_land || []),
          ...(v.education_tech_tools || []),
          ...(v.other_vendor_services ? [v.other_vendor_services] : []),
          ...(v.investor_types || []),
        ].map(s => s.toLowerCase().replace(/ /g, '_'));

        let score = geoScore; // start with geographic relevance
        // Higher score for subtype match (more precise)
        if (Array.from(searchSubtypes).some(st => allServices.some(s => s.includes(st)))) score += 10;
        // Lower score for category match (broader)
        if (terms.some(t => allServices.some(s => s.includes(t)))) score += 5;
        // Bonus for enrolled vendors
        if (v.enroll_vendor_match) score += 3;

        return score > 0 ? { ...v, score, distanceMiles } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxVendors) : [];

    const matched = scoredVendors;

    // Build natural spoken response
    if (matched.length === 0) {
      return res.status(200).json({
        result: 'We have vendors in our community for that need. Our team will follow up with specific recommendations based on your situation.'
      });
    }

    const names = matched.map(v => {
      const desc = v.business_description
        ? v.business_description.split('.')[0]
        : '';
      const dist = v.distanceMiles ? ` (${Math.round(v.distanceMiles)} miles away)` : '';
      return desc ? v.company_name + ' — ' + desc + dist : v.company_name + dist;
    }).join('; ');

    const subtypes = matrixRows.flatMap(r => r.vendor_subtypes || []).slice(0, 2).join(' and ');
    const context = subtypes ? ' who specialize in ' + subtypes : '';

    const result = 'Here are the best matches in our community' + context + ': ' + names + '. I can also connect you with one of them directly after this call.';

    console.log('Vendor match — ' + matched.length + ' vendors found from ghl_vendor_resources, categories: ' + Array.from(searchTerms).join(', '));
    return res.status(200).json({ result });

  } catch(e) {
    console.error('Vendor match error:', e.message);
    return res.status(200).json({
      result: 'We have vendors in our community for that need. Our team will follow up with specific recommendations based on your situation.'
    });
  }
}