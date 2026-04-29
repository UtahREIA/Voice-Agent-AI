export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const OPENAI_KEY = Netlify.env.get('OPENAI_API_KEY');
  if (!OPENAI_KEY) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured.' }), { status: 500 });
  }

  try {
    const audioBuffer = await req.arrayBuffer();
    console.log('Audio buffer received:', audioBuffer.byteLength, 'bytes');

    if (audioBuffer.byteLength < 100) {
      return new Response(JSON.stringify({ error: 'Audio too small: ' + audioBuffer.byteLength + ' bytes' }), { status: 400 });
    }

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });
    formData.append('file', blob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: formData
    });

    const result = await resp.json();
    console.log('OpenAI status:', resp.status, 'text:', result.text || result.error?.message);

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: JSON.stringify(result) }), { status: resp.status });
    }

    return new Response(JSON.stringify({ text: result.text || '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(e) {
    console.error('Transcribe error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};