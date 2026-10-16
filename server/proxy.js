import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ipRequestMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 30;

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = ipRequestMap.get(ip) || [];
  const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    ipRequestMap.set(ip, validTimestamps);
    return false;
  }

  validTimestamps.push(now);
  ipRequestMap.set(ip, validTimestamps);
  return true;
}

function sendJsonResponse(res, statusCode, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sanitizeErrorMessage(msg, apiKey) {
  if (!msg || typeof msg !== 'string') return 'An error occurred';
  if (apiKey) {
    return msg.split(apiKey).join('[REDACTED]');
  }
  return msg;
}

function callGeminiApi(promptText, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [
        {
          parts: [{ text: promptText }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });

    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`);

    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 12000
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(responseData);
              const textContent = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              const usageMetadata = parsed.usageMetadata;
              resolve({ textContent, usageMetadata });
            } catch (err) {
              reject(new Error(`Failed to parse Gemini response: ${sanitizeErrorMessage(err.message, apiKey)}`));
            }
          } else {
            const safeError = sanitizeErrorMessage(responseData.slice(0, 150), apiKey);
            reject(new Error(`Gemini API error (HTTP ${res.statusCode}): ${safeError}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(sanitizeErrorMessage(err.message, apiKey))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini API request timed out after 12s'));
    });

    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const clientIp = req.socket?.remoteAddress || 'unknown';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJsonResponse(res, 200, {
      status: 'UP',
      hasApiKey: Boolean(GEMINI_API_KEY)
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/learn-layout') {
    if (!checkRateLimit(clientIp)) {
      sendJsonResponse(res, 429, {
        error: 'Rate limit exceeded (max 30 requests/min). Please try again shortly.'
      });
      return;
    }

    if (!GEMINI_API_KEY) {
      sendJsonResponse(res, 500, {
        error: 'GEMINI_API_KEY is not configured on the proxy server.'
      });
      return;
    }

    let body = '';
    let totalBytes = 0;
    let isOversized = false;
    const MAX_BYTES = 100 * 1024;

    req.on('data', (chunk) => {
      if (isOversized) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        isOversized = true;
        sendJsonResponse(res, 413, { error: 'Payload exceeds 100KB limit' });
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      if (isOversized || res.writableEnded) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJsonResponse(res, 400, { error: 'Invalid JSON request body' });
        return;
      }

      const { hostname, pageTitle, candidateSelectors, diagnostics, domSnippets } = payload;

      if (!hostname || typeof hostname !== 'string' || hostname.length > 150) {
        sendJsonResponse(res, 400, { error: 'Invalid or missing hostname parameter' });
        return;
      }

      if (!domSnippets || !Array.isArray(domSnippets) || domSnippets.length === 0 || domSnippets.length > 5) {
        sendJsonResponse(res, 400, { error: 'domSnippets must be an array with 1 to 5 elements' });
        return;
      }

      let totalSnippetChars = 0;
      for (const snip of domSnippets) {
        if (typeof snip !== 'string') {
          sendJsonResponse(res, 400, { error: 'Each DOM snippet must be a string' });
          return;
        }
        totalSnippetChars += snip.length;
      }

      if (totalSnippetChars > 25000) {
        sendJsonResponse(res, 400, { error: 'Total DOM snippets size exceeds 25KB' });
        return;
      }

      const prompt = `You are a web extraction assistant for an e-commerce search results extractor.
Analyze the provided DOM snippets from "${hostname}" (Page: "${pageTitle || ''}") to deduce CSS selectors for product cards and individual fields.

Return ONLY a strict JSON object with NO markdown formatting, matching this exact schema:
{
  "cardSelector": "string (CSS selector that selects each product card container)",
  "fieldSelectors": {
    "titleSelector": "string (CSS selector relative to each card for product title)",
    "urlSelector": "string (CSS selector relative to each card for product link a[href])",
    "imageSelector": "string (CSS selector relative to each card for product image)",
    "priceSelector": "string (CSS selector relative to each card for active selling price)",
    "mrpSelector": "string (CSS selector relative to each card for original/strikethrough list price)",
    "ratingSelector": "string (CSS selector relative to each card for product rating)"
  },
  "confidence": number between 0 and 1
}

Diagnostics from DOM heuristics:
${JSON.stringify(diagnostics || {})}

Candidate Card Selectors evaluated:
${(candidateSelectors || []).slice(0, 10).join(', ')}

Sample Card HTML Snippets:
${domSnippets.slice(0, 2).join('\n---\n')}
`;

      try {
        const { textContent, usageMetadata } = await callGeminiApi(prompt, GEMINI_API_KEY);
        const parsedRule = JSON.parse(textContent);
        sendJsonResponse(res, 200, {
          ...parsedRule,
          usageMetadata
        });
      } catch (err) {
        sendJsonResponse(res, 502, {
          error: `AI inference failed: ${sanitizeErrorMessage(err.message, GEMINI_API_KEY)}`
        });
      }
    });
    return;
  }

  sendJsonResponse(res, 404, { error: 'Not found' });
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`PIRATES ALERT AI proxy server running on http://localhost:${PORT}`);
  });
}

export { server };
