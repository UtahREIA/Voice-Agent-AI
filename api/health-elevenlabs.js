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
 * Responses (always HTTP 200; the workflow reads the JSON, not the status code):
 *   { ok:true,  configured:true,  provider, tier, character_limit }
 *   { ok:false, configured:true,  provider, error, http_status }   <- real outage
 *   { ok:false, configured:false, provider, error:'not_configured' } <- setup pending
 */

export const config = { maxDuration: 15 };

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const HEALTHCHECK_TOKEN = process.env.HEALTHCHECK_TOKEN || '';
const PROVIDER = 'elevenlabs';
const PROBE_URL = 'https://api.elevenlabs.io/v1/user';
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
      // 401 here is the exact 2026-08-06 signature: key invalid, disabled, or
      // auto-revoked. Surface the status and any error text (never the key).
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch (_) {}
      return res.status(200).json({
        ok: false,
        configured: true,
        provider: PROVIDER,
        http_status: resp.status,
        error: resp.status === 401 ? 'auth_failed_key_invalid_or_disabled' : 'elevenlabs_error',
        detail
      });
    }

    let tier = null, characterLimit = null;
    try {
      const data = await resp.json();
      tier = data?.subscription?.tier ?? null;
      characterLimit = data?.subscription?.character_limit ?? null;
    } catch (_) { /* body parse is best-effort */ }

    return res.status(200).json({
      ok: true,
      configured: true,
      provider: PROVIDER,
      tier,
      character_limit: characterLimit
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
