/**
 * health-elevenlabs.js — voice-layer health probe (ElevenLabs)
 *
 * WHY THIS EXISTS: on 2026-08-06 the ElevenLabs key that Vapi (Lani) and HeyGen
 * shared stopped working and it took ~2 hours to find, because nothing was
 * watching the voice layer — our own Vercel logs never showed the ElevenLabs
 * error, only Vapi's call-level log did. This endpoint pings ElevenLabs with the
 * production key so a dead/disabled key surfaces in minutes, not hours.
 *
 * HOW IT RUNS: a GitHub Actions workflow (.github/workflows/health-elevenlabs.yml)
 * curls this every 15 minutes and exits non-zero when the key is unhealthy. A
 * failed Actions run emails the repo admins — that is the alert. (It is Actions,
 * not a Vercel cron, because Vercel Hobby crons run at most once a day.)
 *
 * CRITICAL — WHICH KEY: this probe is only meaningful if it uses the SAME key
 * value Vapi is configured with. The old direct-TTS handler was removed, so the
 * Vercel app no longer carries an ElevenLabs key by default. Set env
 * ELEVENLABS_API_KEY on Vercel to the EXACT key configured in Vapi's voice
 * provider settings. If Vapi and HeyGen are split onto separate keys (prevention
 * step 2), this must carry Vapi's key, since Lani is what we are protecting.
 * Until the env var is set, the probe reports configured:false and the workflow
 * treats that as "not set up yet" (a warning), NOT as an outage — so it never
 * spams failure emails before it is wired.
 *
 * AUTH: optional. If HEALTHCHECK_TOKEN env is set, a matching Bearer token is
 * required, so the probe can't be triggered anonymously (which would burn quota
 * and leak the subscription tier). If unset, the endpoint is open.
 *
 * TWO-STAGE CHECK: (1) the key is valid (/v1/user), then (2) the key's account can
 * actually use Lani's voice (/v1/voices/{id}). Stage 2 was added after 2026-09-29,
 * when a valid key from the WRONG ElevenLabs account passed stage 1 (probe green)
 * but every call still died with "voice not fine-tuned and cannot be used." The
 * key check alone can't see that; the voice check can.
 *
 * Responses (always HTTP 200; the workflow reads the JSON, not the status code):
 *   { ok:true,  configured:true,  provider, tier, voice_id, voice_name }
 *   { ok:false, configured:true,  provider, error, http_status }   <- real outage
 *       error is one of: auth_failed_key_invalid_or_disabled, elevenlabs_error,
 *       voice_unavailable_under_key (wrong account), voice_not_fine_tuned, timeout
 *   { ok:false, configured:false, provider, error:'not_configured' } <- setup pending
 */

export const config = { maxDuration: 15 };

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || '';
const PROVIDER = 'elevenlabs';
const PROBE_URL = 'https://api.elevenlabs.io/v1/user';
// Lani's voice clone. A valid key from the WRONG account passes /v1/user but
// cannot use this voice — so we probe it too. Override via env if the voice changes.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '7W2QbODUCE6OSVq7YEBU';
const TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }

  // Optional bearer gate — only enforced when a token is configured.
  if (HEALTHCHECK_TOKEN) {
    const auth = req.headers?.authorization || '';
    const passed = auth === `Bearer ${HEALTHCHECK_TOKEN}` || req.query?.token === HEALTHCHECK_TOKEN;
    if (!passed) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  // Not wired yet — report as setup-pending, never as an outage.
  if (!ELEVENLABS_API_KEY) {
    return res.status(200).json({
      ok: false,
      configured: false,
      provider: PROVIDER,
      error: 'not_configured',
      hint: 'Set ELEVENLABS_API_KEY on Vercel to the exact key Vapi uses.'
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(PROBE_URL, {
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, accept: 'application/json' },
      signal: controller.signal
    });

    if (!resp.ok) {
      // Auth failures are the 2026-08-06 signature: key invalid, disabled, auto-
      // revoked, or (as we saw) a key ID used instead of the sk_ secret. ElevenLabs
      // returns these as 401 OR 400 with an authentication_error body, so detect on
      // the body code too, not just the status. Surface detail (never the key).
      let detail = '';
      let isAuth = resp.status === 401 || resp.status === 403;
      try {
        detail = (await resp.text()).slice(0, 300);
        const lc = detail.toLowerCase();
        if (lc.includes('authentication_error') || lc.includes('invalid_api_key') ||
            lc.includes('api_key_id_used') || lc.includes("start with 'sk_")) {
          isAuth = true;
        }
      } catch (_) {}
      return res.status(200).json({
        ok: false,
        configured: true,
        provider: PROVIDER,
        http_status: resp.status,
        error: isAuth ? 'auth_failed_key_invalid_or_disabled' : 'elevenlabs_error',
        detail
      });
    }

    // Stage 1 passed: the key is valid. Parse account info.
    let tier = null, characterLimit = null;
    try {
      const data = await resp.json();
      tier = data?.subscription?.tier ?? null;
      characterLimit = data?.subscription?.character_limit ?? null;
    } catch (_) { /* body parse is best-effort */ }

    // Stage 2: verify the key's account can actually use Lani's voice. A valid key
    // from the wrong account passes stage 1 but 404s here — the 2026-09-29 failure.
    if (VOICE_ID) {
      const vController = new AbortController();
      const vTimer = setTimeout(() => vController.abort(), TIMEOUT_MS);
      try {
        const vResp = await fetch(`https://api.elevenlabs.io/v1/voices/${VOICE_ID}`, {
          method: 'GET',
          headers: { 'xi-api-key': ELEVENLABS_API_KEY, accept: 'application/json' },
          signal: vController.signal
        });
        if (!vResp.ok) {
          // Non-200 (usually 404) = this key's account cannot see the voice.
          let vdetail = '';
          try { vdetail = (await vResp.text()).slice(0, 200); } catch (_) {}
          return res.status(200).json({
            ok: false, configured: true, provider: PROVIDER,
            error: 'voice_unavailable_under_key', http_status: vResp.status,
            voice_id: VOICE_ID, tier, detail: vdetail
          });
        }
        // Voice is present. Best-effort, schema-tolerant fine-tune check: only flag
        // when we can positively see it is NOT fine-tuned for any model.
        let voiceName = null, notFineTuned = false;
        try {
          const vdata = await vResp.json();
          voiceName = vdata?.name ?? null;
          const ft = vdata?.fine_tuning;
          const states = ft && ft.state && typeof ft.state === 'object' ? Object.values(ft.state) : [];
          if (states.length && !states.includes('fine_tuned')) notFineTuned = true;
        } catch (_) {}
        if (notFineTuned) {
          return res.status(200).json({
            ok: false, configured: true, provider: PROVIDER,
            error: 'voice_not_fine_tuned', voice_id: VOICE_ID, tier
          });
        }
        return res.status(200).json({
          ok: true, configured: true, provider: PROVIDER,
          tier, character_limit: characterLimit, voice_id: VOICE_ID, voice_name: voiceName
        });
      } catch (e) {
        const aborted = e?.name === 'AbortError';
        return res.status(200).json({
          ok: false, configured: true, provider: PROVIDER,
          error: aborted ? 'voice_check_timeout' : 'voice_check_exception',
          voice_id: VOICE_ID, tier, detail: String(e?.message || e).slice(0, 200)
        });
      } finally {
        clearTimeout(vTimer);
      }
    }

    // No voice id configured — key-only health.
    return res.status(200).json({
      ok: true, configured: true, provider: PROVIDER,
      tier, character_limit: characterLimit, voice_checked: false
    });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return res.status(200).json({
      ok: false,
      configured: true,
      provider: PROVIDER,
      error: aborted ? 'timeout' : 'probe_exception',
      detail: String(e?.message || e).slice(0, 200)
    });
  } finally {
    clearTimeout(timer);
  }
}
