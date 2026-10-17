import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import { server, sanitizeErrorMessage, runGeminiDiagnostic } from '../server/proxy.js';
import { aiLearning } from '../src/modules/ai/index.js';

function mockHttpsRequest(statusCode, responseBody, triggerTimeout = false, emitError = null, delayMs = 0) {
  return vi.spyOn(https, 'request').mockImplementation((url, options, callback) => {
    const req = new EventEmitter();
    req.write = vi.fn();
    req.end = vi.fn(() => {
      if (emitError) {
        process.nextTick(() => req.emit('error', emitError));
        return;
      }
      if (triggerTimeout) {
        if (req._timeoutHandler) {
          process.nextTick(() => req._timeoutHandler());
        }
        return;
      }
      const res = new EventEmitter();
      res.statusCode = statusCode;
      const sendRes = () => {
        if (callback) callback(res);
        process.nextTick(() => {
          res.emit('data', Buffer.from(responseBody));
          res.emit('end');
        });
      };
      if (delayMs > 0) {
        setTimeout(sendRes, delayMs);
      } else {
        process.nextTick(sendRes);
      }
    });
    req.setTimeout = vi.fn((ms, fn) => {
      req._timeoutHandler = fn;
    });
    req.destroy = vi.fn();
    return req;
  });
}

describe('Proxy Security, Timeouts, and Error Categorization', () => {
  let testPort;
  let baseUrl;
  const originalEnvKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;
  const originalTimeout = process.env.GEMINI_TIMEOUT_MS;

  beforeAll(async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        testPort = server.address().port;
        baseUrl = `http://127.0.0.1:${testPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
    if (originalEnvKey !== undefined) {
      process.env.GEMINI_API_KEY = originalEnvKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (originalModel !== undefined) {
      process.env.GEMINI_MODEL = originalModel;
    } else {
      delete process.env.GEMINI_MODEL;
    }
    if (originalTimeout !== undefined) {
      process.env.GEMINI_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.GEMINI_TIMEOUT_MS;
    }
  });

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-safe-mock-key';
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    aiLearning.setMockProvider(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails safely with HTTP 500 when GEMINI_API_KEY is not configured', async () => {
    delete process.env.GEMINI_API_KEY;

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('GEMINI_API_KEY environment variable is not configured on the proxy server.');
    expect(data.category).toBe('CONFIG_ERROR');
  });

  it('rejects invalid request payloads with HTTP 400 VALIDATION_ERROR', async () => {
    const resNoHost = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domSnippets: ['<div class="card">Item</div>']
      })
    });
    expect(resNoHost.status).toBe(400);
    const dataNoHost = await resNoHost.json();
    expect(dataNoHost.category).toBe('VALIDATION_ERROR');

    const resNoSnippets = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: []
      })
    });
    expect(resNoSnippets.status).toBe(400);
    const dataNoSnippets = await resNoSnippets.json();
    expect(dataNoSnippets.category).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed non-JSON request body with HTTP 400 INVALID_JSON', async () => {
    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not valid json {'
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.category).toBe('INVALID_JSON');
  });

  it('successfully processes valid layout learning request with mocked Gemini upstream', async () => {
    const upstreamJson = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  cardSelector: '.product-card',
                  fieldSelectors: {
                    titleSelector: '.product-title',
                    priceSelector: '.price-tag'
                  },
                  confidence: 0.95
                })
              }
            ]
          }
        }
      ],
      usageMetadata: {
        promptTokenCount: 142,
        candidatesTokenCount: 38
      }
    });

    mockHttpsRequest(200, upstreamJson);

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="product-card"><span class="product-title">Book</span><span class="price-tag">$15</span></div>']
      })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cardSelector).toBe('.product-card');
    expect(data.fieldSelectors.titleSelector).toBe('.product-title');
    expect(data.usageMetadata.promptTokenCount).toBe(142);
  });

  it('successfully handles delayed upstream response within timeout threshold', async () => {
    const upstreamJson = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  cardSelector: '.delayed-card',
                  fieldSelectors: { titleSelector: '.delayed-title' },
                  confidence: 0.92
                })
              }
            ]
          }
        }
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25 }
    });

    mockHttpsRequest(200, upstreamJson, false, null, 40);

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="delayed-card"><span class="delayed-title">Item</span></div>']
      })
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cardSelector).toBe('.delayed-card');
  });

  it('handles upstream 401/403 or invalid key without leaking credentials', async () => {
    const secretKey = 'mock-super-secret-key-12345';
    process.env.GEMINI_API_KEY = secretKey;

    const errorJson = JSON.stringify({
      error: {
        code: 400,
        message: `API_KEY_INVALID: API key ${secretKey} is not valid. Please pass a valid API key.`,
        status: 'INVALID_ARGUMENT'
      }
    });

    mockHttpsRequest(400, errorJson);

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.category).toBe('AUTHENTICATION_ERROR');
    expect(data.error).toBe('Gemini API authentication failed: Invalid or unauthorized API key.');
    expect(data.error).not.toContain(secretKey);
    expect(JSON.stringify(data)).not.toContain(secretKey);
  });

  it('maps upstream HTTP 404 to MODEL_NOT_FOUND', async () => {
    mockHttpsRequest(404, 'models/gemini-invalid is not found');

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.category).toBe('MODEL_NOT_FOUND');
    expect(data.error).toContain('was not found');
  });

  it('returns HTTP 429 when upstream quota is exceeded', async () => {
    const quotaJson = JSON.stringify({
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED'
      }
    });

    mockHttpsRequest(429, quotaJson);

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.category).toBe('QUOTA_EXCEEDED');
    expect(data.error).toContain('Gemini API quota or rate limit exceeded');
  });

  it('returns HTTP 504 on upstream Gemini request timeout', async () => {
    mockHttpsRequest(200, '', true);

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(504);
    const data = await res.json();
    expect(data.category).toBe('UPSTREAM_TIMEOUT');
    expect(data.error).toMatch(/Upstream Gemini API request timed out after \d+s/);
  });

  it('maps upstream HTTP 503 to SERVICE_UNAVAILABLE', async () => {
    mockHttpsRequest(503, 'The service is temporarily overloaded.');

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.category).toBe('SERVICE_UNAVAILABLE');
    expect(data.error).toContain('service temporarily unavailable');
  });

  it('maps generic upstream HTTP 500 to UPSTREAM_ERROR', async () => {
    mockHttpsRequest(500, 'Internal Server Error in Gemini core');

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.category).toBe('UPSTREAM_ERROR');
    expect(data.error).toContain('Gemini upstream server error');
  });

  it('returns HTTP 502 when upstream returns malformed non-JSON data', async () => {
    mockHttpsRequest(200, 'Bad Gateway Error: HTML content from upstream load balancer');

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.category).toBe('MALFORMED_UPSTREAM');
    expect(data.error).toContain('Failed to parse Gemini response');
  });

  it('handles socket and network connection errors cleanly', async () => {
    const netErr = new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com');
    netErr.code = 'ENOTFOUND';
    mockHttpsRequest(200, '', false, netErr);

    const res = await fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      })
    });

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.category).toBe('NETWORK_ERROR');
    expect(data.error).toContain('Connection to Gemini API failed (ENOTFOUND)');
  });

  it('handles client cancellation by destroying upstream request cleanly', async () => {
    let capturedReq = null;
    vi.spyOn(https, 'request').mockImplementation((url, options, callback) => {
      const req = new EventEmitter();
      req.write = vi.fn();
      req.end = vi.fn();
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      capturedReq = req;
      return req;
    });

    const controller = new AbortController();
    const fetchPromise = fetch(`${baseUrl}/api/learn-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: 'example.com',
        domSnippets: ['<div class="card">Item</div>']
      }),
      signal: controller.signal
    }).catch((err) => err);

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await fetchPromise;

    expect(capturedReq).not.toBeNull();
    await vi.waitFor(() => expect(capturedReq.destroy).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('handles connection refusal cleanly and returns actionable guidance', async () => {
    aiLearning.setProxyUrl('http://127.0.0.1:59998/api/learn-layout');

    const result = await aiLearning.learnLayout({
      hostname: 'store.test',
      domSnippets: ['<div class="item">Sample</div>']
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot connect to AI proxy server');
    expect(result.error).toContain('npm run server');
  });

  it('handles extension request client-side timeout gracefully', async () => {
    const hangingReq = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    aiLearning.setProxyUrl(`${baseUrl}/api/learn-layout`);
    const result = await aiLearning.learnLayout({
      hostname: 'timeout.test',
      domSnippets: ['<div class="item">Sample</div>']
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    hangingReq.mockRestore();
  });

  it('sanitizes API keys and sensitive tokens from error messages', () => {
    const secret = 'AIzaSyDemoSecretKeyForTesting123';
    const textWithSecret = `Error occurred with key=${secret} while processing request`;
    const sanitized = sanitizeErrorMessage(textWithSecret, secret);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain('[REDACTED]');
  });

  it('successfully executes loopback diagnostic probe endpoint /api/diagnose', async () => {
    const pingResponse = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ status: 'ok', message: 'ping' }) }]
          }
        }
      ],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 5 }
    });

    mockHttpsRequest(200, pingResponse);

    const res = await fetch(`${baseUrl}/api/diagnose`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('PASS');
    expect(data.hasApiKey).toBe(true);
    expect(data.parsed.status).toBe('ok');
    expect(data.parsed.message).toBe('ping');
  });
});
