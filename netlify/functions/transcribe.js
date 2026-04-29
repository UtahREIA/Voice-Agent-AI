const https = require('https');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key not configured.' }) };
  }

  try {
    // Body arrives as base64 string sent from the browser
    const base64Audio = event.isBase64Encoded ? event.body : event.body;
    const audioBuffer = Buffer.from(base64Audio, 'base64');

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

    const headerPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`
    );

    const tailPart = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1` +
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `en` +
      `\r\n--${boundary}--\r\n`
    );

    const body = Buffer.concat([headerPart, audioBuffer, tailPart]);

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + OPENAI_KEY,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (result.status !== 200) {
      return { statusCode: result.status, body: JSON.stringify({ error: result.body }) };
    }

    const parsed = JSON.parse(result.body);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: parsed.text || '' })
    };

  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};