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
  extractExtraAttributes,
  extractPriceFromElement,
  queryCardElement
} from '../extractor/utils.js';

const DISALLOWED_CARD_SELECTORS = new Set([
  'html', 'body', 'head', 'script', 'style', 'nav', 'header', 'footer', 'aside',
  'main', 'section', 'article', 'div', 'p', 'a', 'span', 'ul', 'ol', 'form',
  'table', 'tbody', 'tr', 'td',
  '.row', 'div.row', '.container', 'div.container',
  '.col-12', 'div.col-12', '.col-12-12', 'div.col-12-12', '.col-10-12', 'div.col-10-12'
]);

function testCssSyntax(selector, rootDoc) {
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

  try {
    if (rootDoc && typeof rootDoc.querySelector === 'function') {
      rootDoc.querySelector(trimmed);
      return true;
    }
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
    title: { attempted: typeof fieldSelectors.titleSelector === 'string' && fieldSelectors.titleSelector.trim().length > 0, matched: 0, extracted: 0 },
    price: { attempted: typeof fieldSelectors.priceSelector === 'string' && fieldSelectors.priceSelector.trim().length > 0, matched: 0, extracted: 0 },
    mrp: { attempted: typeof fieldSelectors.mrpSelector === 'string' && fieldSelectors.mrpSelector.trim().length > 0, matched: 0, extracted: 0 },
    url: { attempted: typeof fieldSelectors.urlSelector === 'string' && fieldSelectors.urlSelector.trim().length > 0, matched: 0, extracted: 0 },
    image: { attempted: typeof fieldSelectors.imageSelector === 'string' && fieldSelectors.imageSelector.trim().length > 0, matched: 0, extracted: 0 },
    rating: { attempted: typeof fieldSelectors.ratingSelector === 'string' && fieldSelectors.ratingSelector.trim().length > 0, matched: 0, extracted: 0 }
  };

  for (const [key, sel] of Object.entries(fieldSelectors)) {
    if (sel === null || sel === undefined || (typeof sel === 'string' && sel.trim().length === 0)) {
      continue;
    }
    if (typeof sel !== 'string') {
      errors.push(`Field selector "${key}" has invalid type (expected string or null)`);
      invalidFields.push(key);
      continue;
    }
    if (!testCssSyntax(sel, doc)) {
      errors.push(`Field selector "${key}" has invalid CSS syntax: "${sel}"`);
      invalidFields.push(key);
    }
  }

  let nonTrivialCards = matchedCards.filter((el) => {
    if (!el || el.nodeType !== 1) return false;
    return (el.textContent || '').trim().length > 0;
  });
  if (nonTrivialCards.length === 0) {
    nonTrivialCards = matchedCards;
  }

  let evaluatedCards = nonTrivialCards;
  if (evaluatedCards.length > 15) {
    const step = Math.floor(evaluatedCards.length / 15);
    const sampled = [];
    for (let i = 0; i < evaluatedCards.length && sampled.length < 15; i += Math.max(1, step)) {
      sampled.push(evaluatedCards[i]);
    }
    evaluatedCards = sampled;
  }

  for (const cardEl of evaluatedCards) {
    let title = null;
    if (selectorStats.title.attempted && !invalidFields.includes('titleSelector')) {
      try {
        const el = queryCardElement(cardEl, fieldSelectors.titleSelector, cardSelector);
        if (el) {
          selectorStats.title.matched += 1;
          const txt = normalizeText(el.textContent);
          if (txt && txt.length >= 2) {
            title = txt;
            selectorStats.title.extracted += 1;
          }
        }
      } catch {}
    } else if (!selectorStats.title.attempted) {
      title = extractTitle(cardEl);
    }

    let product_url = null;
    if (selectorStats.url.attempted && !invalidFields.includes('urlSelector')) {
      try {
        const el = queryCardElement(cardEl, fieldSelectors.urlSelector, cardSelector);
        if (el) {
          selectorStats.url.matched += 1;
          const href = el.getAttribute('href') || (el.closest ? el.closest('a')?.getAttribute('href') : null);
          if (href) {
            const resolved = resolveAbsoluteUrl(href, baseUrl);
            if (resolved) {
              product_url = resolved;
              selectorStats.url.extracted += 1;
            }
          }
        }
      } catch {}
    } else if (!selectorStats.url.attempted) {
      product_url = extractProductUrl(cardEl, baseUrl);
    }

    let image_url = null;
    if (selectorStats.image.attempted && !invalidFields.includes('imageSelector')) {
      try {
        const el = queryCardElement(cardEl, fieldSelectors.imageSelector, cardSelector);
        if (el) {
          selectorStats.image.matched += 1;
          const imgUrl = extractImageUrl(el, baseUrl);
          if (imgUrl) {
            image_url = imgUrl;
            selectorStats.image.extracted += 1;
          }
        }
      } catch {}
    } else if (!selectorStats.image.attempted) {
      image_url = extractImageUrl(cardEl, baseUrl);
    }

    let selling_price = null;
    let mrp = null;
    let currency = null;

    if (selectorStats.price.attempted && !invalidFields.includes('priceSelector')) {
      try {
        const el = queryCardElement(cardEl, fieldSelectors.priceSelector, cardSelector);
        if (el) {
          selectorStats.price.matched += 1;
          const parsed = extractPriceFromElement(el, true);
          if (parsed.price !== null && typeof parsed.price === 'number' && !isNaN(parsed.price) && parsed.price >= 0) {
            selling_price = parsed.price;
            currency = parsed.currency;
            selectorStats.price.extracted += 1;
          }
        }
      } catch {}

      if (selectorStats.mrp.attempted && !invalidFields.includes('mrpSelector')) {
        try {
          const el = queryCardElement(cardEl, fieldSelectors.mrpSelector, cardSelector);
          if (el) {
            selectorStats.mrp.matched += 1;
            const parsed = extractPriceFromElement(el, false);
            if (parsed.price !== null && typeof parsed.price === 'number' && !isNaN(parsed.price) && parsed.price >= 0) {
              mrp = parsed.price;
              if (!currency) currency = parsed.currency;
              selectorStats.mrp.extracted += 1;
            }
          }
        } catch {}
      }
    } else if (!selectorStats.price.attempted) {
      const priceData = distinguishPrices(cardEl);
      selling_price = priceData.selling_price;
      mrp = priceData.mrp;
      currency = priceData.currency;
    }

    if (selling_price !== null && mrp !== null && selling_price > mrp) {
      const temp = selling_price;
      selling_price = mrp;
      mrp = temp;
    }

    let rating = null;
    if (selectorStats.rating.attempted && !invalidFields.includes('ratingSelector')) {
      try {
        const el = queryCardElement(cardEl, fieldSelectors.ratingSelector, cardSelector);
        if (el) {
          selectorStats.rating.matched += 1;
          const r = parseRating(el);
          if (r !== null) {
            rating = r;
            selectorStats.rating.extracted += 1;
          }
        }
      } catch {}
    } else if (!selectorStats.rating.attempted) {
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

    if (item.title && item.selling_price !== null) {
      validProductsCount += 1;
    }
    sampleItems.push(item);
  }

  const evaluatedCardsCount = evaluatedCards.length;

  if (selectorStats.title.attempted) {
    if (selectorStats.title.matched === 0) {
      errors.push(`Supplied titleSelector "${fieldSelectors.titleSelector}" matched 0 elements across all sampled cards`);
      invalidFields.push('titleSelector');
    } else if (selectorStats.title.extracted === 0) {
      errors.push(`Supplied titleSelector "${fieldSelectors.titleSelector}" failed to extract titles on any card`);
      invalidFields.push('titleSelector');
    }
  }

  if (selectorStats.price.attempted) {
    if (selectorStats.price.matched === 0) {
      errors.push(`Supplied priceSelector "${fieldSelectors.priceSelector}" matched 0 elements across all sampled cards`);
      invalidFields.push('priceSelector');
    } else if (selectorStats.price.extracted === 0) {
      errors.push(`Supplied priceSelector "${fieldSelectors.priceSelector}" failed to extract valid prices on any card`);
      invalidFields.push('priceSelector');
    }
  }

  if (selectorStats.url.attempted) {
    if (selectorStats.url.matched === 0) {
      errors.push(`Supplied urlSelector "${fieldSelectors.urlSelector}" matched 0 elements across all sampled cards`);
      invalidFields.push('urlSelector');
    } else if (selectorStats.url.extracted === 0) {
      errors.push(`Supplied urlSelector "${fieldSelectors.urlSelector}" failed to extract valid URLs on any card`);
      invalidFields.push('urlSelector');
    }
  }

  if (selectorStats.image.attempted) {
    if (selectorStats.image.matched === 0) {
      warnings.push(`Supplied imageSelector "${fieldSelectors.imageSelector}" matched 0 elements across all sampled cards (optional field)`);
      missingFields.push('image');
    } else if (selectorStats.image.extracted === 0) {
      warnings.push(`Supplied imageSelector "${fieldSelectors.imageSelector}" failed to extract valid images on any card (optional field)`);
      missingFields.push('image');
    }
  }

  if (selectorStats.mrp.attempted) {
    if (selectorStats.mrp.matched === 0) {
      warnings.push(`Supplied mrpSelector "${fieldSelectors.mrpSelector}" matched 0 elements (optional field)`);
      missingFields.push('mrp');
    } else if (selectorStats.mrp.extracted === 0) {
      warnings.push(`Supplied mrpSelector "${fieldSelectors.mrpSelector}" matched elements, but produced no usable price (optional field)`);
      missingFields.push('mrp');
    }
  }

  if (selectorStats.rating.attempted) {
    if (selectorStats.rating.matched === 0) {
      warnings.push(`Supplied ratingSelector "${fieldSelectors.ratingSelector}" matched 0 elements (optional field)`);
      missingFields.push('rating');
    } else if (selectorStats.rating.extracted === 0) {
      warnings.push(`Supplied ratingSelector "${fieldSelectors.ratingSelector}" matched elements, but produced no usable rating (optional field)`);
      missingFields.push('rating');
    }
  }

  const matchRate = evaluatedCardsCount > 0 ? validProductsCount / evaluatedCardsCount : 0;

  if (matchRate < 0.5) {
    errors.push(`Card selector matched elements, but only ${validProductsCount} of ${evaluatedCardsCount} produced valid product items with title and price.`);
    invalidFields.push('cardSelector');
  }

  const fieldCoverage = {
    title: sampleItems.filter((i) => Boolean(i.title)).length / sampleItems.length,
    price: sampleItems.filter((i) => i.selling_price !== null).length / sampleItems.length,
    image: sampleItems.filter((i) => Boolean(i.image_url)).length / sampleItems.length,
    url: sampleItems.filter((i) => Boolean(i.product_url)).length / sampleItems.length,
    rating: sampleItems.filter((i) => i.rating !== null).length / sampleItems.length,
    mrp: sampleItems.filter((i) => i.mrp !== null).length / sampleItems.length
  };

  const isValid = errors.length === 0 && validProductsCount > 0 && invalidFields.length === 0;

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
