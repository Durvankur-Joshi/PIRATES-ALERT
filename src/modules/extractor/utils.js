export function normalizeText(val) {
  if (val === null || val === undefined) {
    return '';
  }
  const str = String(val).replace(/\u00a0/g, ' ');
  return str.replace(/\s+/g, ' ').trim();
}

export function resolveAbsoluteUrl(href, baseUrl) {
  if (!href || typeof href !== 'string') {
    return null;
  }
  const cleanHref = href.trim();
  if (cleanHref.match(/^(javascript|vbscript|data|file):/i) || cleanHref.startsWith('#')) {
    return null;
  }
  try {
    const base = baseUrl || (typeof document !== 'undefined' ? document.baseURI || window.location.href : 'http://localhost');
    const resolved = new URL(cleanHref, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}

const CURRENCY_SYMBOLS = {
  '₹': '₹',
  'Rs.': '₹',
  'Rs': '₹',
  'rs.': '₹',
  'rs': '₹',
  '$': '$',
  '€': '€',
  '£': '£',
  '¥': '¥',
  '₩': '₩',
  '₽': '₽',
  '₪': '₪',
  '₨': '₹',
  '₱': '₱',
  '₫': '₫',
  '฿': '฿'
};

const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'CNY', 'BRL', 'MXN', 'AED', 'SAR', 'CHF', 'SEK', 'NOK', 'SGD', 'NZD'
];

export function parseCurrencyAndPrice(text) {
  if (!text || typeof text !== 'string') {
    return { currency: null, price: null };
  }
  const normalized = normalizeText(text);
  if (!normalized) {
    return { currency: null, price: null };
  }

  if (normalized.match(/(?:\/5|\/ 5|out of 5|stars?|★)/i) && !normalized.match(/[$€£₹¥]|(?:Rs\.?|INR)/i)) {
    return { currency: null, price: null };
  }

  let foundCurrency = null;
  for (const [symbol, canonical] of Object.entries(CURRENCY_SYMBOLS)) {
    if (normalized.includes(symbol)) {
      foundCurrency = canonical;
      break;
    }
  }

  if (!foundCurrency) {
    for (const code of CURRENCY_CODES) {
      const codeRegex = new RegExp(`\\b${code}\\b`, 'i');
      if (codeRegex.test(normalized)) {
        foundCurrency = code.toUpperCase();
        break;
      }
    }
  }

  const sanitized = normalized.replace(/(\d)\s+(\d{3})/g, '$1$2');

  const pricePattern = /(?:[0-9]{1,2}(?:,[0-9]{2})+,[0-9]{3}(?:\.[0-9]{1,2})?|[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{1,2}|[0-9]{1,3}(?:\.[0-9]{3})+(?![0-9])|[0-9]+[.,][0-9]{1,2}(?![0-9])|[0-9]+)/g;
  const matches = sanitized.match(pricePattern);
  if (!matches || matches.length === 0) {
    return { currency: foundCurrency, price: null };
  }

  let rawNum = matches[0];
  if (matches.length > 1) {
    for (const m of matches) {
      const idx = sanitized.indexOf(m);
      if (idx !== -1) {
        const after = sanitized.slice(idx + m.length, idx + m.length + 3);
        if (after.includes('%')) {
          continue;
        }
        const before = sanitized.slice(Math.max(0, idx - 6), idx);
        if (/[$€£₹¥]|(?:Rs\.?|INR|USD|EUR|GBP)/i.test(before) || /[$€£₹¥]|(?:Rs\.?|INR|USD|EUR|GBP)/i.test(after)) {
          rawNum = m;
          break;
        }
      }
    }
  }

  let parsedNumber = null;

  if (rawNum.includes(',') && rawNum.includes('.')) {
    if (rawNum.indexOf(',') < rawNum.indexOf('.')) {
      parsedNumber = parseFloat(rawNum.replace(/,/g, ''));
    } else {
      parsedNumber = parseFloat(rawNum.replace(/\./g, '').replace(',', '.'));
    }
  } else if (rawNum.includes(',')) {
    const parts = rawNum.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      parsedNumber = parseFloat(rawNum.replace(',', '.'));
    } else {
      parsedNumber = parseFloat(rawNum.replace(/,/g, ''));
    }
  } else if (rawNum.includes('.')) {
    const parts = rawNum.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      parsedNumber = parseFloat(rawNum);
    } else {
      parsedNumber = parseFloat(rawNum.replace(/\./g, ''));
    }
  } else {
    parsedNumber = parseFloat(rawNum);
  }

  return {
    currency: foundCurrency,
    price: Number.isFinite(parsedNumber) ? parsedNumber : null
  };
}

export function extractPriceFromElement(el, isSellingPrice = true) {
  if (!el) {
    return { currency: null, price: null };
  }

  const directAttr =
    el.getAttribute('data-price') ||
    el.getAttribute('data-product-price') ||
    (el.tagName === 'META' || el.hasAttribute('itemprop') ? el.getAttribute('content') : null) ||
    el.getAttribute('value');

  if (directAttr) {
    const parsedAttr = parseCurrencyAndPrice(directAttr);
    if (parsedAttr.price !== null) {
      return parsedAttr;
    }
  }

  let text = el.textContent || '';
  if (isSellingPrice) {
    const hasStrike = Boolean(
      el.querySelector &&
      el.querySelector('del, s, strike, [class*="strike"], [class*="original"], [class*="mrp"], [class*="list-price"], [class*="old-price"], [class*="was-price"]')
    );
    if (hasStrike) {
      try {
        const clone = el.cloneNode(true);
        const strikes = clone.querySelectorAll('del, s, strike, [class*="strike"], [class*="original"], [class*="mrp"], [class*="list-price"], [class*="old-price"], [class*="was-price"]');
        for (const s of strikes) {
          s.remove();
        }
        text = clone.textContent || '';
      } catch {}
    }
  } else {
    if (el.querySelector) {
      const strikeChild = el.querySelector('del, s, strike, [class*="strike"], [class*="original"], [class*="mrp"], [class*="list-price"], [class*="old-price"], [class*="was-price"]');
      if (strikeChild) {
        const parsedStrike = parseCurrencyAndPrice(strikeChild.textContent);
        if (parsedStrike.price !== null) {
          return parsedStrike;
        }
      }
    }
  }

  const parsed = parseCurrencyAndPrice(text);
  if (parsed.price !== null) {
    return parsed;
  }

  if (el.innerText && el.innerText !== text) {
    const parsedInner = parseCurrencyAndPrice(el.innerText);
    if (parsedInner.price !== null) {
      return parsedInner;
    }
  }

  if (el.querySelector) {
    const meta = el.querySelector('meta[itemprop="price"], [itemprop="price"][content], [data-price]');
    if (meta) {
      const val = meta.getAttribute('content') || meta.getAttribute('data-price');
      if (val) {
        const parsedMeta = parseCurrencyAndPrice(val);
        if (parsedMeta.price !== null) {
          return parsedMeta;
        }
      }
    }
  }

  return { currency: null, price: null };
}

export function queryCardElement(cardEl, selector, cardSelector = '') {
  if (!cardEl || !selector || typeof selector !== 'string') return null;
  const trimmed = selector.trim();
  if (!trimmed) return null;

  let cleanSelector = trimmed;
  if (cardSelector && cleanSelector.startsWith(cardSelector)) {
    cleanSelector = cleanSelector.slice(cardSelector.length).trim();
  }
  if (!cleanSelector) {
    return cardEl;
  }

  try {
    if (cardEl.matches && cardEl.matches(cleanSelector)) {
      return cardEl;
    }
  } catch {}

  try {
    const el = cardEl.querySelector(cleanSelector);
    if (el) return el;
  } catch {}

  if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(cleanSelector)) {
    const classOnly = cleanSelector.replace(/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+.*)/, '$1');
    try {
      if (cardEl.matches && cardEl.matches(classOnly)) {
        return cardEl;
      }
      const el = cardEl.querySelector(classOnly);
      if (el) return el;
    } catch {}
  }

  // Handle compound/descendant selectors (e.g., "div.hl05eU > div.Nx9bqj" or ".price-box .sale-price")
  if (cleanSelector.includes(' ') || cleanSelector.includes('>')) {
    const parts = cleanSelector.split(/[\s>+~]+/).filter(Boolean);
    if (parts.length > 1) {
      const leaf = parts[parts.length - 1];
      try {
        if (cardEl.matches && cardEl.matches(leaf)) {
          return cardEl;
        }
        const el = cardEl.querySelector(leaf);
        if (el) return el;
      } catch {}
      if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(leaf)) {
        const leafClassOnly = leaf.replace(/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+.*)/, '$1');
        try {
          if (cardEl.matches && cardEl.matches(leafClassOnly)) {
            return cardEl;
          }
          const el = cardEl.querySelector(leafClassOnly);
          if (el) return el;
        } catch {}
      }
    }
  }

  return null;
}

export function distinguishPrices(cardEl) {
  if (!cardEl) {
    return { selling_price: null, mrp: null, currency: null };
  }

  const strikeElements = cardEl.querySelectorAll(
    'del, s, strike, [class*="strike"], [class*="original"], [class*="mrp"], [class*="list-price"], [class*="old-price"], [class*="was-price"], [data-price-type="old"]'
  );

  let detectedMrp = null;
  let detectedMrpCurrency = null;

  for (const el of strikeElements) {
    const parsed = parseCurrencyAndPrice(el.textContent);
    if (parsed.price !== null) {
      detectedMrp = parsed.price;
      detectedMrpCurrency = parsed.currency;
      break;
    }
  }

  const priceElements = cardEl.querySelectorAll(
    '[class*="price"], [class*="prix"], [class*="tarif"], [class*="amount"], [class*="selling"], [class*="special"], [class*="current"], [class*="sale"], [data-price], [itemprop="price"], span, div, p'
  );

  let detectedSelling = null;
  let detectedSellingCurrency = null;

  for (const el of priceElements) {
    if (
      el.closest('del, s, strike, [class*="strike"], [class*="original"], [class*="old-price"], [class*="was-price"]') ||
      el.closest('[class*="rating"], [class*="review"], [class*="star"], [aria-label*="star"], [aria-label*="rating"]')
    ) {
      continue;
    }

    if (el.children && el.children.length > 2) {
      continue;
    }

    const txt = normalizeText(el.textContent);
    if (!txt || txt.length > 50) {
      continue;
    }

    const isExplicitPriceClass =
      el.matches('[class*="price"], [class*="prix"], [class*="tarif"], [class*="amount"], [class*="selling"], [class*="special"], [class*="current"], [class*="sale"], [data-price], [itemprop="price"]');

    const parsed = parseCurrencyAndPrice(txt);
    if (parsed.price !== null) {
      if (!isExplicitPriceClass && !parsed.currency) {
        continue;
      }
      if (detectedMrp !== null && parsed.price === detectedMrp) {
        continue;
      }
      detectedSelling = parsed.price;
      detectedSellingCurrency = parsed.currency;
      break;
    }
  }

  if (detectedSelling === null && detectedMrp !== null) {
    detectedSelling = detectedMrp;
    detectedMrp = null;
    detectedSellingCurrency = detectedMrpCurrency;
  }

  if (detectedSelling !== null && detectedMrp !== null) {
    if (detectedSelling > detectedMrp) {
      const temp = detectedSelling;
      detectedSelling = detectedMrp;
      detectedMrp = temp;
    }
  }

  const finalCurrency = detectedSellingCurrency || detectedMrpCurrency || null;

  return {
    selling_price: detectedSelling,
    mrp: detectedMrp,
    currency: finalCurrency
  };
}

export function parseRating(cardEl) {
  if (!cardEl) {
    return null;
  }

  const ratingElements = [];
  if (cardEl.matches && cardEl.matches('[class*="rating"], [class*="star"], [aria-label*="star"], [aria-label*="rating"], [data-rating], [itemprop="ratingValue"]')) {
    ratingElements.push(cardEl);
  }
  if (cardEl.getAttribute && (cardEl.getAttribute('aria-label') || cardEl.getAttribute('data-rating') || cardEl.getAttribute('data-score') || cardEl.getAttribute('content'))) {
    if (!ratingElements.includes(cardEl)) {
      ratingElements.push(cardEl);
    }
  }
  if (cardEl.querySelectorAll) {
    ratingElements.push(
      ...Array.from(
        cardEl.querySelectorAll(
          '[class*="rating"], [class*="star"], [aria-label*="star"], [aria-label*="rating"], [data-rating], [itemprop="ratingValue"]'
        )
      )
    );
  }

  for (const el of ratingElements) {
    const ariaLabel = el.getAttribute('aria-label');
    const dataRating = el.getAttribute('data-rating') || el.getAttribute('data-score');
    const itemprop = el.getAttribute('content');
    const text = normalizeText(el.textContent);

    const candidates = [ariaLabel, dataRating, itemprop, text].filter(Boolean);

    for (const candidate of candidates) {
      const match = candidate.match(/(?:^|\s)([0-5](?:\.\d+)?)\s*(?:out of 5|stars?|\/5|\/ 5|★)?/i);
      if (match) {
        const val = parseFloat(match[1]);
        if (Number.isFinite(val) && val >= 0 && val <= 5) {
          return val;
        }
      }
    }
  }

  return null;
}

export function parseCounts(cardEl) {
  if (!cardEl) {
    return { rating_count: null, review_count: null };
  }

  const countElements = [];
  if (cardEl.textContent) {
    countElements.push(cardEl);
  }
  if (cardEl.querySelectorAll) {
    countElements.push(
      ...Array.from(
        cardEl.querySelectorAll(
          '[class*="review"], [class*="rating"], [class*="count"], a, span'
        )
      )
    );
  }

  let foundRatingCount = null;
  let foundReviewCount = null;

  for (const el of countElements) {
    const text = normalizeText(el.textContent);
    if (!text || text.length > 80) {
      continue;
    }

    const dualMatch = text.match(/([\d,]+)\s*(?:ratings?|global ratings?)\s*(?:and|&|,)\s*([\d,]+)\s*reviews?/i);
    if (dualMatch) {
      foundRatingCount = parseInt(dualMatch[1].replace(/,/g, ''), 10);
      foundReviewCount = parseInt(dualMatch[2].replace(/,/g, ''), 10);
      break;
    }

    if (foundRatingCount === null) {
      const ratingMatch = text.match(/([\d,]+)\s*(?:ratings?|global ratings?|customer ratings?)/i);
      if (ratingMatch) {
        foundRatingCount = parseInt(ratingMatch[1].replace(/,/g, ''), 10);
      }
    }

    if (foundReviewCount === null) {
      const reviewMatch = text.match(/([\d,]+)\s*(?:reviews?|customer reviews?|user reviews?|avis)/i);
      if (reviewMatch) {
        foundReviewCount = parseInt(reviewMatch[1].replace(/,/g, ''), 10);
      }
    }

    if (foundRatingCount === null && foundReviewCount === null) {
      const parenMatch = text.match(/^\s*\(([\d,]+)\)\s*$/);
      if (parenMatch) {
        foundRatingCount = parseInt(parenMatch[1].replace(/,/g, ''), 10);
      }
    }
  }

  return {
    rating_count: Number.isFinite(foundRatingCount) ? foundRatingCount : null,
    review_count: Number.isFinite(foundReviewCount) ? foundReviewCount : null
  };
}

export function extractImageUrl(cardEl, baseUrl) {
  if (!cardEl) {
    return null;
  }

  const images = [];
  if (cardEl.matches && cardEl.matches('img, source')) {
    images.push(cardEl);
  }
  if (cardEl.querySelectorAll) {
    images.push(...Array.from(cardEl.querySelectorAll('img, source')));
  }
  for (const img of images) {
    const candidates = [
      img.getAttribute('data-src'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-high-res-src'),
      img.getAttribute('data-image'),
      img.getAttribute('data-zoom-image')
    ];

    for (const attr of candidates) {
      if (attr && !attr.startsWith('data:image/gif')) {
        const resolved = resolveAbsoluteUrl(attr, baseUrl);
        if (resolved) {
          return resolved;
        }
      }
    }

    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      const entries = srcset.split(',').map((s) => s.trim().split(' '));
      if (entries.length > 0 && entries[0][0]) {
        const resolved = resolveAbsoluteUrl(entries[entries.length - 1][0], baseUrl);
        if (resolved && !resolved.startsWith('data:image/gif')) {
          return resolved;
        }
      }
    }

    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:image/gif')) {
      const resolved = resolveAbsoluteUrl(src, baseUrl);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

export function extractProductId(cardEl, productUrl) {
  if (!cardEl) {
    return null;
  }

  const idAttributes = [
    'data-product-id',
    'data-item-id',
    'data-pid',
    'data-asin',
    'data-id',
    'data-sku',
    'data-itemid',
    'data-entity-id'
  ];

  for (const attr of idAttributes) {
    const directVal = cardEl.getAttribute(attr);
    if (directVal && directVal.trim()) {
      return directVal.trim();
    }
  }

  for (const attr of idAttributes) {
    const child = cardEl.querySelector(`[${attr}]`);
    if (child) {
      const val = child.getAttribute(attr);
      if (val && val.trim()) {
        return val.trim();
      }
    }
  }

  if (productUrl) {
    try {
      const parsedUrl = new URL(productUrl);
      const queryParams = ['id', 'pid', 'productId', 'product_id', 'itemId', 'item_id', 'sku', 'asin'];
      for (const param of queryParams) {
        const val = parsedUrl.searchParams.get(param);
        if (val && val.trim()) {
          return val.trim();
        }
      }

      const path = parsedUrl.pathname;
      const dpMatch = path.match(/\/dp\/([A-Z0-9]{8,12})(?:\/|$)/i);
      if (dpMatch) {
        return dpMatch[1];
      }
      const productMatch = path.match(/\/(?:p|product|item|itm)\/([a-zA-Z0-9_-]{4,32})(?:\/|$|\.)/i);
      if (productMatch) {
        return productMatch[1];
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function extractTitle(cardEl) {
  if (!cardEl) {
    return null;
  }

  const headings = cardEl.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="title"], [class*="name"], [itemprop="name"]');
  for (const h of headings) {
    const txt = normalizeText(h.textContent);
    if (txt && txt.length >= 3 && !txt.match(/^(?:sponsored|sale|new|best seller|out of stock)$/i)) {
      return txt;
    }
  }

  const anchors = cardEl.querySelectorAll('a');
  for (const a of anchors) {
    const txt = normalizeText(a.textContent);
    if (txt && txt.length >= 6 && !txt.match(/^(?:quick view|add to cart|buy now|view details)$/i)) {
      return txt;
    }
  }

  return null;
}

export function extractProductUrl(cardEl, baseUrl) {
  if (!cardEl) {
    return null;
  }

  const titleLink = cardEl.querySelector('h1 a, h2 a, h3 a, h4 a, [class*="title"] a, [class*="name"] a');
  if (titleLink && titleLink.getAttribute('href')) {
    const resolved = resolveAbsoluteUrl(titleLink.getAttribute('href'), baseUrl);
    if (resolved) {
      return resolved;
    }
  }

  const anchors = cardEl.querySelectorAll('a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const resolved = resolveAbsoluteUrl(href, baseUrl);
    if (resolved && !resolved.includes('javascript:') && !resolved.endsWith('#')) {
      return resolved;
    }
  }

  return null;
}

export function extractExtraAttributes(cardEl) {
  const extra = {};
  if (!cardEl) {
    return extra;
  }

  const badgeEl = cardEl.querySelector('.badge, span[class*="badge"], span[class*="tag"], span[class*="label"], [class*="ribbon"]');
  if (badgeEl) {
    const badgeText = normalizeText(badgeEl.textContent);
    if (badgeText) {
      extra.badge = badgeText;
    }
  }

  const discountEl = cardEl.querySelector('.discount, span[class*="discount"], [class*="save"], [class*="off"]');
  if (discountEl) {
    const discountText = normalizeText(discountEl.textContent);
    if (discountText) {
      extra.discount = discountText;
    }
  }

  const brandEl = cardEl.querySelector('[class*="brand"], [itemprop="brand"]');
  if (brandEl) {
    const brandText = normalizeText(brandEl.textContent);
    if (brandText) {
      extra.brand = brandText;
    }
  }

  const shippingEl = cardEl.querySelector('[class*="delivery"], [class*="shipping"]');
  if (shippingEl) {
    const shippingText = normalizeText(shippingEl.textContent);
    if (shippingText) {
      extra.shipping = shippingText;
    }
  }

  const isSponsored = Boolean(cardEl.querySelector('[class*="sponsored"]') || normalizeText(cardEl.textContent).match(/\bsponsored\b/i));
  if (isSponsored) {
    extra.is_sponsored = true;
  }

  return extra;
}
