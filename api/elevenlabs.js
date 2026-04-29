export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
  if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) return res.status(500).json({ error: 'ElevenLabs not configured.' });

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVEN_KEY,
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: req.body.text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
        })
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: err });
    }

    const audioBuffer = await resp.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(Buffer.from(audioBuffer));
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}