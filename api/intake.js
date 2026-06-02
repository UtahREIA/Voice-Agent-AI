/**
 * intake.js — Utah REIA Map 1 Dynamic Intake Routing
 *
 * This endpoint is called by the Vapi voice agent to dynamically retrieve
 * the correct routing action based on the investor's stage, strategy, and blocker.
 * It replaces hardcoded intake logic in the system prompt with Supabase-driven rules.
 *
 * Called by Vapi tool: getIntakeRouting
 *
 * Request body:
 *   stage        {string} — investor stage key e.g. exploring, getting_started, active
 *   strategy     {string} — investing strategy e.g. fix_and_flip, buy_and_hold
 *   blocker      {string} — main blocker e.g. capital, deals, team, education
 *   path         {string} — A (new/exploring) or B (already investing)
 *   already_tried {string} — what they have already attempted
 *   goal         {string} — what they want to accomplish
 *   readiness    {string} — readiness level 1-10
 *
 * Response:
 *   result       {string} — voice-ready routing instruction for Claude
 *   action       {string} — getEducationMatch, getVendorMatch, escalate, or info_only
 *   tier         {string} — 1_info, 2_vendor, 3_educator, 2_and_3, 0_escalation
 *   tool_args    {object} — args to pass directly to the matched routing tool
 *   voice_bridge {string} — what the agent says before delivering the recommendation
 *   stage_context {object} — full stage description for Claude's context
 *   next_question {object} — next question to ask if more dimensions needed
 */

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ result: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({
      result: 'Intake routing unavailable. Continue with default flow.',
      action: 'getEducationMatch',
      tier: '1_info'
    });
  }

  // Extract all dimensions from request body
  // Extract tool arguments from all possible Vapi request formats
  // Vapi sends arguments nested inside toolCallList[0].function.arguments as a JSON string
  function extractArgs(body) {
    if (body && (body.stage !== undefined || body.blocker !== undefined || body.path !== undefined)) {
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
    stage = '',
    strategy = '',
    blocker = '',
    path = 'A',
    already_tried = '',
    goal = '',
    readiness = ''
  } = vapiArgs;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  try {

    // --- STEP 1 & 2: Fetch stage context and routing rules in parallel ---
    // Running both fetches simultaneously cuts response time roughly in half
    const dimensions = [stage, strategy, blocker, goal, already_tried].filter(Boolean);
    const dimensionCount = dimensions.length;

    const [stageData, allRulesData] = await Promise.all([
      stage
        ? fetch(SUPABASE_URL + '/rest/v1/intake_stages?stage_key=eq.' + encodeURIComponent(stage) + '&select=*&limit=1', { headers }).then(r => r.json()).catch(() => [])
        : Promise.resolve([]),
      fetch(SUPABASE_URL + '/rest/v1/intake_routing_rules?is_active=eq.true&order=priority.asc&select=*', { headers }).then(r => r.json()).catch(() => [])
    ]);

    const stageContext = Array.isArray(stageData) && stageData.length > 0 ? stageData[0] : null;
    const allRules = Array.isArray(allRulesData) ? allRulesData : [];

    // --- STEP 3: Find the next question to ask if not enough dimensions ---
    if (dimensionCount < 3) {
      const missingDimensions = [];
      if (!strategy) missingDimensions.push('strategy');
      if (!blocker) missingDimensions.push('blocker');
      if (!goal) missingDimensions.push('goal');
      if (!already_tried) missingDimensions.push('already_tried');

      const nextDimension = missingDimensions[0];
      if (nextDimension) {
        const qResp = await fetch(
          SUPABASE_URL + '/rest/v1/intake_questions?dimension=eq.' + encodeURIComponent(nextDimension) +
          '&is_active=eq.true&order=priority.asc&limit=3',
          { headers }
        );
        const questions = await qResp.json();

        // Pick the question that best matches the current stage
        let nextQuestion = null;
        if (Array.isArray(questions) && questions.length > 0) {
          // Prefer a stage-specific question over a generic one
          nextQuestion = questions.find(q =>
            q.applies_to_stages && q.applies_to_stages.includes(stage)
          ) || questions.find(q =>
            !q.applies_to_stages || q.applies_to_stages.length === 0
          ) || questions[0];
        }

        return res.status(200).json({
          result: nextQuestion
            ? 'Ask this next: ' + nextQuestion.question_text
            : 'Ask what their main blocker is right now.',
          action: 'ask_more',
          tier: null,
          tool_args: null,
          voice_bridge: null,
          stage_context: stageContext,
          next_question: nextQuestion,
          dimensions_collected: dimensionCount,
          dimensions_needed: 3
        });
      }
    }

    // --- STEP 4: Find the best matching routing rule ---
    // allRules already fetched in parallel above — no additional fetch needed
    let matchedRule = null;

    if (Array.isArray(allRules) && allRules.length > 0) {
      // Score each rule by specificity — more matching dimensions = higher score
      const scoredRules = allRules.map(rule => {
        let score = 0;
        let mismatch = false;

        // Check path compatibility
        if (rule.path !== 'both' && rule.path !== path) {
          mismatch = true;
        }

        // Score stage match
        if (rule.stage_key) {
          if (rule.stage_key === stage) score += 10;
          else mismatch = true;
        }

        // Score strategy match
        if (rule.strategy) {
          if (rule.strategy === strategy) score += 5;
          else mismatch = true;
        }

        // Score blocker match
        if (rule.blocker) {
          if (rule.blocker === blocker) score += 5;
          else if (rule.blocker === 'escalation' && blocker !== 'escalation') mismatch = true;
          else if (rule.blocker !== 'escalation') mismatch = true;
        }

        return { rule, score, mismatch };
      })
      .filter(r => !r.mismatch)
      .sort((a, b) => b.score - a.score || a.rule.priority - b.rule.priority);

      matchedRule = scoredRules.length > 0 ? scoredRules[0].rule : null;
    }

    // --- STEP 5: Fall back to catch-all if no specific rule matched ---
    if (!matchedRule) {
      // Use the catch-all rule for the appropriate path
      matchedRule = allRules
        ? allRules.find(r =>
            r.stage_key === null &&
            r.strategy === null &&
            r.blocker === null &&
            (r.path === 'both' || r.path === path)
          )
        : null;
    }

    if (!matchedRule) {
      // Absolute fallback — should never reach here with catch-all rules in place
      return res.status(200).json({
        result: 'Call getEducationMatch with all available inputs and deliver your best recommendation.',
        action: 'getEducationMatch',
        tier: '1_info',
        tool_args: { stage, strategy, blocker, goal, already_tried, readiness },
        voice_bridge: 'Based on what you have shared, here is where I would start.',
        stage_context: stageContext,
        next_question: null,
        dimensions_collected: dimensionCount
      });
    }

    // --- STEP 6: Build the voice-ready result ---
    // Merge the rule's default tool_args with the live call dimensions
    const mergedArgs = {
      ...(matchedRule.tool_args || {}),
      stage: stage || matchedRule.tool_args?.stage || '',
      strategy: strategy || matchedRule.tool_args?.strategy || '',
      blocker: blocker || matchedRule.tool_args?.blocker || '',
      goal: goal || '',
      already_tried: already_tried || '',
      readiness: readiness || ''
    };

    // Build a clear instruction for Claude
    const routingInstruction = matchedRule.routing_action === 'escalate'
      ? 'Say: Totally fair, I will get someone from our team to reach out within an hour. Then end the call.'
      : 'Now call ' + matchedRule.routing_action + ' with these args: ' +
        JSON.stringify(mergedArgs) + '. Say this first: ' + (matchedRule.voice_bridge || 'Here is what I recommend.');

    console.log('Intake routing — stage:', stage, '| blocker:', blocker, '| action:', matchedRule.routing_action, '| tier:', matchedRule.tier);

    return res.status(200).json({
      result: routingInstruction,
      action: matchedRule.routing_action,
      tier: matchedRule.tier,
      tool_args: mergedArgs,
      voice_bridge: matchedRule.voice_bridge,
      stage_context: stageContext,
      next_question: null,
      dimensions_collected: dimensionCount,
      rule_matched: matchedRule.rule_name
    });

  } catch (e) {
    console.error('Intake routing error:', e.message);
    return res.status(200).json({
      result: 'Call getEducationMatch with all available inputs and deliver your best recommendation.',
      action: 'getEducationMatch',
      tier: '1_info',
      tool_args: { stage, strategy, blocker, goal, already_tried },
      voice_bridge: 'Based on what you have shared, here is where I would start.',
      stage_context: null,
      next_question: null
    });
  }
}