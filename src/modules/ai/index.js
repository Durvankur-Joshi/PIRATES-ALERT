const LOGS_STORAGE_KEY = 'pirates_alert_ai_logs';

let inMemoryLogs = [];

function isChromeStorageAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
}

export async function getAiLogs() {
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.get([LOGS_STORAGE_KEY], (res) => {
        if (chrome.runtime?.lastError) {
          resolve(inMemoryLogs);
          return;
        }
        resolve(res?.[LOGS_STORAGE_KEY] || []);
      });
    });
  }
  return [...inMemoryLogs];
}

export async function recordAiLog(entry = {}) {
  const hasInputCount = typeof entry.inputTokens === 'number';
  const hasOutputCount = typeof entry.outputTokens === 'number';

  const inputEstimated = entry.inputEstimated !== undefined ? Boolean(entry.inputEstimated) : !hasInputCount;
  const outputEstimated = entry.outputEstimated !== undefined ? Boolean(entry.outputEstimated) : !hasOutputCount;

  const finalInputTokens = hasInputCount
    ? entry.inputTokens
    : Math.round((entry.payloadChars || 0) / 4);

  const finalOutputTokens = hasOutputCount
    ? entry.outputTokens
    : Math.round((entry.responseChars || 0) / 4);

  const isEstimated = inputEstimated || outputEstimated;

  let estimationMethod = 'provider_reported';
  if (inputEstimated && outputEstimated) {
    estimationMethod = '4_chars_per_token_heuristic';
  } else if (inputEstimated) {
    estimationMethod = 'input_estimated_output_reported';
  } else if (outputEstimated) {
    estimationMethod = 'input_reported_output_estimated';
  }

  const logRecord = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    hostname: entry.hostname || 'unknown',
    callReason: entry.callReason || 'layout_learning',
    status: entry.status || 'SUCCESS',
    model: entry.model || 'gemini-2.5-flash',
    inputTokens: finalInputTokens,
    outputTokens: finalOutputTokens,
    inputEstimated,
    outputEstimated,
    isEstimated,
    estimationMethod
  };

  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.get([LOGS_STORAGE_KEY], (res) => {
        const existing = res?.[LOGS_STORAGE_KEY] || [];
        const updated = [logRecord, ...existing].slice(0, 50);
        chrome.storage.local.set({ [LOGS_STORAGE_KEY]: updated }, () => {
          resolve(logRecord);
        });
      });
    });
  }

  inMemoryLogs = [logRecord, ...inMemoryLogs].slice(0, 50);
  return logRecord;
}

export async function clearAiLogs() {
  inMemoryLogs = [];
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.remove([LOGS_STORAGE_KEY], () => resolve(true));
    });
  }
  return true;
}

export function sanitizeDomSnippet(rawHtml, maxLength = 2500) {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return '';
  }

  let cleaned = rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    .replace(/data:image\/[^;]+;base64,[^"'\s]+/gi, 'data:image/...');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength) + '...';
  }
  return cleaned;
}

function testSelectorSyntax(selector) {
  if (!selector || typeof selector !== 'string') return false;
  const trimmed = selector.trim();
  if (trimmed.length < 1 || trimmed.length > 250) return false;
  if (trimmed.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) return false;

  const openBrackets = (trimmed.match(/\[/g) || []).length;
  const closeBrackets = (trimmed.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) return false;

  const openParens = (trimmed.match(/\(/g) || []).length;
  const closeParens = (trimmed.match(/\)/g) || []).length;
  if (openParens !== closeParens) return false;

  if (trimmed.startsWith(',') || trimmed.endsWith(',') || trimmed.endsWith('>') || trimmed.endsWith('+') || trimmed.endsWith('~')) {
    return false;
  }

  if (trimmed.match(/:::[a-z]|^\.{3,}|^#{2,}/i)) {
    return false;
  }

  if (typeof document !== 'undefined') {
    try {
      if (typeof document.createDocumentFragment === 'function') {
        const frag = document.createDocumentFragment();
        frag.querySelector(trimmed);
        return true;
      }
      if (typeof document.querySelector === 'function') {
        document.querySelector(trimmed);
        return true;
      }
    } catch {
      return false;
    }
  } else if (typeof globalThis !== 'undefined' && globalThis.document) {
    try {
      globalThis.document.querySelector(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export function validateAiRuleResponse(parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    return { valid: false, error: 'AI response is not a valid JSON object' };
  }

  const cardSelector = parsedJson.cardSelector;
  if (!cardSelector || typeof cardSelector !== 'string' || cardSelector.trim().length < 2) {
    return { valid: false, error: 'AI response missing valid cardSelector' };
  }

  if (cardSelector.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) {
    return { valid: false, error: 'Unsafe code detected in cardSelector' };
  }

  if (!testSelectorSyntax(cardSelector)) {
    return { valid: false, error: `Card selector has invalid CSS syntax: "${cardSelector}"` };
  }

  if (!parsedJson.fieldSelectors || typeof parsedJson.fieldSelectors !== 'object' || Array.isArray(parsedJson.fieldSelectors)) {
    return { valid: false, error: 'AI response missing valid fieldSelectors' };
  }

  const rawFieldSelectors = parsedJson.fieldSelectors;
  const normalizedFieldSelectors = {};

  const requiredFields = ['titleSelector', 'priceSelector', 'urlSelector'];
  const knownOptionalFields = [
    'mrpSelector',
    'imageSelector',
    'ratingSelector',
    'ratingCountSelector',
    'reviewCountSelector'
  ];

  for (const reqKey of requiredFields) {
    const val = rawFieldSelectors[reqKey];
    if (typeof val !== 'string' || val.trim().length === 0) {
      return { valid: false, error: `Missing or invalid required field selector: ${reqKey}` };
    }
    if (val.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) {
      return { valid: false, error: `Unsafe code detected in field selector ${reqKey}` };
    }
    if (!testSelectorSyntax(val)) {
      return { valid: false, error: `Field selector "${reqKey}" has invalid CSS syntax: "${val}"` };
    }
    normalizedFieldSelectors[reqKey] = val.trim();
  }

  for (const [key, val] of Object.entries(rawFieldSelectors)) {
    if (requiredFields.includes(key)) continue;

    if (val === null || val === undefined || (typeof val === 'string' && val.trim().length === 0)) {
      normalizedFieldSelectors[key] = null;
    } else if (typeof val === 'string') {
      if (val.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) {
        return { valid: false, error: `Unsafe code detected in field selector ${key}` };
      }
      if (!testSelectorSyntax(val)) {
        return { valid: false, error: `Field selector "${key}" has invalid CSS syntax: "${val}"` };
      }
      normalizedFieldSelectors[key] = val.trim();
    } else {
      return { valid: false, error: `Invalid selector type for field ${key}` };
    }
  }

  for (const optKey of knownOptionalFields) {
    if (!(optKey in normalizedFieldSelectors)) {
      normalizedFieldSelectors[optKey] = null;
    }
  }

  return {
    valid: true,
    rule: {
      cardSelector: cardSelector.trim(),
      fieldSelectors: normalizedFieldSelectors,
      confidence: typeof parsedJson.confidence === 'number' ? parsedJson.confidence : 0.8
    }
  };
}

export function createAiLearningModule(configuration = {}) {
  let proxyUrl = configuration.proxyUrl || 'http://localhost:3001/api/learn-layout';
  let mockProvider = configuration.mockProvider || null;

  return {
    setProxyUrl(url) {
      proxyUrl = url;
    },
    getProxyUrl() {
      return proxyUrl;
    },
    setMockProvider(fn) {
      mockProvider = fn;
    },
    async learnLayout(context = {}) {
      const { hostname, pageTitle, candidateSelectors, diagnostics, domSnippets, callReason, feedback } = context;

      const sanitizedSnippets = (domSnippets || []).slice(0, 2).map((s) => sanitizeDomSnippet(s));
      const payload = {
        hostname: hostname || 'unknown',
        pageTitle: pageTitle || '',
        candidateSelectors: candidateSelectors || [],
        diagnostics: diagnostics || {},
        domSnippets: sanitizedSnippets,
        feedback: feedback || null
      };

      const payloadString = JSON.stringify(payload);

      if (mockProvider) {
        try {
          const rawResponse = await mockProvider(payload);
          const validation = validateAiRuleResponse(rawResponse);
          if (!validation.valid) {
            await recordAiLog({
              hostname,
              callReason: callReason || 'mock_layout_learning',
              status: 'FAILED',
              payloadChars: payloadString.length,
              responseChars: 0,
              inputEstimated: true,
              outputEstimated: true
            });
            return { success: false, error: validation.error };
          }

          const reportedIn = rawResponse.usageMetadata?.promptTokenCount;
          const reportedOut = rawResponse.usageMetadata?.candidatesTokenCount;

          await recordAiLog({
            hostname,
            callReason: callReason || 'mock_layout_learning',
            status: 'SUCCESS',
            payloadChars: payloadString.length,
            responseChars: JSON.stringify(rawResponse).length,
            inputTokens: reportedIn,
            outputTokens: reportedOut,
            inputEstimated: typeof reportedIn !== 'number',
            outputEstimated: typeof reportedOut !== 'number'
          });
          return { success: true, proposedRule: validation.rule };
        } catch (err) {
          await recordAiLog({
            hostname,
            callReason: callReason || 'mock_layout_learning',
            status: 'ERROR',
            payloadChars: payloadString.length,
            responseChars: 0,
            inputEstimated: true,
            outputEstimated: true
          });
          return { success: false, error: err?.message || 'Mock provider failed' };
        }
      }

      let responseData = null;
      let responseStatus = 200;
      let responseOk = true;
      let rawError = null;

      const PROXY_CLIENT_TIMEOUT_MS = 55000;

      if (typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.sendMessage && !chrome.tabs)) {
        try {
          const bgResponse = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: 'PIRATES_ALERT_PROXY_FETCH',
                url: proxyUrl,
                payloadString,
                timeoutMs: PROXY_CLIENT_TIMEOUT_MS
              },
              (res) => {
                if (chrome.runtime?.lastError) {
                  resolve(null);
                } else {
                  resolve(res);
                }
              }
            );
          });
          if (bgResponse && bgResponse.handled) {
            responseOk = bgResponse.ok;
            responseStatus = bgResponse.status;
            if (bgResponse.ok) {
              try {
                responseData = JSON.parse(bgResponse.text);
              } catch (e) {
                rawError = 'Failed to parse JSON response from proxy';
                responseOk = false;
              }
            } else {
              if (bgResponse.error === 'timeout') {
                rawError = 'Request timed out after 55s. The proxy or upstream service took too long to respond.';
              } else {
                rawError = bgResponse.error || bgResponse.text;
                try {
                  const parsedErr = JSON.parse(bgResponse.text);
                  if (parsedErr?.error) {
                    rawError = parsedErr.error;
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }

      if (responseData === null && rawError === null) {
        let timeoutId;
        try {
          const controller = new AbortController();
          timeoutId = setTimeout(() => controller.abort(), PROXY_CLIENT_TIMEOUT_MS);

          const response = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payloadString,
            signal: controller.signal
          });

          responseOk = response.ok;
          responseStatus = response.status;

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            try {
              const errJson = JSON.parse(errText);
              rawError = errJson?.error || `Proxy error (HTTP ${response.status})`;
            } catch {
              rawError = errText.slice(0, 150) || `Proxy returned HTTP ${response.status}`;
            }
          } else {
            responseData = await response.json();
          }
        } catch (err) {
          responseOk = false;
          let detail = err.message || '';
          if (err.name === 'AbortError') {
            detail = 'Request timed out after 55s. The proxy or upstream service took too long to respond.';
          } else if (err.message?.includes('Failed to fetch') || err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed') || err.cause?.code === 'ECONNREFUSED') {
            detail = `Cannot connect to AI proxy server at ${proxyUrl}. Please ensure the local AI proxy server is running (npm run server).`;
          }
          rawError = `AI proxy connection failed: ${detail}`;
          await recordAiLog({
            hostname,
            callReason: callReason || 'layout_learning_proxy',
            status: 'ERROR',
            payloadChars: payloadString.length,
            responseChars: 0,
            inputEstimated: true,
            outputEstimated: true
          });
          return { success: false, error: rawError };
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }

      if (!responseOk || !responseData) {
        const finalError = rawError || `Proxy request failed with HTTP ${responseStatus}`;
        await recordAiLog({
          hostname,
          callReason: callReason || 'layout_learning_proxy',
          status: 'FAILED',
          payloadChars: payloadString.length,
          responseChars: finalError.length,
          inputEstimated: true,
          outputEstimated: true
        });
        return { success: false, error: finalError };
      }

      const validation = validateAiRuleResponse(responseData);
      if (!validation.valid) {
        await recordAiLog({
          hostname,
          callReason: callReason || 'layout_learning_proxy',
          status: 'FAILED',
          payloadChars: payloadString.length,
          responseChars: JSON.stringify(responseData).length,
          inputEstimated: true,
          outputEstimated: true
        });
        return { success: false, error: validation.error };
      }

      const promptTokens = responseData.usageMetadata?.promptTokenCount;
      const candidateTokens = responseData.usageMetadata?.candidatesTokenCount;

      await recordAiLog({
        hostname,
        callReason: callReason || 'layout_learning_proxy',
        status: 'SUCCESS',
        payloadChars: payloadString.length,
        responseChars: JSON.stringify(responseData).length,
        inputTokens: promptTokens,
        outputTokens: candidateTokens,
        inputEstimated: typeof promptTokens !== 'number',
        outputEstimated: typeof candidateTokens !== 'number'
      });

      return { success: true, proposedRule: validation.rule };
    }
  };
}

export const aiLearning = createAiLearningModule();
