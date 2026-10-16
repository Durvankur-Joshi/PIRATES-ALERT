import { parseCurrencyAndPrice } from './utils.js';

const EXCLUDED_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);

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
      id.includes('pagination') ||
      id.includes('footer')
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
    el.hasAttribute('data-product-id') ||
    el.hasAttribute('data-item-id') ||
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

export function findProductCards(rootDoc, customCardSelector = null) {
  if (!rootDoc) {
    return { candidateCards: [], method: 'heuristic' };
  }

  if (customCardSelector && typeof customCardSelector === 'string') {
    try {
      const selected = Array.from(rootDoc.querySelectorAll(customCardSelector));
      if (selected.length > 0) {
        return {
          candidateCards: selected.filter((el) => !isInsideExcludedContainer(el)),
          method: 'rule'
        };
      }
    } catch {
      return { candidateCards: [], method: 'rule' };
    }
  }

  const directSelectors = [
    '[data-component-type="s-search-result"]',
    '[data-asin]:not([data-asin=""])',
    '[data-pid]:not([data-pid=""])',
    '[data-product-id]:not([data-product-id=""])',
    '[itemtype*="schema.org/Product"]',
    '[class*="product-card"]',
    '[class*="product-item"]',
    '[class*="product_card"]',
    '[class*="search-result-item"]',
    '[class*="s-result-item"]',
    '[class*="productCard"]'
  ];

  let bestDirect = [];
  for (const selector of directSelectors) {
    const directElements = Array.from(rootDoc.querySelectorAll(selector));
    const valid = directElements.filter((el) => !isInsideExcludedContainer(el) && scoreElement(el) >= 6);
    if (valid.length > bestDirect.length) {
      bestDirect = valid;
    }
  }

  if (bestDirect.length >= 2) {
    const parent = bestDirect[0].parentElement;
    if (parent) {
      const allSiblings = Array.from(parent.children);
      const validSiblings = allSiblings.filter((el) => !isInsideExcludedContainer(el) && scoreElement(el) >= 6);
      if (validSiblings.length >= bestDirect.length) {
        bestDirect = validSiblings;
      }
    }
    return { candidateCards: bestDirect, method: 'heuristic_structured' };
  }

  const allElements = Array.from(rootDoc.querySelectorAll('div, li, article, section'));
  const candidateScores = new Map();

  for (const el of allElements) {
    const s = scoreElement(el);
    if (s >= 7) {
      candidateScores.set(el, s);
    }
  }

  const parentGroups = new Map();
  for (const [el, s] of candidateScores.entries()) {
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
    return {
      candidateCards: bestGroup.map((item) => item.el),
      method: 'heuristic_repeating'
    };
  }

  const highScoring = Array.from(candidateScores.keys());
  const nonContained = highScoring.filter((candidate) => {
    return !highScoring.some((other) => other !== candidate && other.contains(candidate));
  });

  return {
    candidateCards: nonContained,
    method: 'heuristic_fallback'
  };
}
