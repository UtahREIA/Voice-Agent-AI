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
    // Netlify may or may not base64-encode the body depending on content type
    // Always decode safely — if it looks like base64, treat it as base64
    let audioBuffer;
    if (event.isBase64Encoded) {
      audioBuffer = Buffer.from(event.body, 'base64');
    } else {
      // Body came as raw string — encode it ourselves
      audioBuffer = Buffer.from(event.body, 'binary');
    }

    // Log size for debugging
    console.log('Audio buffer size:', audioBuffer.length, 'isBase64Encoded:', event.isBase64Encoded);

    if (audioBuffer.length < 100) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Audio buffer too small: ' + audioBuffer.length + ' bytes' }) };
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

    console.log('OpenAI response status:', result.status, 'body:', result.body.substring(0, 300));

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