export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

  if (!ELEVEN_KEY) return res.status(500).json({ error: 'ElevenLabs API key not configured.' });

  try {
    let voiceId = ELEVEN_VOICE_ID;

    // If no voice ID configured, or as a fallback — fetch first available voice from account
    if (!voiceId) {
      console.log('No ELEVENLABS_VOICE_ID set — fetching voices from account...');
      const voicesResp = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': ELEVEN_KEY }
      });
      if (voicesResp.ok) {
        const voicesData = await voicesResp.json();
        const voices = voicesData.voices || [];
        console.log('Available voices:', voices.map(v => v.name + ':' + v.voice_id).join(', '));
        // Prefer a voice named Harmonie, otherwise use the first available
        const harmonie = voices.find(v => v.name.toLowerCase().includes('harmonie'));
        voiceId = harmonie ? harmonie.voice_id : voices[0]?.voice_id;
        console.log('Selected voice:', voiceId);
      }
    }

    if (!voiceId) return res.status(500).json({ error: 'No voice ID available.' });

    console.log('Using voice ID:', voiceId);

    const body = await req.json ? req.json() : req.body;
    const text = body.text;

    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVEN_KEY,
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
        })
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.log('ElevenLabs error:', resp.status, err.substring(0, 300));
      return res.status(resp.status).json({ error: err });
    }

    const audioBuffer = await resp.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(Buffer.from(audioBuffer));

  } catch(e) {
    console.error('ElevenLabs handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}