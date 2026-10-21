import {
  normalizeText,
  distinguishPrices,
  parseCurrencyAndPrice,
  extractPriceFromElement,
  extractTitle,
  extractProductId,
  queryCardElement
} from '../extractor/utils.js';
import { testCssSyntax, validateRuleAgainstDoc, detectPageType } from '../rules/validator.js';
import { rulesRepository } from '../rules/index.js';
import { regressionRepository } from '../regression/index.js';

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

const MRP_INDICATOR_REGEX = /(?:old[-_]?price|mrp|list[-_]?price|was[-_]?price|original[-_]?price|strike|del|crossed|regular[-_]?price|previous[-_]?price)/i;

export function detectMrpConfusion(element, cardEl, selector = '') {
  if (!element) {
    return { isLikelyMrp: false, reason: null };
  }

  if (selector && MRP_INDICATOR_REGEX.test(selector)) {
    return {
      isLikelyMrp: true,
      reason: `Selector "${selector}" explicitly targets MRP or list-price styling.`
    };
  }

  const tagName = element.tagName ? element.tagName.toLowerCase() : '';
  if (['del', 's', 'strike'].includes(tagName)) {
    return {
      isLikelyMrp: true,
      reason: `Element has strikethrough markup (<${tagName}>) commonly representing list price or MRP.`
    };
  }

  if (typeof element.closest === 'function') {
    const strikeAncestor = element.closest('del, s, strike, [class*="strike"], [class*="old"], [class*="mrp"], [class*="list-price"], [class*="was-price"]');
    if (strikeAncestor && strikeAncestor !== cardEl && cardEl.contains(strikeAncestor)) {
      return {
        isLikelyMrp: true,
        reason: 'Element is contained inside a strikethrough or old-price wrapper.'
      };
    }
  }

  const cls = typeof element.className === 'string' ? element.className : '';
  const id = typeof element.id === 'string' ? element.id : '';
  const ariaLabel = element.getAttribute ? element.getAttribute('aria-label') || '' : '';
  const dataPriceType = element.getAttribute ? element.getAttribute('data-price-type') || '' : '';
  const combinedAttrs = `${cls} ${id} ${ariaLabel} ${dataPriceType}`;

  if (MRP_INDICATOR_REGEX.test(combinedAttrs)) {
    return {
      isLikelyMrp: true,
      reason: 'Element attributes indicate list price, original price, or MRP.'
    };
  }

  const styleAttr = element.getAttribute ? element.getAttribute('style') || '' : '';
  if (/line-through/i.test(styleAttr)) {
    return {
      isLikelyMrp: true,
      reason: 'Element has inline text-decoration: line-through styling.'
    };
  }

  const text = element.textContent || '';
  if (/\b(?:m\.?r\.?p\.?|list\s*price|was:|regular\s*price|orig(?:inal)?\s*price)\b/i.test(text)) {
    return {
      isLikelyMrp: true,
      reason: 'Element text contains MRP or list price prefix.'
    };
  }

  const prevSibling = element.previousElementSibling;
  if (prevSibling && cardEl && cardEl.contains(prevSibling)) {
    const prevText = prevSibling.textContent || '';
    if (/\b(?:m\.?r\.?p\.?|list\s*price|was:|orig(?:inal)?\s*price)\b/i.test(prevText)) {
      return {
        isLikelyMrp: true,
        reason: 'Preceding label indicates MRP or previous price context.'
      };
    }
  }

  const prevNode = element.previousSibling;
  if (prevNode && prevNode.nodeType === 3) {
    const prevText = prevNode.textContent || '';
    if (/\b(?:m\.?r\.?p\.?|list\s*price|was:|orig(?:inal)?\s*price)\b/i.test(prevText)) {
      return {
        isLikelyMrp: true,
        reason: 'Preceding text node indicates MRP or previous price context.'
      };
    }
  }

  if (cardEl && typeof cardEl.querySelectorAll === 'function') {
    const otherPriceEls = Array.from(cardEl.querySelectorAll('[class*="price"], [class*="amount"]')).filter(
      (el) =>
        el !== element &&
        !element.contains(el) &&
        !el.contains(element) &&
        !/discount|save|off|badge|shipping|rating/i.test(el.className || '') &&
        !/%\s*off|save\s/i.test(el.textContent || '') &&
        (el.textContent || '').trim().length > 0
    );
    const thisPriceParsed = extractPriceFromElement(element, true);
    if (thisPriceParsed && typeof thisPriceParsed.price === 'number') {
      for (const otherEl of otherPriceEls) {
        const otherPrice = extractPriceFromElement(otherEl, true);
        if (otherPrice && typeof otherPrice.price === 'number' && otherPrice.price > 0 && otherPrice.price < thisPriceParsed.price) {
          const otherCls = typeof otherEl.className === 'string' ? otherEl.className : '';
          if (/sale|deal|selling|current|special|our[-_]?price/i.test(otherCls)) {
            return {
              isLikelyMrp: true,
              reason: `A lower selling price (${otherPrice.currency || ''}${otherPrice.price}) was detected elsewhere in the card.`
            };
          }
        }
      }
    }
  }

  return { isLikelyMrp: false, reason: null };
}

export function previewSelectorCorrection({
  cardSelector,
  field = 'sellingPrice',
  proposedSelector,
  doc,
  maxCards = 15,
  url = '',
  existingRule = null
}) {
  const errors = [];
  const warnings = [];

  const pageType = existingRule?.pageType || detectPageType(doc, url);
  const isRestaurant = pageType === 'restaurant';

  if (!proposedSelector || typeof proposedSelector !== 'string' || proposedSelector.trim().length === 0) {
    return {
      valid: false,
      fieldValid: false,
      isFullyValidRule: false,
      syntaxValid: false,
      domMatchesCount: 0,
      usableValuesCount: 0,
      pageType,
      validationStatus: 'UNVALIDATED',
      field,
      cardSelector: cardSelector || '',
      proposedSelector: proposedSelector || '',
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0,
        validationStatus: 'UNVALIDATED',
        rejectionReasons: { missing: 0, ambiguous: 0, likely_mrp: 0, syntax_error: 1, outside_card: 0 }
      },
      errors: ['Proposed selector cannot be empty'],
      warnings: []
    };
  }

  const trimmedProposed = proposedSelector.trim();

  if (!testCssSyntax(trimmedProposed, doc)) {
    return {
      valid: false,
      field,
      cardSelector: cardSelector || '',
      proposedSelector: trimmedProposed,
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0
      },
      errors: [`Invalid CSS selector syntax or unsafe expression: "${trimmedProposed}"`],
      warnings: []
    };
  }

  if (!cardSelector || typeof cardSelector !== 'string' || cardSelector.trim().length === 0) {
    return {
      valid: false,
      field,
      cardSelector: '',
      proposedSelector: trimmedProposed,
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0
      },
      errors: ['Card selector is required to scope manual selector correction'],
      warnings: []
    };
  }

  const trimmedCardSelector = cardSelector.trim();
  if (!testCssSyntax(trimmedCardSelector, doc)) {
    return {
      valid: false,
      field,
      cardSelector: trimmedCardSelector,
      proposedSelector: trimmedProposed,
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0
      },
      errors: [`Invalid card selector syntax: "${trimmedCardSelector}"`],
      warnings: []
    };
  }

  if (!doc || typeof doc.querySelectorAll !== 'function') {
    return {
      valid: false,
      field,
      cardSelector: trimmedCardSelector,
      proposedSelector: trimmedProposed,
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0
      },
      errors: ['Document root is missing or invalid'],
      warnings: []
    };
  }

  let matchedCards = [];
  try {
    matchedCards = Array.from(doc.querySelectorAll(trimmedCardSelector));
  } catch (err) {
    return {
      valid: false,
      field,
      cardSelector: trimmedCardSelector,
      proposedSelector: trimmedProposed,
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0
      },
      errors: [`Failed to query card selector: ${err?.message || 'Query error'}`],
      warnings: []
    };
  }

  if (matchedCards.length === 0) {
    return {
      valid: false,
      field,
      cardSelector: trimmedCardSelector,
      proposedSelector: trimmedProposed,
      sampledCards: [],
      summary: {
        totalMatchedCards: 0,
        totalSampled: 0,
        matchedCount: 0,
        validCount: 0,
        missingCount: 0,
        ambiguousCount: 0,
        likelyMrpCount: 0,
        requiresUserConfirmation: false,
        matchRate: 0
      },
      errors: [`Card selector "${trimmedCardSelector}" matched 0 elements in current DOM`],
      warnings: []
    };
  }

  let sample = matchedCards.slice(0, maxCards);
  let globalMatches = [];
  try {
    globalMatches = Array.from(doc.querySelectorAll(trimmedProposed));
  } catch {}

  const globalOutsideMatches = globalMatches.filter(
    (gm) => !matchedCards.some((card) => card.contains(gm) || card === gm)
  );
  const isExclusivelyOutside = globalMatches.length > 0 && globalMatches.length === globalOutsideMatches.length;

  const sampledCards = [];
  let validCount = 0;
  let matchedCount = 0;
  let missingCount = 0;
  let ambiguousCount = 0;
  let likelyMrpCount = 0;

  for (let i = 0; i < sample.length; i++) {
    const cardEl = sample[i];
    const productTitle = extractTitle(cardEl);
    const productId = extractProductId(cardEl);
    const productIdentity = productTitle || (productId ? `ID: ${productId}` : `Product #${i + 1}`);

    let matchesInCard = [];
    try {
      matchesInCard = Array.from(cardEl.querySelectorAll(trimmedProposed));
    } catch {}

    if (matchesInCard.length === 0 && cardEl.matches && cardEl.matches(trimmedProposed)) {
      matchesInCard = [cardEl];
    }

    if (matchesInCard.length === 0) {
      const status = isExclusivelyOutside ? 'OUTSIDE_CARD' : 'MISSING';
      missingCount += 1;
      sampledCards.push({
        cardIndex: i,
        productIdentity,
        matched: false,
        elementCount: 0,
        rawText: null,
        parsedValue: null,
        currency: null,
        validationStatus: status,
        isLikelyMrp: false,
        mrpReason: null,
        error: status === 'OUTSIDE_CARD' ? 'Selector matches elements outside product cards' : 'No matching element found in product card'
      });
      continue;
    }

    matchedCount += 1;
    const elementCount = matchesInCard.length;
    const primaryEl = matchesInCard[0];

    const isContained = cardEl.contains(primaryEl) || cardEl === primaryEl;
    if (!isContained) {
      missingCount += 1;
      sampledCards.push({
        cardIndex: i,
        productIdentity,
        matched: false,
        elementCount,
        rawText: null,
        parsedValue: null,
        currency: null,
        validationStatus: 'OUTSIDE_CARD',
        isLikelyMrp: false,
        mrpReason: null,
        error: 'Matched element is not contained inside the product card'
      });
      continue;
    }

    const rawText = normalizeText(primaryEl.textContent);
    if (!rawText) {
      missingCount += 1;
      sampledCards.push({
        cardIndex: i,
        productIdentity,
        matched: true,
        elementCount,
        rawText: '',
        parsedValue: null,
        currency: null,
        validationStatus: 'MISSING',
        isLikelyMrp: false,
        mrpReason: null,
        error: 'Matched element contains no text content'
      });
      continue;
    }

    const isPriceField = field === 'sellingPrice' || field === 'selling_price' || field === 'mrp';
    let parsedValue = null;
    let currency = null;
    let isValidVal = false;

    if (isPriceField) {
      const parsed = extractPriceFromElement(primaryEl, field !== 'mrp');
      if (parsed.price !== null && typeof parsed.price === 'number' && !isNaN(parsed.price) && parsed.price >= 0) {
        parsedValue = parsed.price;
        currency = parsed.currency;
        isValidVal = true;
      }
    } else {
      const valCheck = validateFieldValue(field, rawText);
      if (valCheck.valid && valCheck.value !== null && valCheck.value !== undefined) {
        parsedValue = valCheck.value;
        isValidVal = true;
      }
    }

    if (!isValidVal) {
      missingCount += 1;
      sampledCards.push({
        cardIndex: i,
        productIdentity,
        rawTitleText: field === 'title' ? rawText : (productTitle || ''),
        matched: true,
        elementCount,
        rawText,
        parsedValue: null,
        currency: null,
        validationStatus: 'INVALID_VALUE',
        isLikelyMrp: false,
        mrpReason: null,
        error: `Could not parse valid ${field} from text "${rawText}"`
      });
      continue;
    }

    const mrpCheck = detectMrpConfusion(primaryEl, cardEl, trimmedProposed);
    if (mrpCheck.isLikelyMrp) {
      likelyMrpCount += 1;
    }

    let validationStatus = 'VALID';
    let cardError = null;

    if (elementCount > 1) {
      validationStatus = 'AMBIGUOUS';
      ambiguousCount += 1;
      cardError = `Ambiguous: matched ${elementCount} elements within this card.`;
    } else {
      validCount += 1;
    }

    sampledCards.push({
      cardIndex: i,
      productIdentity,
      rawTitleText: field === 'title' ? rawText : (productTitle || ''),
      matched: true,
      elementCount,
      rawText,
      parsedValue,
      currency,
      validationStatus,
      isLikelyMrp: mrpCheck.isLikelyMrp,
      mrpReason: mrpCheck.reason,
      error: cardError
    });
  }

  const totalSampled = sample.length;
  const matchRate = totalSampled > 0 ? Math.round((validCount / totalSampled) * 100) : 0;
  const requiresUserConfirmation = likelyMrpCount > 0 || ambiguousCount > 0;

  if (matchedCount === 0) {
    if (globalMatches.length > 0) {
      errors.push(`Proposed selector "${trimmedProposed}" matches elements outside product cards, but 0 elements within them.`);
    } else {
      errors.push(`Proposed selector "${trimmedProposed}" matched 0 elements in current DOM.`);
    }
  } else if (validCount === 0) {
    errors.push(`Proposed selector matched elements in ${matchedCount} card(s), but extracted 0 valid ${field} values.`);
  } else if (matchRate < 50) {
    errors.push(`Selector match rate is only ${matchRate}% (${validCount}/${totalSampled}). Minimum 50% required across sampled cards.`);
  }

  if (likelyMrpCount > 0) {
    warnings.push(`DOM evidence indicates "${trimmedProposed}" targets MRP / list price rather than selling price in ${likelyMrpCount} card(s). User confirmation is required.`);
  }

  if (ambiguousCount > 0) {
    warnings.push(`Selector matched multiple elements in ${ambiguousCount} card(s). User confirmation is required.`);
  }

  const isFieldValid = errors.length === 0 && validCount > 0 && matchRate >= 50;
  let isFullyValidRule = isFieldValid;
  let ruleValidationStatus = isFieldValid ? 'VALIDATED' : 'UNVALIDATED';

  if (isFieldValid && !isRestaurant && (field === 'title')) {
    let cardsWithPrice = 0;
    for (const cardEl of sample) {
      let foundPrice = false;
      if (existingRule?.fieldSelectors?.priceSelector) {
        try {
          const pel = queryCardElement(cardEl, existingRule.fieldSelectors.priceSelector, trimmedCardSelector);
          if (pel) {
            const parsed = extractPriceFromElement(pel, true);
            if (parsed.price !== null && typeof parsed.price === 'number') {
              foundPrice = true;
            }
          }
        } catch {}
      }
      if (!foundPrice) {
        const p = distinguishPrices(cardEl);
        if (p.selling_price !== null && typeof p.selling_price === 'number') {
          foundPrice = true;
        }
      }
      if (foundPrice) {
        cardsWithPrice += 1;
      }
    }

    if (cardsWithPrice === 0) {
      isFullyValidRule = false;
      ruleValidationStatus = 'PARTIAL';
      errors.push(`E-commerce product rules require a valid selling price in addition to title. 0 of ${totalSampled} sampled cards have valid prices, so this rule cannot be marked as fully valid.`);
    }
  }

  const rejectionReasons = {
    missing: missingCount,
    ambiguous: ambiguousCount,
    likely_mrp: likelyMrpCount,
    syntax_error: 0,
    outside_card: sampledCards.filter((c) => c.validationStatus === 'OUTSIDE_CARD').length
  };

  return {
    valid: isFullyValidRule,
    fieldValid: isFieldValid,
    isFullyValidRule,
    syntaxValid: true,
    domMatchesCount: matchedCount,
    usableValuesCount: validCount,
    pageType,
    validationStatus: ruleValidationStatus,
    field,
    cardSelector: trimmedCardSelector,
    proposedSelector: trimmedProposed,
    sampledCards,
    summary: {
      totalMatchedCards: matchedCards.length,
      totalSampled,
      matchedCount,
      validCount,
      missingCount,
      ambiguousCount,
      likelyMrpCount,
      requiresUserConfirmation,
      matchRate,
      validationStatus: ruleValidationStatus,
      rejectionReasons
    },
    errors,
    warnings
  };
}

function createDocFromHtml(html, fallbackDoc) {
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(html, 'text/html');
  }
  if (fallbackDoc && fallbackDoc.defaultView && fallbackDoc.defaultView.DOMParser) {
    return new fallbackDoc.defaultView.DOMParser().parseFromString(html, 'text/html');
  }
  if (fallbackDoc && typeof fallbackDoc.implementation?.createHTMLDocument === 'function') {
    const d = fallbackDoc.implementation.createHTMLDocument();
    d.documentElement.innerHTML = html;
    return d;
  }
  return null;
}

export async function applySelectorCorrection({
  hostname,
  layoutFingerprint,
  cardSelector,
  field = 'sellingPrice',
  proposedSelector,
  userConfirmedAmbiguity = false,
  doc,
  url = ''
}) {
  if (!doc) {
    return { success: false, error: 'Document root is required for revalidation' };
  }

  const existingRule = await rulesRepository.findMatchingRule(hostname, layoutFingerprint);

  const preview = previewSelectorCorrection({
    cardSelector,
    field,
    proposedSelector,
    doc,
    url,
    existingRule
  });

  if (preview.summary.requiresUserConfirmation && !userConfirmedAmbiguity) {
    return {
      success: false,
      error: 'Likely MRP or ambiguous pricing detected. Explicit user confirmation is required before activating this correction.',
      preview
    };
  }

  if (!preview.valid) {
    const errorMsg = preview.errors.join('; ') || 'Proposed selector failed validation';
    return { success: false, error: errorMsg, preview };
  }

  const pageType = preview.pageType || detectPageType(doc, url);

  const FIELD_KEY_MAP = {
    sellingPrice: 'priceSelector',
    selling_price: 'priceSelector',
    mrp: 'mrpSelector',
    title: 'titleSelector',
    product_url: 'urlSelector',
    image_url: 'imageSelector',
    rating: 'ratingSelector'
  };

  const targetSelectorKey = FIELD_KEY_MAP[field] || 'priceSelector';

  const baseCardSelector = (cardSelector && cardSelector.trim()) || existingRule?.cardSelector;
  const baseFieldSelectors = { ...(existingRule?.fieldSelectors || {}) };
  baseFieldSelectors[targetSelectorKey] = proposedSelector.trim();

  const candidateRule = {
    ...(existingRule || {}),
    id: existingRule?.id || `rule_${hostname}_${layoutFingerprint}`,
    hostname,
    layoutFingerprint,
    pageType,
    cardSelector: baseCardSelector,
    fieldSelectors: baseFieldSelectors,
    changeSource: 'manual_selector_correction',
    changeSummary: `Manual correction for ${field}: ${proposedSelector.trim()}`
  };

  const liveValidation = validateRuleAgainstDoc(candidateRule, doc, url, { pageType });
  if (!liveValidation.valid) {
    return {
      success: false,
      error: `Rule failed live DOM validation: ${(liveValidation.errors || []).join('; ')}`,
      preservedRule: existingRule,
      preview
    };
  }

  const regressionCheck = await regressionRepository.runRegressionOnCandidate(
    candidateRule,
    (html) => createDocFromHtml(html, doc)
  );

  if (!regressionCheck.passed) {
    return {
      success: false,
      error: `Rule failed regression checks: ${(regressionCheck.failures || []).join('; ')}`,
      preservedRule: existingRule,
      preview
    };
  }

  const saveRes = await rulesRepository.saveRule({
    ...candidateRule,
    validationStatus: 'VALIDATED',
    testResults: liveValidation,
    regressionResults: regressionCheck
  });

  if (!saveRes.success) {
    return {
      success: false,
      error: saveRes.error || 'Failed to persist corrected rule version',
      preservedRule: existingRule,
      preview
    };
  }

  const reloadedRule = await rulesRepository.getRule(candidateRule.id);
  if (
    !reloadedRule ||
    !reloadedRule.fieldSelectors ||
    reloadedRule.fieldSelectors[targetSelectorKey] !== proposedSelector.trim()
  ) {
    return {
      success: false,
      error: `Persistence verification failed: ${targetSelectorKey} could not be confirmed in stored rule.`,
      preservedRule: existingRule,
      preview
    };
  }

  try {
    await correctionsRepository.saveCorrection({
      hostname,
      layoutFingerprint,
      ruleId: reloadedRule.id,
      field,
      correctedValue: proposedSelector.trim()
    });
  } catch {}

  return {
    success: true,
    rule: reloadedRule,
    previousVersionId: existingRule?.activeVersionId || null,
    activeVersionId: reloadedRule.activeVersionId,
    preview
  };
}
