import { normalizeText, parseCurrencyAndPrice, parseRating } from '../extractor/utils.js';

const STORAGE_KEY = 'pirates_alert_regression_fixtures';
const MAX_FIXTURES = 20;
const MAX_FIXTURE_CHARS = 25000;

let inMemoryFixtures = [];

function isChromeStorageAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
}

async function readFixturesStorage() {
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        if (chrome.runtime?.lastError) {
          resolve(inMemoryFixtures);
          return;
        }
        const data = res?.[STORAGE_KEY];
        if (Array.isArray(data)) {
          resolve(data);
          return;
        }
        resolve(inMemoryFixtures);
      });
    });
  }
  return [...inMemoryFixtures];
}

async function writeFixturesStorage(data) {
  const bounded = (data || []).slice(-MAX_FIXTURES);
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: bounded }, () => {
        if (chrome.runtime?.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
  inMemoryFixtures = bounded;
  return true;
}

export function sanitizeHtmlSnippet(html = '') {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .trim();
}

export function compareFieldValues(field, actual, expected) {
  if (expected === null || expected === undefined) {
    return { matches: true };
  }

  if (actual === null || actual === undefined) {
    return {
      matches: false,
      reason: `${field.charAt(0).toUpperCase() + field.slice(1)} mismatch: expected "${expected}", received null`
    };
  }

  switch (field) {
    case 'title': {
      const actNorm = normalizeText(String(actual)).toLowerCase();
      const expNorm = normalizeText(String(expected)).toLowerCase();
      if (actNorm === expNorm || actNorm.includes(expNorm) || expNorm.includes(actNorm)) {
        return { matches: true };
      }
      return {
        matches: false,
        reason: `Title mismatch: expected "${expected}", received "${actual}"`
      };
    }

    case 'selling_price':
    case 'mrp': {
      const actNum = typeof actual === 'number' ? actual : parseFloat(actual);
      const expNum = typeof expected === 'number' ? expected : parseFloat(expected);
      if (Number.isFinite(actNum) && Number.isFinite(expNum) && Math.abs(actNum - expNum) < 0.01) {
        return { matches: true };
      }
      return {
        matches: false,
        reason: `${field} mismatch: expected ${expected}, received ${actual}`
      };
    }

    case 'rating': {
      const actNum = typeof actual === 'number' ? actual : parseFloat(actual);
      const expNum = typeof expected === 'number' ? expected : parseFloat(expected);
      if (Number.isFinite(actNum) && Number.isFinite(expNum) && Math.abs(actNum - expNum) <= 0.1) {
        return { matches: true };
      }
      return {
        matches: false,
        reason: `Rating mismatch: expected ${expected}, received ${actual}`
      };
    }

    case 'rating_count':
    case 'review_count': {
      if (parseInt(actual, 10) === parseInt(expected, 10)) {
        return { matches: true };
      }
      return {
        matches: false,
        reason: `${field} mismatch: expected ${expected}, received ${actual}`
      };
    }

    case 'product_url':
    case 'image_url': {
      const actStr = String(actual).toLowerCase().trim().replace(/\/$/, '');
      const expStr = String(expected).toLowerCase().trim().replace(/\/$/, '');
      if (actStr === expStr || actStr.endsWith(expStr) || expStr.endsWith(actStr)) {
        return { matches: true };
      }
      return {
        matches: false,
        reason: `${field} URL mismatch: expected "${expected}", received "${actual}"`
      };
    }

    default: {
      if (String(actual).trim() === String(expected).trim()) {
        return { matches: true };
      }
      return {
        matches: false,
        reason: `${field} mismatch: expected "${expected}", received "${actual}"`
      };
    }
  }
}

export function extractFieldsFromCardElement(cardEl, fieldSelectors = {}) {
  let title = null;
  if (fieldSelectors.titleSelector) {
    try {
      const el = cardEl.querySelector(fieldSelectors.titleSelector);
      if (el) title = normalizeText(el.textContent);
    } catch {}
  }

  let selling_price = null;
  let currency = null;
  if (fieldSelectors.priceSelector) {
    try {
      const el = cardEl.querySelector(fieldSelectors.priceSelector);
      if (el) {
        const parsed = parseCurrencyAndPrice(el.textContent);
        selling_price = parsed.price;
        currency = parsed.currency;
      }
    } catch {}
  }

  let mrp = null;
  if (fieldSelectors.mrpSelector) {
    try {
      const el = cardEl.querySelector(fieldSelectors.mrpSelector);
      if (el) {
        const parsed = parseCurrencyAndPrice(el.textContent);
        mrp = parsed.price;
      }
    } catch {}
  }

  let product_url = null;
  if (fieldSelectors.urlSelector) {
    try {
      const el = cardEl.querySelector(fieldSelectors.urlSelector);
      if (el) {
        product_url = el.getAttribute('href') || null;
      }
    } catch {}
  }

  let image_url = null;
  if (fieldSelectors.imageSelector) {
    try {
      const el = cardEl.querySelector(fieldSelectors.imageSelector);
      if (el) {
        image_url = el.getAttribute('src') || el.getAttribute('data-src') || null;
      }
    } catch {}
  }

  let rating = null;
  if (fieldSelectors.ratingSelector) {
    try {
      const el = cardEl.querySelector(fieldSelectors.ratingSelector);
      if (el) {
        rating = parseRating(el);
      }
    } catch {}
  }

  return {
    title,
    selling_price,
    mrp,
    currency,
    product_url,
    image_url,
    rating
  };
}

export function evaluateRuleOnFixture(rule, fixture, createDocFn) {
  const failures = [];
  let checksAttempted = 0;
  let checksPassed = 0;

  if (!fixture || !Array.isArray(fixture.sampleCards) || fixture.sampleCards.length === 0) {
    return { passed: true, failures: [], score: 100 };
  }

  const containerHtml = `<html><body><div id="fixture-root">${fixture.sampleCards.join('\n')}</div></body></html>`;
  const doc = createDocFn ? createDocFn(containerHtml) : null;
  if (!doc) {
    return { passed: false, failures: ['Cannot parse fixture DOM document'], score: 0 };
  }

  let matchedCards = [];
  try {
    matchedCards = Array.from(doc.querySelectorAll(rule.cardSelector));
  } catch (err) {
    return {
      passed: false,
      failures: [`Card selector threw exception on fixture: ${err.message}`],
      score: 0
    };
  }

  if (matchedCards.length === 0) {
    return {
      passed: false,
      failures: [`Card selector "${rule.cardSelector}" matched 0 cards on fixture for layout ${fixture.layoutFingerprint}`],
      score: 0
    };
  }

  const expectedList = fixture.expectedItems || [];
  const countToTest = Math.min(matchedCards.length, expectedList.length);

  for (let i = 0; i < countToTest; i++) {
    const cardEl = matchedCards[i];
    const expected = expectedList[i];
    if (!expected) continue;

    const extracted = extractFieldsFromCardElement(cardEl, rule.fieldSelectors || {});

    for (const [field, expectedVal] of Object.entries(expected)) {
      if (expectedVal === null || expectedVal === undefined) continue;
      if (field === 'currency' || field === 'extra' || field === 'product_id') continue;

      checksAttempted += 1;
      const actualVal = extracted[field];
      const comp = compareFieldValues(field, actualVal, expectedVal);
      if (comp.matches) {
        checksPassed += 1;
      } else {
        failures.push(`Card ${i + 1}: ${comp.reason}`);
      }
    }
  }

  const score = checksAttempted > 0 ? Math.round((checksPassed / checksAttempted) * 100) : 100;
  const passed = failures.length === 0;

  return {
    passed,
    failures,
    score,
    checksAttempted,
    checksPassed
  };
}

export function createRegressionRepository() {
  return {
    async getAllFixtures() {
      return await readFixturesStorage();
    },

    async getFixturesForLayout(hostname, layoutFingerprint) {
      const list = await readFixturesStorage();
      return list.filter(
        (f) => f.hostname === hostname && f.layoutFingerprint === layoutFingerprint
      );
    },

    async saveFixture(fixture) {
      if (!fixture || !fixture.hostname || !fixture.layoutFingerprint) {
        return { success: false, error: 'Invalid fixture payload' };
      }

      const sampleCards = (fixture.sampleCards || []).slice(0, 3).map((html) => sanitizeHtmlSnippet(html));
      const totalChars = sampleCards.reduce((acc, c) => acc + c.length, 0);
      if (totalChars > MAX_FIXTURE_CHARS) {
        return { success: false, error: 'Sanitized fixture exceeds 25KB character limit' };
      }

      const record = {
        id: `fix_${fixture.hostname}_${fixture.layoutFingerprint}_${Date.now()}`,
        hostname: fixture.hostname,
        layoutFingerprint: fixture.layoutFingerprint,
        ruleId: fixture.ruleId || null,
        ruleVersion: fixture.ruleVersion || 1,
        createdAt: new Date().toISOString(),
        sampleCards,
        expectedItems: (fixture.expectedItems || []).slice(0, 3)
      };

      const list = await readFixturesStorage();
      const filtered = list.filter(
        (f) => !(f.hostname === record.hostname && f.layoutFingerprint === record.layoutFingerprint)
      );
      filtered.push(record);
      const ok = await writeFixturesStorage(filtered);
      return { success: ok, fixture: record };
    },

    async runRegressionOnCandidate(ruleCandidate, createDocFn) {
      if (!ruleCandidate || !ruleCandidate.hostname || !ruleCandidate.layoutFingerprint) {
        return { passed: true, testedFixturesCount: 0, failures: [] };
      }

      const matchingFixtures = await this.getFixturesForLayout(
        ruleCandidate.hostname,
        ruleCandidate.layoutFingerprint
      );

      if (matchingFixtures.length === 0) {
        return {
          passed: true,
          testedFixturesCount: 0,
          failures: [],
          message: 'No regression fixtures recorded for this layout.'
        };
      }

      const allFailures = [];
      let totalPassed = true;

      for (const fix of matchingFixtures) {
        const result = evaluateRuleOnFixture(ruleCandidate, fix, createDocFn);
        if (!result.passed) {
          totalPassed = false;
          allFailures.push(...result.failures);
        }
      }

      return {
        passed: totalPassed,
        testedFixturesCount: matchingFixtures.length,
        failures: allFailures
      };
    },

    async clearAllFixtures() {
      inMemoryFixtures = [];
      if (isChromeStorageAvailable()) {
        return new Promise((resolve) => {
          chrome.storage.local.remove([STORAGE_KEY], () => resolve(true));
        });
      }
      return true;
    }
  };
}

export const regressionRepository = createRegressionRepository();
