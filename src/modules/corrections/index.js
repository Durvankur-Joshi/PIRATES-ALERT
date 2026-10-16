import { normalizeText, parseCurrencyAndPrice } from '../extractor/utils.js';

const STORAGE_KEY = 'pirates_alert_corrections';
const MAX_STORED_CORRECTIONS = 100;

let inMemoryCorrections = [];

function isChromeStorageAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
}

async function readCorrectionsStorage() {
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        if (chrome.runtime?.lastError) {
          resolve(inMemoryCorrections);
          return;
        }
        const data = res?.[STORAGE_KEY];
        if (Array.isArray(data)) {
          resolve(data);
          return;
        }
        resolve(inMemoryCorrections);
      });
    });
  }
  return [...inMemoryCorrections];
}

async function writeCorrectionsStorage(data) {
  const bounded = (data || []).slice(-MAX_STORED_CORRECTIONS);
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
  inMemoryCorrections = bounded;
  return true;
}

export function validateFieldValue(field, rawValue) {
  if (field === 'title') {
    if (rawValue === null || rawValue === undefined) {
      return { valid: false, error: 'Title cannot be empty', value: null };
    }
    const str = String(rawValue).trim();
    if (str.length < 1) {
      return { valid: false, error: 'Title cannot be empty', value: null };
    }
    return { valid: true, value: str };
  }

  if (rawValue === null || rawValue === undefined) {
    return { valid: true, value: null };
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '') {
      return { valid: true, value: null };
    }
  }

  switch (field) {

    case 'selling_price':
    case 'mrp': {
      if (typeof rawValue === 'number') {
        if (Number.isFinite(rawValue) && rawValue >= 0) {
          return { valid: true, value: rawValue };
        }
        return { valid: false, error: `${field} must be a non-negative number`, value: null };
      }
      const parsed = parseCurrencyAndPrice(String(rawValue));
      if (parsed.price !== null && parsed.price >= 0) {
        return { valid: true, value: parsed.price };
      }
      const num = parseFloat(String(rawValue).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(num) && num >= 0) {
        return { valid: true, value: num };
      }
      return { valid: false, error: `Invalid numeric value for ${field}`, value: null };
    }

    case 'currency': {
      const cur = String(rawValue).trim();
      if (cur.length > 8) {
        return { valid: false, error: 'Currency code or symbol too long', value: null };
      }
      return { valid: true, value: cur || null };
    }

    case 'product_url':
    case 'image_url': {
      const urlStr = String(rawValue).trim();
      if (urlStr.startsWith('http://') || urlStr.startsWith('https://') || urlStr.startsWith('/')) {
        return { valid: true, value: urlStr };
      }
      try {
        new URL(urlStr);
        return { valid: true, value: urlStr };
      } catch {
        return { valid: false, error: `Invalid URL format for ${field}`, value: null };
      }
    }

    case 'rating': {
      const num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
      if (Number.isFinite(num) && num >= 0 && num <= 5) {
        return { valid: true, value: Math.round(num * 10) / 10 };
      }
      return { valid: false, error: 'Rating must be between 0 and 5', value: null };
    }

    case 'rating_count':
    case 'review_count': {
      const num = typeof rawValue === 'number' ? rawValue : parseInt(String(rawValue).replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(num) && num >= 0) {
        return { valid: true, value: num };
      }
      return { valid: false, error: `${field} must be a non-negative integer`, value: null };
    }

    case 'product_id': {
      const idStr = String(rawValue).trim();
      return { valid: true, value: idStr || null };
    }

    default:
      return { valid: true, value: rawValue };
  }
}

export function createCorrectionsRepository() {
  return {
    async getAllCorrections() {
      return await readCorrectionsStorage();
    },

    async getCorrectionsForHost(hostname) {
      if (!hostname) return [];
      const list = await readCorrectionsStorage();
      return list.filter((c) => c.hostname === hostname);
    },

    async saveCorrection(entry) {
      if (!entry || typeof entry !== 'object' || !entry.field) {
        return { success: false, error: 'Invalid correction entry' };
      }

      const valCheck = validateFieldValue(entry.field, entry.correctedValue);
      if (!valCheck.valid) {
        return { success: false, error: valCheck.error };
      }

      const record = {
        id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        cardIndex: typeof entry.cardIndex === 'number' ? entry.cardIndex : null,
        productId: entry.productId || null,
        hostname: entry.hostname || '',
        layoutFingerprint: entry.layoutFingerprint || '',
        ruleId: entry.ruleId || null,
        field: entry.field,
        originalValue: entry.originalValue ?? null,
        correctedValue: valCheck.value,
        timestamp: new Date().toISOString()
      };

      const list = await readCorrectionsStorage();
      list.push(record);
      const ok = await writeCorrectionsStorage(list);
      return { success: ok, correction: record };
    },

    async clearAllCorrections() {
      inMemoryCorrections = [];
      if (isChromeStorageAvailable()) {
        return new Promise((resolve) => {
          chrome.storage.local.remove([STORAGE_KEY], () => resolve(true));
        });
      }
      return true;
    }
  };
}

export function deduceFieldSelectorFromCard(cardEl, fieldName, targetValue) {
  if (!cardEl || targetValue === null || targetValue === undefined) {
    return null;
  }

  const targetStr = String(targetValue).trim().toLowerCase();
  if (!targetStr) return null;

  if (fieldName === 'title') {
    const candidates = cardEl.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="heading"], [class*="name"], a, span, p'
    );
    for (const el of candidates) {
      if (el.children && el.children.length > 3) continue;
      const txt = normalizeText(el.textContent).toLowerCase();
      if (txt === targetStr || (txt.length >= targetStr.length && txt.includes(targetStr))) {
        if (el.className && typeof el.className === 'string') {
          const firstCls = el.className.split(' ').filter(Boolean)[0];
          if (firstCls && !firstCls.match(/container|wrapper|row|col|box|desc|media|shelf/i)) {
            return `.${firstCls}`;
          }
        }
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tagName.toLowerCase())) {
          return el.tagName.toLowerCase();
        }
      }
    }
  }

  if (fieldName === 'selling_price' || fieldName === 'mrp') {
    const targetNum = typeof targetValue === 'number' ? targetValue : parseFloat(targetValue);
    const candidates = cardEl.querySelectorAll('[class*="price"], [class*="amount"], span, div, p');
    for (const el of candidates) {
      if (el.children && el.children.length > 2) continue;
      const parsed = parseCurrencyAndPrice(el.textContent);
      if (parsed.price !== null && Math.abs(parsed.price - targetNum) < 0.01) {
        if (el.className && typeof el.className === 'string') {
          const firstCls = el.className.split(' ').filter(Boolean)[0];
          if (firstCls) {
            return `.${firstCls}`;
          }
        }
        return el.tagName.toLowerCase();
      }
    }
  }

  if (fieldName === 'product_url') {
    const anchors = cardEl.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (href.toLowerCase().includes(targetStr) || targetStr.includes(href.toLowerCase())) {
        if (a.className && typeof a.className === 'string') {
          const firstCls = a.className.split(' ').filter(Boolean)[0];
          if (firstCls) return `a.${firstCls}`;
        }
        return 'a';
      }
    }
  }

  if (fieldName === 'image_url') {
    const images = cardEl.querySelectorAll('img, source');
    for (const img of images) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (src.toLowerCase().includes(targetStr) || targetStr.includes(src.toLowerCase())) {
        if (img.className && typeof img.className === 'string') {
          const firstCls = img.className.split(' ').filter(Boolean)[0];
          if (firstCls) return `img.${firstCls}`;
        }
        return 'img';
      }
    }
  }

  return null;
}

export const correctionsRepository = createCorrectionsRepository();
