
export const config = {
  api: {
    bodyParser: false // We'll handle parsing manually
  }
};

import { Readable } from 'stream';
import busboy from 'busboy';
import FormData from 'form-data';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI API key not configured.' });

  try {
    const bb = busboy({ headers: req.headers });
    let fileBuffer = Buffer.alloc(0);
    let fileMime = '';
    let fileFound = false;

    await new Promise((resolve, reject) => {
      bb.on('file', (name, file, info) => {
        fileFound = true;
        fileMime = info.mimeType;
        file.on('data', (data) => {
          fileBuffer = Buffer.concat([fileBuffer, data]);
        });
        file.on('end', () => {
          resolve();
        });
      });
      bb.on('error', reject);
      bb.on('finish', () => {
        if (!fileFound) reject(new Error('No file uploaded'));
      });
      req.pipe(bb);
    });

    if (!fileFound) return res.status(400).json({ error: 'No file uploaded' });
    if (fileBuffer.length < 100) {
      return res.status(400).json({ error: 'Audio too small: ' + fileBuffer.length + ' bytes' });
    }

    // Use form-data package to send the file as a real multipart upload
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: 'audio.webm',
      contentType: fileMime || 'audio/webm'
    });
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_KEY,
        ...formData.getHeaders()
      },
      body: formData
    });

    const result = await resp.json();
    console.log('OpenAI response:', resp.status, result.text || result.error?.message);

    if (!resp.ok) return res.status(resp.status).json({ error: JSON.stringify(result) });

    return res.status(200).json({ text: result.text || '' });
  } catch (e) {
    console.error('Transcribe error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
}