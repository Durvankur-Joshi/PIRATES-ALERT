import { parseCurrencyAndPrice } from './utils.js';

const EXCLUDED_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'DIALOG']);

function isInsideExcludedContainer(el) {
  let curr = el;
  while (curr && curr !== curr.ownerDocument?.body) {
    if (EXCLUDED_TAGS.has(curr.tagName)) {
      return true;
    }
    const cls = typeof curr.className === 'string' ? curr.className.toLowerCase() : '';
    const id = typeof curr.id === 'string' ? curr.id.toLowerCase() : '';
    if (
      cls.includes('pagination') ||
      cls.includes('nav-') ||
      cls.includes('header') ||
      cls.includes('footer') ||
      cls.includes('sidebar') ||
      cls.includes('breadcrumbs') ||
      cls.includes('advertisement') ||
      cls.includes('ad-container') ||
      cls.includes('ad-banner') ||
      cls.includes('cookie-banner') ||
      cls.includes('modal-backdrop') ||
      id.includes('pagination') ||
      id.includes('footer') ||
      id.includes('advertisement')
    ) {
      return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

function scoreElement(el) {
  if (!el || el.nodeType !== 1 || isInsideExcludedContainer(el)) {
    return 0;
  }

  let score = 0;

  const hasExplicitProductAttr =
    el.hasAttribute('data-asin') ||
    el.hasAttribute('data-pid') ||
    el.hasAttribute('data-id') ||
    el.hasAttribute('data-product-id') ||
    el.hasAttribute('data-item-id') ||
    el.hasAttribute('data-sku') ||
    el.tagName === 'PRODUCT-CARD' ||
    el.getAttribute('itemtype')?.toLowerCase().includes('product');
  if (hasExplicitProductAttr) {
    score += 4;
  }

  const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
  if (cls.match(/\b(?:product|item|search-result|grid-item|card|result-item)\b/)) {
    score += 3;
  }

  const hasImg = Boolean(el.querySelector('img, picture, source'));
  if (hasImg) {
    score += 2;
  }

  const hasLink = Boolean(el.querySelector('a[href]'));
  if (hasLink) {
    score += 2;
  }

  const hasHeading = Boolean(el.querySelector('h1, h2, h3, h4, h5, [class*="title"], [class*="name"]'));
  if (hasHeading) {
    score += 2;
  }

  const text = el.textContent || '';
  const parsedPrice = parseCurrencyAndPrice(text);
  if (parsedPrice.price !== null) {
    score += 3;
  }

  return score;
}

function boundCandidates(cards, method) {
  const isTruncated = cards.length > 250;
  return {
    candidateCards: cards.slice(0, 250),
    method,
    truncated: isTruncated
  };
}

export function findProductCards(rootDoc, customCardSelector = null) {
  if (!rootDoc) {
    return boundCandidates([], 'heuristic');
  }

  if (customCardSelector && typeof customCardSelector === 'string') {
    try {
      const selected = Array.from(rootDoc.querySelectorAll(customCardSelector));
      if (selected.length > 0) {
        return boundCandidates(
          selected.filter((el) => !isInsideExcludedContainer(el)),
          'rule'
        );
      }
    } catch {
      return boundCandidates([], 'rule');
    }
  }

  const directSelectors = [
    '[data-component-type="s-search-result"]',
    '[data-asin]:not([data-asin=""])',
    '[data-pid]:not([data-pid=""])',
    '[data-id]:not([data-id=""])',
    '[data-product-id]:not([data-product-id=""])',
    '[data-item-id]:not([data-item-id=""])',
    '[data-sku]:not([data-sku=""])',
    '[itemtype*="schema.org/Product"]',
    'product-card',
    '[class*="product-card"]',
    '[class*="product-item"]',
    '[class*="product_card"]',
    '[class*="search-result-item"]',
    '[class*="s-result-item"]',
    '[class*="productCard"]',
    '[class*="product-grid__item"]',
    '[class*="grid-product"]'
  ];

  let bestDirect = [];
  for (const selector of directSelectors) {
    const directElements = Array.from(rootDoc.querySelectorAll(selector));
    // Filter out inner sub-elements (like BEM __link, __image) and parent wrappers with child cards
    const valid = directElements.filter((el) => {
      if (isInsideExcludedContainer(el) || scoreElement(el) < 4) return false;
      const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      if (cls.match(/\b\w+__(?:link|title|image|img|media|badge|button|btn|desc|price|cta)\b/)) {
        return false;
      }
      const hasChildMatch = directElements.some((other) => {
        if (other === el || !el.contains(other)) return false;
        const otherHasPrice = parseCurrencyAndPrice(other.textContent || '').price !== null;
        return otherHasPrice && scoreElement(other) >= scoreElement(el);
      });
      return !hasChildMatch;
    });
    if (valid.length > bestDirect.length) {
      bestDirect = valid;
    }
  }

  if (bestDirect.length >= 2) {
    const parent = bestDirect[0].parentElement;
    if (parent) {
      const allSiblings = Array.from(parent.children);
      const validSiblings = allSiblings.filter((el) => !isInsideExcludedContainer(el) && scoreElement(el) >= 4);
      if (validSiblings.length >= bestDirect.length) {
        bestDirect = validSiblings;
      }
    }
    return boundCandidates(bestDirect, 'heuristic_structured');
  }

  const allElements = Array.from(rootDoc.querySelectorAll('div, li, article, section'));
  const candidateScores = new Map();

  for (const el of allElements) {
    const s = scoreElement(el);
    if (s >= 7) {
      candidateScores.set(el, s);
    }
  }

  // Discard ancestor/container candidates that contain another scored candidate
  const candidateList = Array.from(candidateScores.keys());
  const filteredCandidates = candidateList.filter((candidate) => {
    return !candidateList.some((other) => other !== candidate && candidate.contains(other));
  });

  const parentGroups = new Map();
  for (const el of filteredCandidates) {
    const s = candidateScores.get(el);
    const parent = el.parentElement;
    if (!parent) continue;
    if (!parentGroups.has(parent)) {
      parentGroups.set(parent, []);
    }
    parentGroups.get(parent).push({ el, score: s });
  }

  let bestGroup = [];
  for (const group of parentGroups.values()) {
    if (group.length > bestGroup.length && group.length >= 2) {
      bestGroup = group;
    }
  }

  if (bestGroup.length >= 2) {
    return boundCandidates(
      bestGroup.map((item) => item.el),
      'heuristic_repeating'
    );
  }

  const highScoring = Array.from(candidateScores.keys());
  const nonContained = highScoring.filter((candidate) => {
    return !highScoring.some((other) => other !== candidate && other.contains(candidate));
  });

  return boundCandidates(nonContained, 'heuristic_fallback');
}

export function cleanCardElementSnippet(el, maxChars = 4500) {
  if (!el || el.nodeType !== 1) return '';
  const clone = el.cloneNode(true);
  const unwanted = clone.querySelectorAll(
    'script, style, noscript, svg, iframe, canvas, dialog, object, embed, link, meta, ' +
    'slideshow-arrows, [class*="slideshow-control"], [class*="slideshow-arrow"], ' +
    'button, [class*="button-unstyled"], form, input, quick-add-component, [class*="quick-add"]'
  );
  for (const node of unwanted) {
    node.remove();
  }

  // In slideshows/carousels with multiple slides, keep only the first slide/media element
  const slideshowSlides = clone.querySelectorAll('slideshow-slide, [class*="slide"]');
  if (slideshowSlides.length > 1) {
    for (let i = 1; i < slideshowSlides.length; i++) {
      slideshowSlides[i].remove();
    }
  }

  const allElements = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const node of allElements) {
    node.removeAttribute('style');
    node.removeAttribute('sizes');
    node.removeAttribute('srcset');
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith('on:') ||
        name.startsWith('on') ||
        name === 'ref' ||
        name.startsWith('data-media') ||
        name === 'data_max_resolution' ||
        name === 'fetchpriority' ||
        name === 'transitiontoproduct'
      ) {
        node.removeAttribute(attr.name);
      }
    }
    if (node.hasAttribute('src')) {
      const srcVal = node.getAttribute('src') || '';
      if (srcVal.startsWith('data:') && srcVal.length > 80) {
        node.setAttribute('src', 'data:image/...');
      } else if (srcVal.includes('?')) {
        node.setAttribute('src', srcVal.split('?')[0]);
      }
    }
  }
  let html = clone.outerHTML || '';
  html = html.replace(/\s+/g, ' ').trim();
  if (html.length > maxChars) {
    html = html.slice(0, maxChars) + '...</div>';
  }
  return html;
}

export function sampleCardSnippetsForAi(doc, maxSnippets = 2, maxCharsPerSnippet = 4500) {
  if (!doc) {
    return { candidateSelectors: [], domSnippets: [] };
  }

  const heuristicResult = findProductCards(doc);
  let rawCards = [];

  if (heuristicResult && heuristicResult.candidateCards && heuristicResult.candidateCards.length > 0) {
    rawCards = heuristicResult.candidateCards.filter((el) => !isInsideExcludedContainer(el) && scoreElement(el) >= 4);
  }

  if (rawCards.length === 0) {
    const scoredElements = [];
    const elementsToCheck = Array.from(doc.querySelectorAll(
      '[data-asin], [data-pid], [data-id], [data-product-id], [itemtype*="Product"], [class*="product"], [class*="card"], [class*="item"], [class*="result"], div, article, li'
    ));
    for (const el of elementsToCheck) {
      if (isInsideExcludedContainer(el)) continue;
      const score = scoreElement(el);
      if (score >= 4) {
        scoredElements.push({ el, score });
      }
    }
    scoredElements.sort((a, b) => b.score - a.score);
    const nonContained = [];
    for (const item of scoredElements) {
      if (!nonContained.some((other) => other.el.contains(item.el) || item.el.contains(other.el))) {
        nonContained.push(item);
      }
      if (nonContained.length >= maxSnippets) break;
    }
    rawCards = nonContained.map((item) => item.el);
  }

  const selectedCards = rawCards.slice(0, maxSnippets);
  const domSnippets = selectedCards.map((el) => cleanCardElementSnippet(el, maxCharsPerSnippet)).filter(Boolean);

  const candidateSelectors = [];
  for (const el of selectedCards) {
    if (el.getAttribute('data-component-type')) {
      candidateSelectors.push(`[data-component-type="${el.getAttribute('data-component-type')}"]`);
    }
    if (el.hasAttribute('data-asin')) {
      candidateSelectors.push(`${el.tagName.toLowerCase()}[data-asin]`);
      candidateSelectors.push('[data-asin]');
    }
    if (el.hasAttribute('data-pid')) {
      candidateSelectors.push(`${el.tagName.toLowerCase()}[data-pid]`);
      candidateSelectors.push('[data-pid]');
    }
    if (el.hasAttribute('data-id')) {
      candidateSelectors.push(`${el.tagName.toLowerCase()}[data-id]`);
      candidateSelectors.push('[data-id]');
    }
    if (el.hasAttribute('data-product-id')) {
      candidateSelectors.push(`${el.tagName.toLowerCase()}[data-product-id]`);
      candidateSelectors.push('[data-product-id]');
    }
    if (el.hasAttribute('data-item-id')) {
      candidateSelectors.push(`${el.tagName.toLowerCase()}[data-item-id]`);
      candidateSelectors.push('[data-item-id]');
    }
    if (el.tagName.includes('-')) {
      candidateSelectors.push(el.tagName.toLowerCase());
    }
    if (el.className && typeof el.className === 'string') {
      const parts = el.className.trim().split(/\s+/).filter((c) => c && !c.includes(':') && !c.includes('[') && !c.match(/\b(?:col-\d|col-12|col-10|row)\b/i));
      if (parts.length > 0) {
        candidateSelectors.push(`${el.tagName.toLowerCase()}.${parts.slice(0, 2).join('.')}`);
        candidateSelectors.push(`.${parts[0]}`);
      }
    }
  }

  return {
    candidateSelectors: Array.from(new Set(candidateSelectors)).slice(0, 10),
    domSnippets
  };
}

export function hasProductListingEvidence(doc) {
  if (!doc) {
    return false;
  }
  const heuristicResult = findProductCards(doc);
  if (heuristicResult && heuristicResult.candidateCards && heuristicResult.candidateCards.length > 0) {
    return true;
  }
  const elementsToCheck = Array.from(doc.querySelectorAll(
    '[data-asin], [data-pid], [data-product-id], [data-item-id], [itemtype*="Product"], [class*="product"], [class*="card"], [class*="item"], [class*="result"]'
  ));
  for (const el of elementsToCheck) {
    if (isInsideExcludedContainer(el)) continue;
    if (scoreElement(el) >= 4) {
      return true;
    }
  }
  return false;
}

export { isInsideExcludedContainer, scoreElement };
