import {
  normalizeText,
  resolveAbsoluteUrl,
  distinguishPrices,
  parseCurrencyAndPrice,
  parseRating,
  parseCounts,
  extractImageUrl,
  extractProductId,
  extractTitle,
  extractProductUrl,
  extractExtraAttributes
} from '../extractor/utils.js';

const DISALLOWED_CARD_SELECTORS = new Set([
  'html', 'body', 'head', 'script', 'style', 'nav', 'header', 'footer', 'aside',
  'main', 'section', 'article', 'div', 'p', 'a', 'span', 'ul', 'ol', 'form',
  'table', 'tbody', 'tr', 'td'
]);

function testCssSyntax(selector, rootDoc) {
  if (!selector || typeof selector !== 'string') return false;
  const trimmed = selector.trim();
  if (trimmed.length < 1 || trimmed.length > 250) return false;
  if (trimmed.match(/<script|javascript:|on\w+=|eval\(|expression\(/i)) return false;
  try {
    rootDoc.querySelector(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function validateRuleAgainstDoc(rule, doc, baseUrl = '') {
  const errors = [];
  const warnings = [];
  const invalidFields = [];
  const missingFields = [];
  const ambiguousFields = [];

  if (!rule || typeof rule !== 'object') {
    return {
      valid: false,
      errors: ['Rule definition is missing or invalid object'],
      warnings: [],
      invalidFields: [],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: 0,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  const cardSelector = rule.cardSelector?.trim();
  if (!cardSelector) {
    return {
      valid: false,
      errors: ['Card selector is required'],
      warnings: [],
      invalidFields: ['cardSelector'],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: 0,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  if (!testCssSyntax(cardSelector, doc)) {
    return {
      valid: false,
      errors: [`Card selector has invalid CSS syntax or unsafe content: "${cardSelector}"`],
      warnings: [],
      invalidFields: ['cardSelector'],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: 0,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  if (DISALLOWED_CARD_SELECTORS.has(cardSelector.toLowerCase())) {
    return {
      valid: false,
      errors: [`Card selector "${cardSelector}" is too broad or targets a standard container element`],
      warnings: [],
      invalidFields: ['cardSelector'],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: 0,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  let matchedCards = [];
  try {
    matchedCards = Array.from(doc.querySelectorAll(cardSelector));
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to query card selector: ${err.message}`],
      warnings: [],
      invalidFields: ['cardSelector'],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: 0,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  if (matchedCards.length === 0) {
    return {
      valid: false,
      errors: ['Card selector matched 0 elements in current DOM'],
      warnings: [],
      invalidFields: [],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: 0,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  if (matchedCards.length > 250) {
    return {
      valid: false,
      errors: [`Card selector is implausibly broad, matched ${matchedCards.length} elements (max 250)`],
      warnings: [],
      invalidFields: ['cardSelector'],
      missingFields: [],
      ambiguousFields: [],
      candidateCount: matchedCards.length,
      acceptedCount: 0,
      matchRate: 0,
      fieldCoverage: {},
      sampleItems: []
    };
  }

  const fieldSelectors = rule.fieldSelectors || {};
  const sampleItems = [];
  let validProductsCount = 0;

  const selectorStats = {
    title: { attempted: Boolean(fieldSelectors.titleSelector), extracted: 0 },
    price: { attempted: Boolean(fieldSelectors.priceSelector), extracted: 0 },
    mrp: { attempted: Boolean(fieldSelectors.mrpSelector), extracted: 0 },
    url: { attempted: Boolean(fieldSelectors.urlSelector), extracted: 0 },
    image: { attempted: Boolean(fieldSelectors.imageSelector), extracted: 0 },
    rating: { attempted: Boolean(fieldSelectors.ratingSelector), extracted: 0 }
  };

  for (const [key, sel] of Object.entries(fieldSelectors)) {
    if (sel && typeof sel === 'string') {
      if (!testCssSyntax(sel, doc)) {
        errors.push(`Field selector "${key}" has invalid CSS syntax: "${sel}"`);
        invalidFields.push(key);
      }
    }
  }

  const evaluatedCards = matchedCards.slice(0, 10);

  for (const cardEl of evaluatedCards) {
    let title = null;
    if (fieldSelectors.titleSelector && !invalidFields.includes('titleSelector')) {
      try {
        const el = cardEl.querySelector(fieldSelectors.titleSelector);
        if (el) {
          const txt = normalizeText(el.textContent);
          if (txt && txt.length >= 2) {
            title = txt;
            selectorStats.title.extracted += 1;
          }
        }
      } catch {}
    } else if (!fieldSelectors.titleSelector) {
      title = extractTitle(cardEl);
    }

    let product_url = null;
    if (fieldSelectors.urlSelector && !invalidFields.includes('urlSelector')) {
      try {
        const el = cardEl.querySelector(fieldSelectors.urlSelector);
        if (el) {
          const href = el.getAttribute('href') || (el.tagName === 'A' ? el.getAttribute('href') : null);
          if (href) {
            const resolved = resolveAbsoluteUrl(href, baseUrl);
            if (resolved) {
              product_url = resolved;
              selectorStats.url.extracted += 1;
            }
          }
        }
      } catch {}
    } else if (!fieldSelectors.urlSelector) {
      product_url = extractProductUrl(cardEl, baseUrl);
    }

    let image_url = null;
    if (fieldSelectors.imageSelector && !invalidFields.includes('imageSelector')) {
      try {
        const el = cardEl.querySelector(fieldSelectors.imageSelector);
        if (el) {
          const imgUrl = extractImageUrl(el, baseUrl);
          if (imgUrl) {
            image_url = imgUrl;
            selectorStats.image.extracted += 1;
          }
        }
      } catch {}
    } else if (!fieldSelectors.imageSelector) {
      image_url = extractImageUrl(cardEl, baseUrl);
    }

    let selling_price = null;
    let mrp = null;
    let currency = null;

    if (fieldSelectors.priceSelector && !invalidFields.includes('priceSelector')) {
      try {
        const el = cardEl.querySelector(fieldSelectors.priceSelector);
        if (el) {
          const parsed = parseCurrencyAndPrice(el.textContent);
          if (parsed.price !== null) {
            selling_price = parsed.price;
            currency = parsed.currency;
            selectorStats.price.extracted += 1;
          }
        }
      } catch {}

      if (fieldSelectors.mrpSelector && !invalidFields.includes('mrpSelector')) {
        try {
          const el = cardEl.querySelector(fieldSelectors.mrpSelector);
          if (el) {
            const parsed = parseCurrencyAndPrice(el.textContent);
            if (parsed.price !== null) {
              mrp = parsed.price;
              if (!currency) currency = parsed.currency;
              selectorStats.mrp.extracted += 1;
            }
          }
        } catch {}
      }
    } else {
      const priceData = distinguishPrices(cardEl);
      selling_price = priceData.selling_price;
      mrp = priceData.mrp;
      currency = priceData.currency;
    }

    let rating = null;
    if (fieldSelectors.ratingSelector && !invalidFields.includes('ratingSelector')) {
      try {
        const el = cardEl.querySelector(fieldSelectors.ratingSelector);
        if (el) {
          const r = parseRating(el);
          if (r !== null) {
            rating = r;
            selectorStats.rating.extracted += 1;
          }
        }
      } catch {}
    } else {
      rating = parseRating(cardEl);
    }

    const counts = parseCounts(cardEl);
    const product_id = extractProductId(cardEl, product_url);
    const extra = extractExtraAttributes(cardEl);

    const item = {
      title: title || null,
      product_url: product_url || null,
      product_id: product_id || null,
      image_url: image_url || null,
      selling_price,
      mrp,
      currency,
      rating,
      rating_count: counts.rating_count,
      review_count: counts.review_count,
      extra
    };

    if (item.title && (item.selling_price !== null || item.image_url !== null)) {
      validProductsCount += 1;
    }
    sampleItems.push(item);
  }

  const evaluatedCardsCount = evaluatedCards.length;

  if (selectorStats.title.attempted && selectorStats.title.extracted === 0) {
    errors.push(`Supplied titleSelector "${fieldSelectors.titleSelector}" failed to extract titles on any card`);
    invalidFields.push('titleSelector');
  }

  if (selectorStats.price.attempted && selectorStats.price.extracted === 0) {
    errors.push(`Supplied priceSelector "${fieldSelectors.priceSelector}" failed to extract valid prices on any card`);
    invalidFields.push('priceSelector');
  }

  if (selectorStats.url.attempted && selectorStats.url.extracted === 0) {
    errors.push(`Supplied urlSelector "${fieldSelectors.urlSelector}" failed to extract valid URLs on any card`);
    invalidFields.push('urlSelector');
  }

  if (selectorStats.image.attempted && selectorStats.image.extracted === 0) {
    errors.push(`Supplied imageSelector "${fieldSelectors.imageSelector}" failed to extract valid images on any card`);
    invalidFields.push('imageSelector');
  }

  if (selectorStats.mrp.attempted && selectorStats.mrp.extracted === 0) {
    warnings.push(`Supplied mrpSelector "${fieldSelectors.mrpSelector}" matched 0 elements (optional field)`);
    missingFields.push('mrp');
  }

  if (selectorStats.rating.attempted && selectorStats.rating.extracted === 0) {
    warnings.push(`Supplied ratingSelector "${fieldSelectors.ratingSelector}" matched 0 elements (optional field)`);
    missingFields.push('rating');
  }

  const matchRate = evaluatedCardsCount > 0 ? validProductsCount / evaluatedCardsCount : 0;

  if (matchRate < 0.5) {
    errors.push(`Card selector matched elements, but only ${validProductsCount} of ${evaluatedCardsCount} produced valid product items.`);
  }

  const fieldCoverage = {
    title: sampleItems.filter((i) => Boolean(i.title)).length / sampleItems.length,
    price: sampleItems.filter((i) => i.selling_price !== null).length / sampleItems.length,
    image: sampleItems.filter((i) => Boolean(i.image_url)).length / sampleItems.length,
    url: sampleItems.filter((i) => Boolean(i.product_url)).length / sampleItems.length,
    rating: sampleItems.filter((i) => i.rating !== null).length / sampleItems.length,
    mrp: sampleItems.filter((i) => i.mrp !== null).length / sampleItems.length
  };

  const isValid = errors.length === 0 && validProductsCount > 0;

  return {
    valid: isValid,
    errors,
    warnings,
    invalidFields,
    missingFields,
    ambiguousFields,
    candidateCount: matchedCards.length,
    acceptedCount: validProductsCount,
    matchRate: Math.round(matchRate * 100),
    fieldCoverage,
    sampleItems
  };
}
