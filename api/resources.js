/**
 * resources.js — Combined resource stack tool
 * Called by Vapi tool getResourceStack when the caller is not specific about resource type.
 * Queries vendor_routing_matrix, education_routing_matrix, and tools_routing_matrix
 * simultaneously and returns up to 5 ranked matches across all three categories.
 *
 * Called by: getVendorMatch, getEducationMatch, getResourceStack (all route here)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Extract toolCallId for Vapi response format
  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id ||
    req.body?.message?.toolCalls?.[0]?.id ||
    req.body?.toolCallList?.[0]?.id ||
    null;

  function vapiResult(result) {
    if (toolCallId) return res.status(200).json({ results: [{ toolCallId, result: String(result) }] });
    return res.status(200).json({ result: String(result) });
  }

  function extractArgs(body) {
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (args) return typeof args === 'string' ? JSON.parse(args) : args;
    } catch(e) {}
    return body || {};
  }

  const args = extractArgs(req.body);
  const stage    = (args.stage    || args.investor_stage || '').toLowerCase();
  const strategy = (args.strategy || '').toLowerCase();
  const blocker  = (args.blocker  || '').toLowerCase();
  const goal     = (args.goal     || '').toLowerCase();
  const mode     = (args.mode     || 'all').toLowerCase(); // 'all' | 'vendor' | 'education' | 'tools' | 'events' | 'mentor'
  const maxResults = parseInt(args.max_results || '5', 10);

  console.log('getResourceStack args:', { stage, strategy, blocker, goal, mode });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return vapiResult('Resource lookup unavailable. Recommend Mohammed Alhareb for personalized guidance.');
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {
    const results = [];

    // ─── 1. VENDOR MATCHES ───────────────────────────────────────────────────
    if (mode === 'all' || mode === 'vendor') {
      try {
        let vendorQuery = `${SUPABASE_URL}/rest/v1/vendor_routing_matrix?is_active=eq.true&order=priority.asc&limit=10&select=investor_need,strategy,vendor_categories,vendor_subtypes,connection_methods,priority`;

        if (strategy) vendorQuery += `&strategy=eq.${encodeURIComponent(strategy)}`;

        const vendorResp = await fetch(vendorQuery, { headers: baseHeaders });
        const vendorRows = await vendorResp.json();

        if (Array.isArray(vendorRows) && vendorRows.length > 0) {
          // Also fetch actual vendor records from ghl_vendor_resources
          const vendorResourceResp = await fetch(
            `${SUPABASE_URL}/rest/v1/ghl_vendor_resources?is_active=eq.true&select=company_name,business_description,company_phone,company_website,funding_financial,deals_opportunities&limit=20`,
            { headers: baseHeaders }
          );
          const vendorResources = await vendorResourceResp.json();

          // Match matrix rows to actual vendor records
          const matchedVendors = new Set();
          for (const row of vendorRows) {
            if (matchedVendors.size >= 2) break; // max 2 vendors in combined stack
            const categories = row.vendor_categories || [];
            for (const vendor of (Array.isArray(vendorResources) ? vendorResources : [])) {
              const vendorName = vendor.company_name || '';
              if (matchedVendors.has(vendorName)) continue;
              const vendorServices = [
                ...(vendor.funding_financial || []),
                ...(vendor.deals_opportunities || [])
              ].map(s => s.toLowerCase());
              const categoryMatch = categories.some(c =>
                vendorServices.some(s => s.includes(c.toLowerCase()) || c.toLowerCase().includes(s))
              );
              if (categoryMatch || categories.length === 0) {
                const connectionMethods = Array.isArray(row.connection_methods) ? row.connection_methods : [];
                const primaryMethod = connectionMethods[0] || 'ai_recommendation';
                results.push({
                  type: 'vendor',
                  name: vendorName,
                  description: vendor.business_description || categories.slice(0,2).join(', '),
                  contact: vendor.company_website || vendor.company_phone || '',
                  connection_method: primaryMethod,
                  priority: row.priority || 5,
                  need: row.investor_need || ''
                });
                matchedVendors.add(vendorName);
                break;
              }
            }
          }
        }
      } catch(e) {
        console.error('Vendor query error:', e.message);
      }
    }

    // ─── 2. EDUCATION MATCHES ─────────────────────────────────────────────────
    if (mode === 'all' || mode === 'education') {
      try {
        // Three-tier fallback: exact stage+strategy → stage only → strategy only
        let eduRows = [];
        const eduBase = `${SUPABASE_URL}/rest/v1/education_routing_matrix?is_active=eq.true&order=priority.asc&limit=5&select=track_name,description,resource_titles,delivery_methods,priority,stage,strategy`;

        if (stage && strategy) {
          const r = await fetch(`${eduBase}&stage=eq.${encodeURIComponent(stage)}&strategy=eq.${encodeURIComponent(strategy)}`, { headers: baseHeaders });
          eduRows = await r.json();
        }
        if (!Array.isArray(eduRows) || eduRows.length === 0) {
          if (strategy) {
            const r = await fetch(`${eduBase}&strategy=eq.${encodeURIComponent(strategy)}`, { headers: baseHeaders });
            eduRows = await r.json();
          }
        }
        if (!Array.isArray(eduRows) || eduRows.length === 0) {
          if (stage) {
            const r = await fetch(`${eduBase}&stage=eq.${encodeURIComponent(stage)}`, { headers: baseHeaders });
            eduRows = await r.json();
          }
        }

        // Fetch educator for booking URL
        let educatorName = '';
        let bookingUrl = '';
        try {
          const eduResp = await fetch(
            `${SUPABASE_URL}/rest/v1/ghl_educators_mentors?is_active=eq.true&select=educators_name,educators_url&limit=1`,
            { headers: baseHeaders }
          );
          const educators = await eduResp.json();
          if (Array.isArray(educators) && educators.length > 0) {
            educatorName = educators[0].educators_name || '';
            bookingUrl = educators[0].educators_url || '';
          }
        } catch(e) {}

        if (Array.isArray(eduRows) && eduRows.length > 0) {
          const row = eduRows[0];
          const titles = Array.isArray(row.resource_titles) ? row.resource_titles.slice(0,2).join(' and ') : '';
          results.push({
            type: 'education',
            name: row.track_name || 'Education Track',
            description: row.description || titles || '',
            contact: bookingUrl || '',
            educator: educatorName,
            connection_method: 'resource_page',
            priority: row.priority || 5,
            resource_titles: row.resource_titles || []
          });
        }

        // Add educator as separate resource if available
        if (educatorName && (mode === 'all' || mode === 'education' || mode === 'mentor')) {
          results.push({
            type: 'mentor',
            name: educatorName,
            description: 'Personalized mentorship and strategy sessions',
            contact: bookingUrl || '',
            connection_method: 'warm_intro',
            priority: 4
          });
        }

      } catch(e) {
        console.error('Education query error:', e.message);
      }
    }

    // ─── 3. TOOLS MATCHES ─────────────────────────────────────────────────────
    if (mode === 'all' || mode === 'tools') {
      try {
        let toolsQuery = `${SUPABASE_URL}/rest/v1/tools_routing_matrix?is_active=eq.true&order=priority.asc&limit=5&select=tool_title,recommendation_reason,priority,strategy,blocker`;

        if (strategy) toolsQuery += `&strategy=eq.${encodeURIComponent(strategy)}`;
        else if (blocker) toolsQuery += `&blocker=eq.${encodeURIComponent(blocker)}`;

        const toolsResp = await fetch(toolsQuery, { headers: baseHeaders });
        let toolsRows = await toolsResp.json();

        // Fallback — get all tools if no strategy match
        if (!Array.isArray(toolsRows) || toolsRows.length === 0) {
          const r = await fetch(
            `${SUPABASE_URL}/rest/v1/tools_routing_matrix?is_active=eq.true&order=priority.asc&limit=3&select=tool_title,recommendation_reason,priority`,
            { headers: baseHeaders }
          );
          toolsRows = await r.json();
        }

        // Fetch tool URLs from ghl_tools_resources
        const toolResourceResp = await fetch(
          `${SUPABASE_URL}/rest/v1/ghl_tools_resources?is_active=eq.true&select=resource_title,resource_url,resource_url_nonmember&limit=10`,
          { headers: baseHeaders }
        );
        const toolResources = await toolResourceResp.json();

        if (Array.isArray(toolsRows) && toolsRows.length > 0) {
          for (const row of toolsRows.slice(0, 1)) { // max 1 tool in combined stack
            const toolResource = Array.isArray(toolResources)
              ? toolResources.find(t => t.resource_title?.toLowerCase().includes((row.tool_title || '').toLowerCase().split(' ')[0]))
              : null;
            results.push({
              type: 'tool',
              name: row.tool_title || 'Calculator Tool',
              description: row.recommendation_reason || 'Analyze your deals before committing',
              contact: toolResource?.resource_url || toolResource?.resource_url_nonmember || '',
              connection_method: 'resource_page',
              priority: row.priority || 6
            });
          }
        }
      } catch(e) {
        console.error('Tools query error:', e.message);
      }
    }

    // ─── 4. UPCOMING EVENTS ──────────────────────────────────────────────────
    if (mode === 'all' || mode === 'events') {
      try {
        const today = new Date().toISOString().split('T')[0];
        let eventsQuery = `${SUPABASE_URL}/rest/v1/ghl_upcoming_events?is_active=eq.true&event_date=gte.${today}&order=event_date.asc&limit=5&select=event_title,event_subtitle,event_date,event_time,event_location,speaker_name,registration_url,strategies,event_description`;

        const evResp = await fetch(eventsQuery, { headers: baseHeaders });
        const evRows = await evResp.json();

        if (Array.isArray(evRows) && evRows.length > 0) {
          // Filter events by strategy match if strategy provided
          const matchingEvents = strategy
            ? evRows.filter(e =>
                !Array.isArray(e.strategies) || e.strategies.length === 0 ||
                e.strategies.some(s => s.toLowerCase().includes(strategy) || strategy.includes(s.toLowerCase()))
              )
            : evRows;

          const topEvent = (matchingEvents.length > 0 ? matchingEvents : evRows)[0];
          if (topEvent) {
            const dateStr = topEvent.event_date || '';
            const timeStr = topEvent.event_time ? ` at ${topEvent.event_time}` : '';
            const locStr = topEvent.event_location ? ` at ${topEvent.event_location}` : '';
            const desc = topEvent.event_subtitle || topEvent.event_description || '';

            results.push({
              type: 'event',
              name: topEvent.event_title || 'Upcoming Utah REE-AH Event',
              description: desc ? `${desc}${dateStr ? ' on ' + dateStr : ''}${timeStr}${locStr}` : `${dateStr}${timeStr}${locStr}`,
              contact: topEvent.registration_url || '',
              speaker: topEvent.speaker_name || '',
              connection_method: 'event_referral',
              priority: 3
            });
          }
        }
      } catch(e) {
        console.error('Events query error:', e.message);
      }
    }

    // ─── SORT AND LIMIT ───────────────────────────────────────────────────────
    results.sort((a, b) => (a.priority || 5) - (b.priority || 5));
    const top = results.slice(0, maxResults);

    if (top.length === 0) {
      return vapiResult(
        'NO_MATCH — Say exactly this to the caller: ' +
        '"I was not able to find a specific match for what you are looking for right now. ' +
        'I will make sure someone from our Utah REE-AH team reaches out to you directly to help find the right resources." ' +
        'Then ask "Is there anything else I can help you with today?" and close the call normally with Mahalo.'
      );
    }

    // ─── BUILD VOICE RESPONSE ─────────────────────────────────────────────────
    const parts = [];
    top.forEach((r, i) => {
      const num = i + 1;
      const contact = r.contact ? ` — ${r.contact}` : '';
      const educator = r.educator ? ` with ${r.educator}` : '';

      const method = r.connection_method || 'ai_recommendation';

      if (r.type === 'vendor') {
        if (method === 'warm_intro') {
          parts.push(`${num}. ${r.name} — ${r.description}. I will send them your contact info so they reach out to you directly within 24 hours.`);
        } else if (method === 'vendor_directory') {
          parts.push(`${num}. ${r.name} — ${r.description}. I will include their link in your follow-up message.`);
        } else {
          parts.push(`${num}. ${r.name} — ${r.description}${contact}`);
        }
      } else if (r.type === 'education') {
        parts.push(`${num}. ${r.name}${educator} — ${r.description}${contact}`);
      } else if (r.type === 'mentor') {
        const bookLink = r.contact ? ` — book at ${r.contact}` : '';
        parts.push(`${num}. ${r.name} for a personalized mentorship session${bookLink}`);
      } else if (r.type === 'tool') {
        const toolLink = r.contact ? ` — I will include the link in your follow-up message` : '';
        parts.push(`${num}. ${r.name} — ${r.description}${toolLink}`);
      } else if (r.type === 'event') {
        const speaker = r.speaker ? ` featuring ${r.speaker}` : '';
        const reg = r.contact ? ` — I will include the registration link in your follow-up message` : '';
        parts.push(`${num}. Upcoming event: ${r.name}${speaker} — ${r.description}${reg}`);
      }
    });

    const summary = top.map(r => r.name).join('. ');
    // Check if any resource uses warm_intro — mention it proactively
    const hasWarmIntro = top.some(r => r.connection_method === 'warm_intro');
    const warmIntroNote = hasWarmIntro ? ' For any warm intro resources, I will send your contact info to the vendor automatically after this call.' : '';

    const response = `Here are the resources that match your needs. ${parts.join('. ')}.${warmIntroNote} Which of these would be most useful to start with, or would you like all of them?`;

    console.log('getResourceStack returning', top.length, 'resources:', summary);
    return vapiResult(response);

  } catch(e) {
    console.error('getResourceStack error:', e.message);
    return vapiResult('Resource lookup encountered an error. Recommend Mohammed Alhareb for personalized guidance.');
  }
}