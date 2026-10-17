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
} from './utils.js';
import { findProductCards } from './cardDetector.js';

function extractProductFromCard(cardEl, baseUrl, rule = {}) {
  let title = null;
  if (rule.titleSelector) {
    try {
      const el = queryCardElement(cardEl, rule.titleSelector, rule.cardSelector);
      if (el) {
        title = normalizeText(el.textContent);
      }
    } catch {}
  }
  if (!title) {
    title = extractTitle(cardEl);
  }

  let product_url = null;
  if (rule.urlSelector) {
    try {
      const el = queryCardElement(cardEl, rule.urlSelector, rule.cardSelector);
      if (el) {
        const href = el.getAttribute('href') || (el.closest ? el.closest('a')?.getAttribute('href') : null);
        if (href) {
          product_url = resolveAbsoluteUrl(href, baseUrl);
        }
      }
    } catch {}
  }
  if (!product_url) {
    product_url = extractProductUrl(cardEl, baseUrl);
  }

  const product_id = extractProductId(cardEl, product_url);

  let image_url = null;
  if (rule.imageSelector) {
    try {
      const el = queryCardElement(cardEl, rule.imageSelector, rule.cardSelector);
      if (el) {
        image_url = extractImageUrl(el, baseUrl);
      }
    } catch {}
  }
  if (!image_url) {
    image_url = extractImageUrl(cardEl, baseUrl);
  }

  let priceData = null;
  if (rule.priceSelector) {
    try {
      const el = queryCardElement(cardEl, rule.priceSelector, rule.cardSelector);
      if (el) {
        const parsed = extractPriceFromElement(el, true);
        if (parsed.price !== null) {
          priceData = {
            selling_price: parsed.price,
            mrp: null,
            currency: parsed.currency
          };
          if (rule.mrpSelector) {
            const mrpEl = queryCardElement(cardEl, rule.mrpSelector, rule.cardSelector);
            if (mrpEl) {
              const mrpParsed = extractPriceFromElement(mrpEl, false);
              if (mrpParsed.price !== null) {
                priceData.mrp = mrpParsed.price;
                if (!priceData.currency) priceData.currency = mrpParsed.currency;
              }
            }
          }
        }
      }
    } catch {}
  }
  if (!priceData || priceData.selling_price === null) {
    priceData = distinguishPrices(cardEl);
  }

  if (priceData.selling_price !== null && priceData.mrp !== null && priceData.selling_price > priceData.mrp) {
    const temp = priceData.selling_price;
    priceData.selling_price = priceData.mrp;
    priceData.mrp = temp;
  }

  let rating = null;
  if (rule.ratingSelector) {
    try {
      const el = queryCardElement(cardEl, rule.ratingSelector, rule.cardSelector);
      if (el) {
        rating = parseRating(el);
      }
    } catch {}
  }
  if (rating === null) {
    rating = parseRating(cardEl);
  }

  const counts = parseCounts(cardEl);
  const extra = extractExtraAttributes(cardEl);

  return {
    title: title || null,
    product_url: product_url || null,
    product_id: product_id || null,
    image_url: image_url || null,
    selling_price: priceData.selling_price,
    mrp: priceData.mrp,
    currency: priceData.currency,
    rating,
    rating_count: counts.rating_count,
    review_count: counts.review_count,
    extra: extra || {}
  };
}

function calculateFieldDiagnostics(items) {
  const fields = [
    'title',
    'product_url',
    'product_id',
    'image_url',
    'selling_price',
    'mrp',
    'currency',
    'rating',
    'rating_count',
    'review_count'
  ];

  const optionalFields = new Set(['mrp', 'rating', 'rating_count', 'review_count', 'product_id']);
  const diagnostics = {};

  for (const field of fields) {
    const presentCount = items.filter((item) => item[field] !== null && item[field] !== undefined).length;
    const missingCount = items.length - presentCount;
    const isOptional = optionalFields.has(field);

    let status = 'EXTRACTED';
    if (missingCount === items.length) {
      status = isOptional ? 'OPTIONAL_ABSENT' : 'FAILED_MISSING';
    } else if (missingCount > 0) {
      status = isOptional ? 'PARTIALLY_AVAILABLE' : 'INCOMPLETE';
    }

    diagnostics[field] = {
      present: presentCount,
      missing: missingCount,
      fillRate: items.length > 0 ? Math.round((presentCount / items.length) * 100) : 0,
      status
    };
  }

  return diagnostics;
}

export function createExtractionEngine(config = {}) {
  const engineConfig = {
    timeoutMs: config.timeoutMs || 10000,
    ...config
  };

  return {
    isConfigured() {
      return Boolean(engineConfig);
    },
    async execute(context = {}) {
      const doc = context.document || (typeof document !== 'undefined' ? document : null);
      const url = context.url || (typeof window !== 'undefined' ? window.location.href : '');
      const title = context.title || (doc ? doc.title : '');
      const rule = context.rules || {};

      if (!doc) {
        return {
          status: 'ERROR',
          message: 'No document context available for extraction',
          items: [],
          diagnostics: {
            candidateCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            discoveryMethod: 'none',
            fieldDiagnostics: {}
          },
          metadata: { url, title, timestamp: new Date().toISOString() }
        };
      }

      const { candidateCards, method, truncated } = findProductCards(doc, rule.cardSelector);
      const candidateCount = candidateCards.length;

      const acceptedItems = [];
      const seenUrls = new Set();
      const seenIds = new Set();
      let rejectedCount = 0;
      const rejectionReasons = {
        missing_identity: 0,
        duplicate_url: 0,
        duplicate_id: 0
      };

      for (const cardEl of candidateCards) {
        const item = extractProductFromCard(cardEl, url, rule);

        if (!item.title || (item.selling_price === null && item.image_url === null)) {
          rejectedCount += 1;
          rejectionReasons.missing_identity += 1;
          continue;
        }

        if (item.product_url && seenUrls.has(item.product_url)) {
          rejectedCount += 1;
          rejectionReasons.duplicate_url += 1;
          continue;
        }

        if (item.product_id && seenIds.has(item.product_id)) {
          rejectedCount += 1;
          rejectionReasons.duplicate_id += 1;
          continue;
        }

        if (item.product_url) {
          seenUrls.add(item.product_url);
        }
        if (item.product_id) {
          seenIds.add(item.product_id);
        }

        acceptedItems.push(item);
      }

      const acceptedCount = acceptedItems.length;
      const fieldDiagnostics = calculateFieldDiagnostics(acceptedItems);

      let overallStatus = 'SUCCESS';
      let message = `Successfully extracted ${acceptedCount} products.`;

      if (candidateCount === 0) {
        overallStatus = 'EMPTY';
        message = 'No product cards identified on this page.';
      } else if (acceptedCount === 0) {
        overallStatus = 'EMPTY';
        message = 'Candidate cards detected, but none met minimum product criteria.';
      } else if (rejectedCount > 0) {
        overallStatus = 'PARTIAL';
        message = `Extracted ${acceptedCount} products (${rejectedCount} candidates rejected or deduplicated).`;
      }

      return {
        status: overallStatus,
        message,
        items: acceptedItems,
        diagnostics: {
          candidateCount,
          acceptedCount,
          rejectedCount,
          rejectionReasons,
          truncated: Boolean(truncated),
          discoveryMethod: method,
          fieldDiagnostics
        },
        metadata: {
          url,
          title,
          totalExtracted: acceptedCount,
          timestamp: new Date().toISOString()
        }
      };
    },
    getCapabilities() {
      return {
        engineVersion: '3.0.0',
        supportedPipelines: ['saved_rules', 'ai_learning', 'heuristic'],
        activePipeline: 'adaptive_multi_source'
      };
    }
  };
}

export const extractionEngine = createExtractionEngine();
