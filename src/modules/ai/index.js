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
    model: entry.model || 'gemini-1.5-flash',
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

export function validateAiRuleResponse(parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object') {
    return { valid: false, error: 'AI response is not a valid JSON object' };
  }

  const cardSelector = parsedJson.cardSelector;
  if (!cardSelector || typeof cardSelector !== 'string' || cardSelector.trim().length < 2) {
    return { valid: false, error: 'AI response missing valid cardSelector' };
  }

  if (cardSelector.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) {
    return { valid: false, error: 'Unsafe code detected in cardSelector' };
  }

  const fieldSelectors = parsedJson.fieldSelectors || {};
  for (const [key, sel] of Object.entries(fieldSelectors)) {
    if (typeof sel !== 'string') {
      return { valid: false, error: `Invalid selector type for field ${key}` };
    }
    if (sel.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) {
      return { valid: false, error: `Unsafe code detected in field selector ${key}` };
    }
  }

  return {
    valid: true,
    rule: {
      cardSelector: cardSelector.trim(),
      fieldSelectors,
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
    setMockProvider(fn) {
      mockProvider = fn;
    },
    async learnLayout(context = {}) {
      const { hostname, pageTitle, candidateSelectors, diagnostics, domSnippets, callReason } = context;

      const sanitizedSnippets = (domSnippets || []).slice(0, 2).map((s) => sanitizeDomSnippet(s));
      const payload = {
        hostname: hostname || 'unknown',
        pageTitle: pageTitle || '',
        candidateSelectors: candidateSelectors || [],
        diagnostics: diagnostics || {},
        domSnippets: sanitizedSnippets
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

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const response = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadString,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errBody = await response.text();
          await recordAiLog({
            hostname,
            callReason: callReason || 'layout_learning_proxy',
            status: 'FAILED',
            payloadChars: payloadString.length,
            responseChars: errBody.length,
            inputEstimated: true,
            outputEstimated: true
          });
          return { success: false, error: `Proxy returned status ${response.status}: ${errBody.slice(0, 100)}` };
        }

        const data = await response.json();
        const validation = validateAiRuleResponse(data);
        if (!validation.valid) {
          await recordAiLog({
            hostname,
            callReason: callReason || 'layout_learning_proxy',
            status: 'FAILED',
            payloadChars: payloadString.length,
            responseChars: JSON.stringify(data).length,
            inputEstimated: true,
            outputEstimated: true
          });
          return { success: false, error: validation.error };
        }

        const promptTokens = data.usageMetadata?.promptTokenCount;
        const candidateTokens = data.usageMetadata?.candidatesTokenCount;

        await recordAiLog({
          hostname,
          callReason: callReason || 'layout_learning_proxy',
          status: 'SUCCESS',
          payloadChars: payloadString.length,
          responseChars: JSON.stringify(data).length,
          inputTokens: promptTokens,
          outputTokens: candidateTokens,
          inputEstimated: typeof promptTokens !== 'number',
          outputEstimated: typeof candidateTokens !== 'number'
        });

        return { success: true, proposedRule: validation.rule };
      } catch (err) {
        await recordAiLog({
          hostname,
          callReason: callReason || 'layout_learning_proxy',
          status: 'ERROR',
          payloadChars: payloadString.length,
          responseChars: 0,
          inputEstimated: true,
          outputEstimated: true
        });
        return {
          success: false,
          error: `AI proxy connection failed (${err.name === 'AbortError' ? 'timeout' : err.message}). Please ensure the local AI proxy server is running.`
        };
      }
    }
  };
}

export const aiLearning = createAiLearningModule();
