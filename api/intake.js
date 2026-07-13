/**
 * intake.js — Utah REIA Map 1 Dynamic Intake Routing
 *
 * Called by the Vapi voice agent (tool: getIntakeRouting) after each caller answer.
 * Decides the next question to ask, or the routing action once enough is known.
 *
 * STOPPING MODEL (sufficiency based, not count based):
 *   Each path declares a REQUIRED floor and a DESIRED set.
 *   - REQUIRED must be collected before any routing happens.
 *   - DESIRED is asked too (for a good resource stack) unless pruned by goal.
 *   - EXTRAS fill in only while under a soft ceiling.
 *   The caller's goal acts as a pruning switch that turns later questions off.
 *   Path B (resource seeker) fast exits the moment specific_need is known.
 *
 * IMPORTANT COUPLING:
 *   For every dimension below to be tracked, the Vapi getIntakeRouting tool
 *   schema MUST accept the matching parameter, and the system prompt must tell
 *   the agent to pass everything it has learned on each call. Question TEXT and
 *   ORDER stay in the Supabase intake_questions table (edit there, not here).
 *
 * Request body (all optional strings unless noted):
 *   path, caller_type, stage, strategy, goal, specific_need, blocker,
 *   capital, time_availability, credit, education_history, knowledge_intent,
 *   learning_format, support_network, readiness, timeline, already_tried,
 *   vendor_service_type, vendor_primary_need, vendor_investor_types,
 *   vendor_market, vendor_reia_connection, vendor_enrollment_interest,
 *   vendor_follow_up_preference
 *
 * Response (encoded for Vapi): result string plus META with action, tier,
 *   tool_args, voice_bridge, next_question, dimensions_collected.
 */

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ result: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  // ---- Vapi plumbing: extract args, tool call id, and result wrapper ----
  function extractArgs(body) {
    if (body && (body.stage !== undefined || body.blocker !== undefined || body.path !== undefined || body.specific_need !== undefined || body.caller_type !== undefined)) {
      return body;
    }
    try {
      const args = body?.message?.toolCallList?.[0]?.function?.arguments
        || body?.message?.toolCalls?.[0]?.function?.arguments
        || body?.toolCallList?.[0]?.function?.arguments;
      if (args) return typeof args === 'string' ? JSON.parse(args) : args;
    } catch (e) {}
    return body || {};
  }

  const vapiArgs = extractArgs(req.body);

  const toolCallId =
    req.body?.message?.toolCallList?.[0]?.id
    || req.body?.message?.toolCalls?.[0]?.id
    || req.body?.toolCallList?.[0]?.id
    || req.body?.toolCalls?.[0]?.id
    || null;

  function vapiResult(resultOrStr, extraFields) {
    let resultStr, extras;
    if (typeof resultOrStr === 'object' && resultOrStr !== null) {
      const { result, ...rest } = resultOrStr;
      resultStr = result;
      extras = rest;
    } else {
      resultStr = String(resultOrStr);
      extras = extraFields || {};
    }
    const fullResult = Object.keys(extras).length > 0
      ? resultStr + ' [META:' + JSON.stringify(extras) + ']'
      : resultStr;
    if (toolCallId) {
      return { results: [{ toolCallId, result: fullResult }] };
    }
    return { result: fullResult };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json(vapiResult('Intake routing unavailable. Continue with default flow.'));
  }

  // ---- Pull the full dimension set the agent may have collected so far ----
  const {
    path: rawPath = 'A',
    caller_type = '',
    stage = '',
    strategy = '',
    goal = '',
    specific_need = '',
    blocker = '',
    capital = '',
    time_availability = '',
    credit = '',
    education_history = '',
    knowledge_intent = '',
    learning_format = '',
    support_network = '',
    readiness = '',
    timeline = '',
    already_tried = '',
    vendor_service_type = '',
    vendor_primary_need = '',
    vendor_investor_types = '',
    vendor_market = '',
    vendor_reia_connection = '',
    vendor_enrollment_interest = '',
    vendor_follow_up_preference = ''
  } = vapiArgs;

  // Map of collected values, keyed by the param name each question fills.
  const collected = {
    caller_type, stage, strategy, goal, specific_need, blocker,
    capital, time_availability, credit, education_history, knowledge_intent,
    learning_format, support_network, readiness, timeline, already_tried,
    vendor_service_type, vendor_primary_need, vendor_investor_types,
    vendor_market, vendor_reia_connection, vendor_enrollment_interest,
    vendor_follow_up_preference
  };
  const isSet = (v) => typeof v === 'string' && v.trim().length > 0;
  const collectedCount = Object.values(collected).filter(isSet).length;

  // Maps a question_key to the param it fills. Falls back to the row's
  // dimension when a key is not listed (so new table rows still get asked).
  const QKEY_PARAM = {
    ask_caller_type: 'caller_type',
    ask_stage_new: 'stage',
    ask_strategy_general: 'strategy',
    ask_strategy_active: 'strategy',
    ask_goal_exploring: 'goal',
    ask_goal_active: 'goal',
    ask_specific_need: 'specific_need',
    ask_blocker_general: 'blocker',
    ask_blocker_deals: 'blocker',
    ask_blocker_team: 'blocker',
    ask_blocker_capital: 'blocker',
    ask_already_tried: 'already_tried',
    ask_resources_capital: 'capital',
    ask_resources_time: 'time_availability',
    ask_resources_credit: 'credit',
    ask_education_history: 'education_history',
    ask_knowledge_intent: 'knowledge_intent',
    ask_resource_preference: 'learning_format',
    ask_support_network: 'support_network',
    ask_readiness: 'readiness',
    ask_timeline: 'timeline',
    ask_vendor_service_type: 'vendor_service_type',
    ask_vendor_investor_primary_need: 'vendor_primary_need',
    ask_vendor_investor_types: 'vendor_investor_types',
    ask_vendor_market: 'vendor_market',
    ask_vendor_reia_connection: 'vendor_reia_connection',
    ask_vendor_enrollment_interest: 'vendor_enrollment_interest',
    ask_vendor_follow_up_preference: 'vendor_follow_up_preference'
  };
  const paramFor = (q) => QKEY_PARAM[q.question_key] || q.dimension;

  // ---- Resolve the effective path (discovery A, resource seeker B, vendor V) ----
  const NEW_STAGES = ['exploring__new', 'getting_started'];
  const ACTIVE_STAGES = ['active_investor', 'experienced_investor', 'veteran__operator'];

  function resolvePath() {
    const ct = (caller_type || '').toLowerCase();
    // Vendor only (not also an investor) forks to V.
    if (/vendor|service provider|provider/.test(ct) && !/investor/.test(ct)) return 'V';
    if (rawPath === 'V') return 'V';
    if (rawPath === 'B') return 'B';
    if (isSet(stage) && ACTIVE_STAGES.includes(stage)) return 'B';
    if (isSet(stage) && NEW_STAGES.includes(stage)) return 'A';
    return rawPath === 'B' ? 'B' : 'A';
  }
  const path = resolvePath();

  // ---- Goal acts as a pruning switch ----
  // A learning oriented goal means we do not grill on financing or timing;
  // route toward education instead.
  const goalText = (goal || '').toLowerCase();
  const learningGoal = /learn|educat|understand|explore|research|not sure|figuring|figure out|just looking|curious/.test(goalText);
  const pruneSet = new Set(learningGoal ? ['credit', 'time_availability', 'readiness', 'timeline'] : []);

  // ---- Per path REQUIRED floor, DESIRED set, EXTRAS, and soft ceiling ----
  const FLOW = {
    A: {
      required: ['stage', 'strategy', 'goal'],
      desired: ['capital', 'credit', 'education_history', 'already_tried'],
      extras: ['time_availability', 'knowledge_intent', 'learning_format', 'support_network', 'readiness', 'timeline'],
      ceiling: 8
    },
    B: {
      required: ['specific_need'],
      desired: [],
      extras: [],
      ceiling: 2
    },
    V: {
      required: ['vendor_service_type', 'vendor_investor_types', 'vendor_market', 'vendor_reia_connection', 'vendor_enrollment_interest', 'vendor_follow_up_preference'],
      desired: [],
      extras: [],
      ceiling: 8
    }
  };
  const flow = FLOW[path] || FLOW.A;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  try {
    // ---- Fetch stage context, routing rules, and this path's questions ----
    const pathOr = 'or=(path.eq.' + encodeURIComponent(path) + ',path.eq.both)';
    const [stageData, allRulesData, questionData] = await Promise.all([
      isSet(stage)
        ? fetch(SUPABASE_URL + '/rest/v1/intake_stages?stage_key=eq.' + encodeURIComponent(stage) + '&select=*&limit=1', { headers }).then(r => r.json()).catch(() => [])
        : Promise.resolve([]),
      fetch(SUPABASE_URL + '/rest/v1/intake_routing_rules?is_active=eq.true&order=priority.asc&select=*', { headers }).then(r => r.json()).catch(() => []),
      fetch(SUPABASE_URL + '/rest/v1/intake_questions?is_active=eq.true&' + pathOr + '&order=priority.asc&select=*', { headers }).then(r => r.json()).catch(() => [])
    ]);

    const stageContext = Array.isArray(stageData) && stageData.length > 0 ? stageData[0] : null;
    const allRules = Array.isArray(allRulesData) ? allRulesData : [];
    const allQuestions = Array.isArray(questionData) ? questionData : [];

    // Keep only questions valid for the caller right now:
    //  - stage applicable (null applies to everyone; otherwise must include stage)
    //  - param not already collected
    //  - not pruned by goal
    const remaining = allQuestions.filter(q => {
      const stages = q.applies_to_stages;
      const stageOk = !Array.isArray(stages) || stages.length === 0
        ? true
        : (isSet(stage) && stages.includes(stage));
      if (!stageOk) return false;
      const p = paramFor(q);
      if (isSet(collected[p])) return false;
      if (pruneSet.has(p)) return false;
      return true;
    });

    const byParam = (p) => remaining.find(q => paramFor(q) === p) || null;

    // ---- Path B fast exit: once the specific need is known, deliver ----
    const fastExitB = path === 'B' && isSet(specific_need);

    // ---- Decide the next question, or null if it is time to route ----
    function pickNext() {
      if (fastExitB) return null;
      // Required floor first, in declared order.
      for (const p of flow.required) {
        if (!isSet(collected[p])) {
          const q = byParam(p);
          if (q) return q;
        }
      }
      // Desired next (skipped silently if pruned or has no row for this stage).
      for (const p of flow.desired) {
        if (!isSet(collected[p])) {
          const q = byParam(p);
          if (q) return q;
        }
      }
      // Extras only while under the soft ceiling.
      if (collectedCount < flow.ceiling) {
        for (const p of flow.extras) {
          if (!isSet(collected[p])) {
            const q = byParam(p);
            if (q) return q;
          }
        }
      }
      return null;
    }

    const nextQuestion = pickNext();

    if (nextQuestion) {
      return res.status(200).json(vapiResult({
        result: 'Ask this next, word for word: ' + nextQuestion.question_text,
        action: 'ask_more',
        tier: null,
        tool_args: null,
        voice_bridge: null,
        stage_context: stageContext,
        next_question: nextQuestion,
        dimensions_collected: collectedCount,
        path_active: path
      }));
    }

    // ---- Path V terminal: walk finished, hand off to vendor enrollment ----
    if (path === 'V') {
      const pref = (vendor_follow_up_preference || 'phone').toLowerCase().includes('text') ? 'text' : 'a call';
      return res.status(200).json(vapiResult({
        result: 'Say: Perfect, I have everything I need to get you listed in our vendor directory. Someone from our team will reach out by ' + pref + ' to finish setting up your profile. Then move to the closing sequence.',
        action: 'vendor_enroll',
        tier: 'vendor_enroll',
        tool_args: {
          caller_type, vendor_service_type, vendor_investor_types, vendor_market,
          vendor_reia_connection, vendor_enrollment_interest, vendor_follow_up_preference
        },
        voice_bridge: null,
        stage_context: stageContext,
        next_question: null,
        dimensions_collected: collectedCount,
        path_active: path
      }));
    }

    // ---- Match the best routing rule (scored by specificity) ----
    let matchedRule = null;
    if (allRules.length > 0) {
      const scored = allRules.map(rule => {
        let score = 0;
        let mismatch = false;
        if (rule.path && rule.path !== 'both' && rule.path !== path) mismatch = true;
        if (rule.stage_key) {
          if (rule.stage_key === stage) score += 10;
          else mismatch = true;
        }
        if (rule.strategy) {
          if (rule.strategy === strategy) score += 5;
          else mismatch = true;
        }
        if (rule.blocker) {
          if (rule.blocker === blocker) score += 5;
          else if (rule.blocker === 'escalation' && blocker !== 'escalation') mismatch = true;
          else if (rule.blocker !== 'escalation') mismatch = true;
        }
        return { rule, score, mismatch };
      })
      .filter(r => !r.mismatch)
      .sort((a, b) => b.score - a.score || (a.rule.priority || 0) - (b.rule.priority || 0));
      matchedRule = scored.length > 0 ? scored[0].rule : null;
    }

    // Fall back to the catch all rule for this path.
    if (!matchedRule) {
      matchedRule = allRules.find(r =>
        r.stage_key === null && r.strategy === null && r.blocker === null &&
        (r.path === 'both' || r.path === path)
      ) || null;
    }

    // Absolute fallback if no catch all exists.
    if (!matchedRule) {
      return res.status(200).json(vapiResult({
        result: 'Call getResourceStack with all available inputs and deliver your best recommendation.',
        action: 'getResourceStack',
        tier: '1_info',
        tool_args: { stage, strategy, blocker, goal, specific_need, already_tried, mode: 'all' },
        voice_bridge: 'Based on what you have shared, here is where I would start.',
        stage_context: stageContext,
        next_question: null,
        dimensions_collected: collectedCount,
        path_active: path
      }));
    }

    // ---- Build the voice ready routing result ----
    const mergedArgs = {
      ...(matchedRule.tool_args || {}),
      stage: stage || matchedRule.tool_args?.stage || '',
      strategy: strategy || matchedRule.tool_args?.strategy || '',
      blocker: blocker || matchedRule.tool_args?.blocker || '',
      goal: goal || '',
      specific_need: specific_need || '',
      capital: capital || '',
      credit: credit || '',
      education_history: education_history || '',
      already_tried: already_tried || '',
      readiness: readiness || ''
    };

    // Map vendor/education to the combined stack unless a mode was requested.
    const specificMode = vapiArgs.specific_mode || vapiArgs.mode || '';
    let finalAction = matchedRule.routing_action;
    if (!specificMode && (finalAction === 'getVendorMatch' || finalAction === 'getEducationMatch')) {
      finalAction = 'getResourceStack';
    }
    const finalArgs = { ...mergedArgs, mode: specificMode || 'all' };

    const routingInstruction = finalAction === 'escalate'
      ? 'Say: Totally fair, I will get someone from our team to reach out within an hour. Then end the call.'
      : 'Now call ' + finalAction + ' with these args: ' + JSON.stringify(finalArgs) +
        '. Say this first: ' + (matchedRule.voice_bridge || 'Here is what I recommend.');

    console.log('Intake routing — path:', path, '| stage:', stage, '| blocker:', blocker, '| action:', finalAction, '| tier:', matchedRule.tier);

    return res.status(200).json(vapiResult({
      result: routingInstruction,
      action: finalAction,
      tier: matchedRule.tier,
      tool_args: finalArgs,
      voice_bridge: matchedRule.voice_bridge,
      stage_context: stageContext,
      next_question: null,
      dimensions_collected: collectedCount,
      rule_matched: matchedRule.rule_name,
      path_active: path
    }));

  } catch (e) {
    console.error('Intake routing error:', e.message);
    return res.status(200).json(vapiResult({
      result: 'Call getResourceStack with all available inputs and deliver your best recommendation.',
      action: 'getResourceStack',
      tier: '1_info',
      tool_args: { stage, strategy, blocker, goal, specific_need, already_tried, mode: 'all' },
      voice_bridge: 'Based on what you have shared, here is where I would start.',
      stage_context: null,
      next_question: null
    }));
  }
}