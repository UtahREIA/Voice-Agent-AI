
import formidable from 'formidable';
import fs from 'fs';
export const config = {
  api: {
    bodyParser: false // Required for formidable
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI API key not configured.' });

  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      return res.status(400).json({ error: 'Form parse error: ' + err.message });
    }
    const file = files.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const audioBuffer = await fs.promises.readFile(file.filepath);
    if (audioBuffer.length < 100) {
      return res.status(400).json({ error: 'Audio too small: ' + audioBuffer.length + ' bytes' });
    }

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

    const headerPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`
    );

    const tailPart = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1` +
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\nen` +
      `\r\n--${boundary}--\r\n`
    );

    const body = Buffer.concat([headerPart, audioBuffer, tailPart]);

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body
    });

    const result = await resp.json();
    console.log('OpenAI response:', resp.status, result.text || result.error?.message);

    if (!resp.ok) return res.status(resp.status).json({ error: JSON.stringify(result) });

    return res.status(200).json({ text: result.text || '' });
  });
}