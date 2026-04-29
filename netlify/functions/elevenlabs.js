export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const ELEVEN_KEY = Netlify.env.get('ELEVENLABS_API_KEY');
  const ELEVEN_VOICE_ID = Netlify.env.get('ELEVENLABS_VOICE_ID');

  if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) {
    return new Response(JSON.stringify({ error: 'ElevenLabs not configured.' }), { status: 500 });
  }

  try {
    const body = await req.json();

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
          text: body.text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
        })
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({ error: err }), { status: resp.status });
    }

    const audioBuffer = await resp.arrayBuffer();
    return new Response(audioBuffer, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};