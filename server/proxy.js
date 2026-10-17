import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 3001;

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '';
}

function getGeminiModel() {
  return process.env.GEMINI_MODEL ? process.env.GEMINI_MODEL.trim() : 'gemini-2.5-flash';
}

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

function getCorsHeaders(reqOrigin) {
  return {
    'Access-Control-Allow-Origin': reqOrigin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Private-Network': 'true'
  };
}

function sendJsonResponse(res, statusCode, data, reqOrigin = '*') {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...getCorsHeaders(reqOrigin)
  });
  res.end(body);
}

function sanitizeErrorMessage(msg, apiKey) {
  if (!msg || typeof msg !== 'string') return 'An error occurred';
  let cleaned = msg;
  if (apiKey && apiKey.length >= 4) {
    cleaned = cleaned.split(apiKey).join('[REDACTED]');
  }
  cleaned = cleaned.replace(/key=[a-zA-Z0-9_\-\.]{8,}/gi, 'key=[REDACTED]');
  cleaned = cleaned.replace(/AIza[a-zA-Z0-9_\-]{30,}/g, '[REDACTED]');
  return cleaned;
}

function getUpstreamTimeoutMs() {
  const envVal = parseInt(process.env.GEMINI_TIMEOUT_MS, 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 45000;
}

function callGeminiApi(promptText, apiKey, modelName, timeoutMs = getUpstreamTimeoutMs(), clientReq = null, clientRes = null) {
  return new Promise((resolve, reject) => {
    const targetModel = modelName || getGeminiModel();

    const generationConfig = {
      responseMimeType: 'application/json',
      temperature: 0.1
    };
    if (targetModel.includes('2.5') || targetModel.includes('2.0')) {
      const budget = parseInt(process.env.GEMINI_THINKING_BUDGET ?? '0', 10);
      if (!isNaN(budget) && budget >= 0) {
        generationConfig.thinkingConfig = {
          thinkingBudget: budget
        };
      }
    }

    const payload = JSON.stringify({
      contents: [
        {
          parts: [{ text: promptText }]
        }
      ],
      generationConfig
    });

    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(apiKey)}`);

    let timedOut = false;
    let settled = false;
    let overallTimer = null;
    let headersReceived = false;
    let upstreamStatusCode = null;
    let ttfb = null;
    const reqStartTime = Date.now();

    function cleanupTimers() {
      if (overallTimer) {
        clearTimeout(overallTimer);
        overallTimer = null;
      }
    }

    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-goog-api-key': apiKey
        }
      },
      (res) => {
        headersReceived = true;
        upstreamStatusCode = res.statusCode || 500;
        ttfb = Date.now() - reqStartTime;

        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanupTimers();

          const statusCode = res.statusCode || 500;
          if (statusCode >= 200 && statusCode < 300) {
            try {
              const parsed = JSON.parse(responseData);
              const textContent = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (!textContent || typeof textContent !== 'string') {
                reject({
                  category: 'MALFORMED_UPSTREAM',
                  statusCode: 502,
                  headersReceived,
                  upstreamStatusCode,
                  ttfb,
                  message: 'Gemini API response missing candidate text content'
                });
                return;
              }
              const usageMetadata = parsed.usageMetadata;
              resolve({ textContent, usageMetadata, headersReceived, upstreamStatusCode, ttfb });
            } catch (err) {
              reject({
                category: 'MALFORMED_UPSTREAM',
                statusCode: 502,
                headersReceived,
                upstreamStatusCode,
                ttfb,
                message: `Failed to parse Gemini response: ${sanitizeErrorMessage(err.message, apiKey)}`
              });
            }
          } else {
            let errorCategory = 'UPSTREAM_ERROR';
            let mappedStatus = 502;
            let descriptiveMessage = `Gemini API error (HTTP ${statusCode})`;

            if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
              if (responseData.includes('API_KEY_INVALID') || responseData.includes('API key not valid') || statusCode === 401 || statusCode === 403) {
                errorCategory = 'AUTHENTICATION_ERROR';
                mappedStatus = 401;
                descriptiveMessage = 'Gemini API authentication failed: Invalid or unauthorized API key.';
              } else if (responseData.includes('not found') || responseData.includes('is not supported')) {
                errorCategory = 'MODEL_NOT_FOUND';
                mappedStatus = 502;
                descriptiveMessage = `Gemini model "${targetModel}" is not found or unsupported.`;
              } else {
                descriptiveMessage = `Gemini API client error: ${sanitizeErrorMessage(responseData.slice(0, 150), apiKey)}`;
              }
            } else if (statusCode === 404) {
              errorCategory = 'MODEL_NOT_FOUND';
              mappedStatus = 502;
              descriptiveMessage = `Gemini model "${targetModel}" was not found (HTTP 404). Check GEMINI_MODEL configuration.`;
            } else if (statusCode === 429 || responseData.includes('RESOURCE_EXHAUSTED')) {
              errorCategory = 'QUOTA_EXCEEDED';
              mappedStatus = 429;
              descriptiveMessage = 'Gemini API quota or rate limit exceeded. Please try again later.';
            } else if (statusCode === 503) {
              errorCategory = 'SERVICE_UNAVAILABLE';
              mappedStatus = 503;
              descriptiveMessage = 'Gemini API service temporarily unavailable (HTTP 503). Please try again shortly.';
            } else if (statusCode === 504) {
              errorCategory = 'UPSTREAM_TIMEOUT';
              mappedStatus = 504;
              descriptiveMessage = 'Gemini upstream gateway timed out (HTTP 504). Please try again.';
            } else if (statusCode >= 500) {
              errorCategory = 'UPSTREAM_ERROR';
              mappedStatus = 502;
              descriptiveMessage = `Gemini upstream server error (HTTP ${statusCode}). Please try again.`;
            }

            reject({
              category: errorCategory,
              statusCode: mappedStatus,
              headersReceived,
              upstreamStatusCode,
              ttfb,
              message: descriptiveMessage
            });
          }
        });

        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          cleanupTimers();
          reject({
            category: 'UPSTREAM_ERROR',
            statusCode: 502,
            headersReceived,
            upstreamStatusCode,
            ttfb,
            message: `Gemini response stream error: ${sanitizeErrorMessage(err.message, apiKey)}`
          });
        });
      }
    );

    const handleTimeout = (type) => {
      if (settled) return;
      timedOut = true;
      settled = true;
      cleanupTimers();
      req.destroy();
      const elapsed = Date.now() - reqStartTime;
      const sec = Math.round(timeoutMs / 1000);
      const streamDetail = headersReceived
        ? `Gemini responded with HTTP ${upstreamStatusCode} after ${ttfb}ms, but stream stalled (${elapsed}ms).`
        : `No response headers arrived from Gemini API within ${sec}s (${elapsed}ms).`;

      reject({
        category: 'UPSTREAM_TIMEOUT',
        statusCode: 504,
        timeoutType: type,
        headersReceived,
        upstreamStatusCode,
        ttfb,
        message: `Upstream Gemini API request timed out after ${sec}s. ${streamDetail}`
      });
    };

    req.setTimeout(timeoutMs, () => handleTimeout('socket_idle'));
    overallTimer = setTimeout(() => handleTimeout('total_duration'), timeoutMs);

    if (clientRes) {
      clientRes.on('close', () => {
        if (!settled && !clientRes.writableEnded) {
          settled = true;
          cleanupTimers();
          req.destroy();
          reject({
            category: 'CLIENT_ABORT',
            statusCode: 499,
            headersReceived,
            upstreamStatusCode,
            ttfb,
            message: 'Client closed connection before upstream response finished.'
          });
        }
      });
    }

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      if (timedOut) return;
      reject({
        category: 'NETWORK_ERROR',
        statusCode: 502,
        headersReceived,
        upstreamStatusCode,
        ttfb,
        message: `Connection to Gemini API failed (${err.code || 'UNKNOWN'}): ${sanitizeErrorMessage(err.message, apiKey)}`
      });
    });

    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const clientIp = req.socket?.remoteAddress || 'unknown';
  const reqOrigin = req.headers.origin || '*';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, getCorsHeaders(reqOrigin));
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJsonResponse(res, 200, {
      status: 'UP',
      hasApiKey: Boolean(getGeminiApiKey()),
      model: getGeminiModel()
    }, reqOrigin);
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && req.url === '/api/diagnose') {
    const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp.includes('127.0.0.1');
    if (!isLoopback) {
      sendJsonResponse(res, 403, { error: 'Diagnostic endpoint only available from loopback localhost', category: 'FORBIDDEN' }, reqOrigin);
      return;
    }

    const apiKey = getGeminiApiKey();
    const model = getGeminiModel();
    if (!apiKey) {
      sendJsonResponse(res, 500, {
        status: 'FAIL',
        category: 'CONFIG_ERROR',
        model,
        hasApiKey: false,
        error: 'GEMINI_API_KEY environment variable is not configured on the proxy server.'
      }, reqOrigin);
      return;
    }

    const testStartTime = Date.now();
    const pingPrompt = 'Respond with a valid JSON object matching exactly: {"status": "ok", "message": "ping"}';

    callGeminiApi(pingPrompt, apiKey, model, 15000, req, res)
      .then(({ textContent, usageMetadata, headersReceived, upstreamStatusCode, ttfb }) => {
        let parsed = null;
        try {
          const cleaned = textContent.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
          parsed = JSON.parse(cleaned);
        } catch {
          parsed = { raw: textContent };
        }
        sendJsonResponse(res, 200, {
          status: 'PASS',
          model,
          hasApiKey: true,
          headersReceived,
          upstreamStatusCode,
          ttfbMs: ttfb,
          totalDurationMs: Date.now() - testStartTime,
          usageMetadata,
          parsed
        }, reqOrigin);
      })
      .catch((err) => {
        sendJsonResponse(res, err.statusCode || 502, {
          status: 'FAIL',
          model,
          hasApiKey: true,
          category: err.category || 'INFERENCE_ERROR',
          statusCode: err.statusCode || 502,
          headersReceived: Boolean(err.headersReceived),
          upstreamStatusCode: err.upstreamStatusCode || null,
          ttfbMs: err.ttfb || null,
          totalDurationMs: Date.now() - testStartTime,
          error: sanitizeErrorMessage(err.message, apiKey)
        }, reqOrigin);
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/learn-layout') {
    const startTime = Date.now();
    const requestId = `req_${startTime}_${Math.random().toString(36).slice(2, 6)}`;
    console.log(`[AI-PROXY] [${requestId}] [ARRIVAL] POST /api/learn-layout from IP: ${clientIp}, Origin: ${reqOrigin}`);

    if (!checkRateLimit(clientIp)) {
      console.warn(`[AI-PROXY] [${requestId}] [RATE_LIMIT] Blocked IP: ${clientIp}`);
      sendJsonResponse(res, 429, {
        error: 'Rate limit exceeded (max 30 requests/min). Please try again shortly.',
        category: 'RATE_LIMIT'
      }, reqOrigin);
      return;
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      console.error(`[AI-PROXY] [${requestId}] [ERROR] Category: CONFIG_ERROR - GEMINI_API_KEY environment variable is not configured.`);
      sendJsonResponse(res, 500, {
        error: 'GEMINI_API_KEY environment variable is not configured on the proxy server.',
        category: 'CONFIG_ERROR'
      }, reqOrigin);
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
        console.warn(`[AI-PROXY] [${requestId}] [ERROR] Category: PAYLOAD_TOO_LARGE`);
        sendJsonResponse(res, 413, { error: 'Payload exceeds 100KB limit', category: 'PAYLOAD_TOO_LARGE' }, reqOrigin);
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
        console.warn(`[AI-PROXY] [${requestId}] [ERROR] Category: INVALID_JSON`);
        sendJsonResponse(res, 400, { error: 'Invalid JSON request body', category: 'INVALID_JSON' }, reqOrigin);
        return;
      }

      const { hostname, pageTitle, candidateSelectors, diagnostics, domSnippets, feedback } = payload;

      if (!hostname || typeof hostname !== 'string' || hostname.length > 150) {
        console.warn(`[AI-PROXY] [${requestId}] [ERROR] Category: VALIDATION_ERROR - Invalid hostname`);
        sendJsonResponse(res, 400, { error: 'Invalid or missing hostname parameter', category: 'VALIDATION_ERROR' }, reqOrigin);
        return;
      }

      if (!domSnippets || !Array.isArray(domSnippets) || domSnippets.length === 0 || domSnippets.length > 5) {
        console.warn(`[AI-PROXY] [${requestId}] [ERROR] Category: VALIDATION_ERROR - Invalid domSnippets count`);
        sendJsonResponse(res, 400, { error: 'domSnippets must be an array with 1 to 5 elements', category: 'VALIDATION_ERROR' }, reqOrigin);
        return;
      }

      let totalSnippetChars = 0;
      for (const snip of domSnippets) {
        if (typeof snip !== 'string') {
          sendJsonResponse(res, 400, { error: 'Each DOM snippet must be a string', category: 'VALIDATION_ERROR' }, reqOrigin);
          return;
        }
        totalSnippetChars += snip.length;
      }

      if (totalSnippetChars > 25000) {
        console.warn(`[AI-PROXY] [${requestId}] [ERROR] Category: VALIDATION_ERROR - Snippets exceed 25KB`);
        sendJsonResponse(res, 400, { error: 'Total DOM snippets size exceeds 25KB', category: 'VALIDATION_ERROR' }, reqOrigin);
        return;
      }

      let feedbackSection = '';
      if (feedback && typeof feedback === 'object') {
        const errorList = (feedback.errors || []).map((e) => `- ${e}`).join('\n');
        feedbackSection = `
CORRECTION REQUIRED (Retry attempt ${feedback.attempt || 1}):
The previous layout proposal failed validation on live product cards with the following errors:
${errorList}
Invalid field selectors: ${(feedback.invalidFields || []).join(', ')}
Previous field selectors attempted:
${JSON.stringify(feedback.failedFieldSelectors || {}, null, 2)}

Please re-examine the Sample Card HTML Snippets below and provide corrected selectors:
1. Examine the exact class names, attributes, and hierarchy present in the supplied snippets.
2. Repair the failed fields while preserving valid fields where possible.
3. Avoid tag-specific prefixes unless the HTML structure requires them (e.g. use class or attribute selectors rather than assuming a specific container tag).
4. Check whether the element is a <span>, <p>, <b>, <div>, or contains <s>/<del> strikethrough.
5. Keep selling price and MRP separate. The selling price is what the buyer pays; MRP is the strikethrough original list price. If MRP is not present in the snippets, set mrpSelector to null.
6. Only propose selectors verified by the provided snippet HTML.
`;
      }

      console.log(`[AI-PROXY] [${requestId}] [STAGE] Validated payload for host: "${hostname}", snippets: ${domSnippets.length} (${totalSnippetChars} chars)`);

      const modelName = getGeminiModel();
      console.log(`[AI-PROXY] [${requestId}] [STAGE] Dispatching request to Gemini API (model: ${modelName})...`);

      const prompt = `You are an expert web extraction assistant for an e-commerce search results extractor.
Analyze the provided DOM snippets from "${hostname}" (Page: "${pageTitle || ''}") to deduce precise CSS selectors for product cards and individual fields.

Rules:
1. cardSelector: CSS selector matching each repeating product card container element. Must target the specific repeating product card (e.g. div[data-id], .product-card, .product-grid__item, ._2kHMtA, .slAVV4, .tUxRFH). Never choose outer grid row or column wrappers (such as col-12-12, row, cPHDOP, or container).
2. All fieldSelectors must be relative to each product card container.
3. Derive selectors solely from the current supplied DOM snippets. Never assume a selector based on hostname, prior website versions, memory, training data, or historical examples.
4. Use the exact classes, attributes, and element relationships supported by the provided HTML snippets. Prefer resilient class or attribute selectors supported by the snippet over assuming a specific container tag name, unless structurally required (e.g. "a[href]" for urlSelector, "img" for imageSelector).
5. priceSelector: Select the active selling price that the customer currently pays. Prefer resilient class or attribute selectors (e.g. ".Nx9bqj", ".fabb-price-now", or "[class*=\"price\"]") rather than overly strict tag prefixes like "div.Nx9bqj" which may fail across different tags (div vs span). Do NOT select strikethrough/MRP/original list price.
6. mrpSelector: Select the strikethrough/original/list price element if one exists; return null if unavailable.
7. titleSelector: Select the element containing the product title or name.
8. urlSelector: Select the anchor element (<a href="...">) pointing to the product details page.
9. imageSelector: Select the product thumbnail image element, or return null if unavailable.
10. ratingSelector: Select the element containing rating score/stars if present, otherwise return null.
11. Return null for unavailable optional fields (mrpSelector, imageSelector, ratingSelector).
12. Do not invent or fabricate selectors when the supplied snippets do not provide enough evidence. If the snippets are insufficient, return confidence: 0 with null fields.
${feedbackSection}
Return ONLY a strict JSON object with NO markdown formatting, matching this exact schema:
{
  "cardSelector": "string",
  "fieldSelectors": {
    "titleSelector": "string",
    "urlSelector": "string",
    "priceSelector": "string",
    "imageSelector": "string or null",
    "mrpSelector": "string or null",
    "ratingSelector": "string or null"
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
        const { textContent, usageMetadata } = await callGeminiApi(prompt, apiKey, modelName, getUpstreamTimeoutMs(), req, res);
        const cleanedText = textContent
          .replace(/^\s*```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/i, '')
          .trim();
        const parsedRule = JSON.parse(cleanedText);

        const elapsed = Date.now() - startTime;
        console.log(`[AI-PROXY] [${requestId}] [SUCCESS] HTTP 200 in ${elapsed}ms (prompt tokens: ${usageMetadata?.promptTokenCount || '?'}, candidate tokens: ${usageMetadata?.candidatesTokenCount || '?'})`);

        sendJsonResponse(res, 200, {
          ...parsedRule,
          usageMetadata
        }, reqOrigin);
      } catch (err) {
        const elapsed = Date.now() - startTime;
        const category = err?.category || 'INFERENCE_ERROR';
        const statusCode = err?.statusCode || 502;
        const errMsg = sanitizeErrorMessage(err?.message || 'AI inference failed', apiKey);

        if (category === 'CLIENT_ABORT') {
          console.warn(`[AI-PROXY] [${requestId}] [CLIENT_ABORT] Client closed connection before completion (elapsed: ${elapsed}ms)`);
          return;
        }

        if (category === 'UPSTREAM_TIMEOUT') {
          console.error(`[AI-PROXY] [${requestId}] [TIMEOUT] Category: ${category}, Status: ${statusCode}, Elapsed: ${elapsed}ms, Type: ${err?.timeoutType || 'unknown'} - ${errMsg}`);
        } else {
          console.error(`[AI-PROXY] [${requestId}] [ERROR] Category: ${category}, Status: ${statusCode}, Elapsed: ${elapsed}ms - ${errMsg}`);
        }

        sendJsonResponse(res, statusCode, {
          error: errMsg,
          category
        }, reqOrigin);
      }
    });
    return;
  }

  sendJsonResponse(res, 404, { error: 'Not found', category: 'NOT_FOUND' }, reqOrigin);
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`PIRATES ALERT AI proxy server running on http://localhost:${PORT}`);
  });
}

export async function runGeminiDiagnostic(apiKey = getGeminiApiKey(), model = getGeminiModel(), timeoutMs = 15000) {
  if (!apiKey) {
    return {
      status: 'FAIL',
      category: 'CONFIG_ERROR',
      model,
      hasApiKey: false,
      error: 'GEMINI_API_KEY environment variable is not configured.'
    };
  }

  const startTime = Date.now();
  const pingPrompt = 'Respond with a valid JSON object matching exactly: {"status": "ok", "message": "ping"}';

  try {
    const { textContent, usageMetadata, headersReceived, upstreamStatusCode, ttfb } = await callGeminiApi(pingPrompt, apiKey, model, timeoutMs);
    let parsed = null;
    try {
      const cleaned = textContent.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { raw: textContent };
    }
    return {
      status: 'PASS',
      model,
      hasApiKey: true,
      headersReceived,
      upstreamStatusCode,
      ttfbMs: ttfb,
      totalDurationMs: Date.now() - startTime,
      usageMetadata,
      parsed
    };
  } catch (err) {
    return {
      status: 'FAIL',
      model,
      hasApiKey: true,
      category: err.category || 'INFERENCE_ERROR',
      statusCode: err.statusCode || 502,
      headersReceived: Boolean(err.headersReceived),
      upstreamStatusCode: err.upstreamStatusCode || null,
      ttfbMs: err.ttfb || null,
      totalDurationMs: Date.now() - startTime,
      error: sanitizeErrorMessage(err.message, apiKey)
    };
  }
}

export { server, checkRateLimit, sanitizeErrorMessage, callGeminiApi, getGeminiApiKey, getGeminiModel };
