import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseCurrencyAndPrice, extractPriceFromElement, queryCardElement, distinguishPrices } from '../src/modules/extractor/utils.js';
import { findProductCards, sampleCardSnippetsForAi, cleanCardElementSnippet } from '../src/modules/extractor/cardDetector.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { formatExtractionPayload, serializeToJson } from '../src/modules/export/index.js';
import { rulesRepository, computeLayoutFingerprint } from '../src/modules/rules/index.js';
import { aiLearning, validateAiRuleResponse, getAiLogs, clearAiLogs } from '../src/modules/ai/index.js';
import { EXTRACTION_SOURCE } from '../src/modules/messaging/protocol.js';

describe('Price Extraction, Layout Learning, and Rule Validation Robustness', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
    await clearAiLogs();
    aiLearning.setMockProvider(null);
  });

  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it('correctly normalizes diverse international currency formats and thousands separators', () => {
    expect(parseCurrencyAndPrice('$19.99')).toEqual({ currency: '$', price: 19.99 });
    expect(parseCurrencyAndPrice('$ 1,499.50 USD')).toEqual({ currency: '$', price: 1499.50 });
    expect(parseCurrencyAndPrice('149,99 €')).toEqual({ currency: '€', price: 149.99 });
    expect(parseCurrencyAndPrice('1.499,99 €')).toEqual({ currency: '€', price: 1499.99 });
    expect(parseCurrencyAndPrice('1 499 €')).toEqual({ currency: '€', price: 1499 });
    expect(parseCurrencyAndPrice('£45.00')).toEqual({ currency: '£', price: 45.00 });
    expect(parseCurrencyAndPrice('₹12,499')).toEqual({ currency: '₹', price: 12499 });
    expect(parseCurrencyAndPrice('₹1,23,499')).toEqual({ currency: '₹', price: 123499 });
    expect(parseCurrencyAndPrice('₹1,49,999.50')).toEqual({ currency: '₹', price: 149999.50 });
    expect(parseCurrencyAndPrice('Rs. 499')).toEqual({ currency: '₹', price: 499 });
    expect(parseCurrencyAndPrice('Rs 1,299.00')).toEqual({ currency: '₹', price: 1299 });
    expect(parseCurrencyAndPrice('INR 5,999')).toEqual({ currency: 'INR', price: 5999 });
  });

  it('handles discount percentages without confusing discounts with selling prices', () => {
    const res = parseCurrencyAndPrice('Save 20% off $49.99');
    expect(res.currency).toBe('$');
    expect(res.price).toBe(49.99);

    const res2 = parseCurrencyAndPrice('₹1,999 (45% OFF)');
    expect(res2.currency).toBe('₹');
    expect(res2.price).toBe(1999);
  });

  it('extracts prices from attributes such as content and data-price', () => {
    const dom = new JSDOM(`
      <div class="product-card">
        <meta itemprop="price" content="29.99">
        <span class="currency" itemprop="priceCurrency" content="USD">$</span>
        <div class="btn" data-price="29.99" data-currency="USD">Buy</div>
      </div>
    `);

    const card = dom.window.document.querySelector('.product-card');
    const metaEl = card.querySelector('meta[itemprop="price"]');
    const btnEl = card.querySelector('.btn');

    expect(extractPriceFromElement(metaEl, true)).toEqual({ currency: null, price: 29.99 });
    expect(extractPriceFromElement(btnEl, true)).toEqual({ currency: null, price: 29.99 });
  });

  it('resolves tag-mismatched selectors like div.price-item--sale to span.price-item--sale', () => {
    const dom = new JSDOM(`
      <div class="card">
        <h2 class="title">Wireless Earbuds</h2>
        <div class="price-container">
          <span class="visually-hidden">Regular price</span>
          <s class="price-item price-item--regular">$ 49.99 USD</s>
          <span class="visually-hidden">Sale price</span>
          <span class="price-item price-item--sale">$ 29.99 USD</span>
        </div>
      </div>
    `);

    const card = dom.window.document.querySelector('.card');
    const resolvedEl = queryCardElement(card, 'div.price-item--sale');
    expect(resolvedEl).not.toBeNull();
    expect(resolvedEl.tagName).toBe('SPAN');

    const priceData = extractPriceFromElement(resolvedEl, true);
    expect(priceData.price).toBe(29.99);
    expect(priceData.currency).toBe('$');
  });

  it('separates selling price and MRP when price selector targets a container element containing both', () => {
    const dom = new JSDOM(`
      <div class="card">
        <h2 class="title">Gaming Laptop</h2>
        <div class="price-wrapper">
          <span class="current-price">$ 999.00</span>
          <del class="original-price">$ 1,299.00</del>
        </div>
      </div>
    `);

    const card = dom.window.document.querySelector('.card');
    const containerEl = card.querySelector('.price-wrapper');

    const selling = extractPriceFromElement(containerEl, true);
    expect(selling.price).toBe(999.00);

    const mrp = extractPriceFromElement(containerEl, false);
    expect(mrp.price).toBe(1299.00);
  });

  it('1. accepts null MRP and rating selectors and normalizes them properly', () => {
    const validProposal = {
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.price',
        urlSelector: 'a.link',
        mrpSelector: null,
        ratingSelector: '',
        imageSelector: null
      },
      confidence: 0.9
    };

    const result = validateAiRuleResponse(validProposal);
    expect(result.valid).toBe(true);
    expect(result.rule.fieldSelectors.mrpSelector).toBeNull();
    expect(result.rule.fieldSelectors.ratingSelector).toBeNull();
    expect(result.rule.fieldSelectors.imageSelector).toBeNull();
    expect(result.rule.fieldSelectors.titleSelector).toBe('.title');
    expect(result.rule.fieldSelectors.priceSelector).toBe('.price');
    expect(result.rule.fieldSelectors.urlSelector).toBe('a.link');
  });

  it('2. rejects invalid types for required and optional selectors', () => {
    expect(validateAiRuleResponse({
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: 123,
        priceSelector: '.price',
        urlSelector: 'a'
      }
    }).valid).toBe(false);

    expect(validateAiRuleResponse({
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: null,
        urlSelector: 'a'
      }
    }).valid).toBe(false);

    expect(validateAiRuleResponse({
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.price',
        urlSelector: 'a',
        mrpSelector: 123
      }
    }).valid).toBe(false);

    const dom = new JSDOM('<div class="card"><h2 class="title">T</h2><span class="p">10</span></div>');
    const docCheck = validateRuleAgainstDoc({
      cardSelector: '.card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: 999
      }
    }, dom.window.document);
    expect(docCheck.valid).toBe(false);
    expect(docCheck.invalidFields).toContain('priceSelector');
    expect(docCheck.errors.some((e) => e.includes('invalid type'))).toBe(true);
  });

  it('3. rejects malformed CSS selectors with descriptive error', () => {
    const invalidCardCss = validateAiRuleResponse({
      cardSelector: 'div[class=',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.price',
        urlSelector: 'a'
      }
    });
    expect(invalidCardCss.valid).toBe(false);
    expect(invalidCardCss.error).toContain('invalid CSS syntax');

    const invalidFieldCss = validateAiRuleResponse({
      cardSelector: '.card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: 'span[',
        urlSelector: 'a'
      }
    });
    expect(invalidFieldCss.valid).toBe(false);
    expect(invalidFieldCss.error).toContain('invalid CSS syntax');

    const dom = new JSDOM('<div class="card"></div>');
    const docCheck = validateRuleAgainstDoc({
      cardSelector: '.card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: 'span[class='
      }
    }, dom.window.document);
    expect(docCheck.valid).toBe(false);
    expect(docCheck.invalidFields).toContain('priceSelector');
    expect(docCheck.errors.some((e) => e.includes('invalid CSS syntax'))).toBe(true);
  });

  it('4. reports syntactically valid selectors with zero matches', () => {
    const dom = new JSDOM(`
      <div class="list">
        <div class="item">
          <h2 class="title">Keyboard</h2>
          <a class="link" href="/kb">Link</a>
        </div>
      </div>
    `);

    const rule = {
      cardSelector: '.item',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.nonexistent-amount-class',
        urlSelector: '.link'
      }
    };

    const validation = validateRuleAgainstDoc(rule, dom.window.document);
    expect(validation.valid).toBe(false);
    expect(validation.invalidFields).toContain('priceSelector');
    expect(validation.errors.some((e) => e.includes('matched 0 elements across all sampled cards'))).toBe(true);
  });

  it('5. detects a selector that matches elements but yields no valid price', () => {
    const dom = new JSDOM(`
      <div class="list">
        <div class="item">
          <h2 class="title">Item 1</h2>
          <a class="link" href="/item1">Link</a>
          <span class="status-badge">In Stock</span>
        </div>
        <div class="item">
          <h2 class="title">Item 2</h2>
          <a class="link" href="/item2">Link</a>
          <span class="status-badge">Out of Stock</span>
        </div>
      </div>
    `);

    const rule = {
      cardSelector: '.item',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.status-badge',
        urlSelector: '.link'
      }
    };

    const validation = validateRuleAgainstDoc(rule, dom.window.document);
    expect(validation.valid).toBe(false);
    expect(validation.invalidFields).toContain('priceSelector');
    expect(validation.errors.some((e) => e.includes('failed to extract valid prices on any card'))).toBe(true);
  });

  it('6. separates selling price and strikethrough MRP and ensures selling_price <= mrp', () => {
    const dom = new JSDOM(`
      <div class="card">
        <h2 class="title">Smart Watch</h2>
        <div class="pricing">
          <span class="active-price">$ 199.00</span>
          <del class="original-mrp">$ 249.00</del>
        </div>
        <a href="/watch" class="url">View</a>
      </div>
    `);

    const rule = {
      cardSelector: '.card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.active-price',
        mrpSelector: '.original-mrp',
        urlSelector: '.url'
      }
    };

    const validation = validateRuleAgainstDoc(rule, dom.window.document);
    expect(validation.valid).toBe(true);
    expect(validation.sampleItems[0].selling_price).toBe(199.00);
    expect(validation.sampleItems[0].mrp).toBe(249.00);
    expect(validation.sampleItems[0].selling_price).toBeLessThanOrEqual(validation.sampleItems[0].mrp);
  });

  it('7. reliably validates different product-card HTML layouts (table rows, flex, and article)', () => {
    const tableDom = new JSDOM(`
      <table class="products-table">
        <tbody>
          <tr class="product-row">
            <td><a class="title-link" href="/item-a">Table Item A</a></td>
            <td class="price-cell">$ 15.00</td>
          </tr>
          <tr class="product-row">
            <td><a class="title-link" href="/item-b">Table Item B</a></td>
            <td class="price-cell">$ 25.00</td>
          </tr>
        </tbody>
      </table>
    `);

    const tableValidation = validateRuleAgainstDoc({
      cardSelector: 'tr.product-row',
      fieldSelectors: {
        titleSelector: '.title-link',
        urlSelector: '.title-link',
        priceSelector: '.price-cell'
      }
    }, tableDom.window.document);
    expect(tableValidation.valid).toBe(true);
    expect(tableValidation.acceptedCount).toBe(2);

    const articleDom = new JSDOM(`
      <main class="grid">
        <article class="product-card">
          <h3 class="prod-heading"><a href="/art1">Article 1</a></h3>
          <span class="cost">$ 49.99</span>
        </article>
      </main>
    `);

    const articleValidation = validateRuleAgainstDoc({
      cardSelector: 'article.product-card',
      fieldSelectors: {
        titleSelector: '.prod-heading',
        urlSelector: '.prod-heading a',
        priceSelector: '.cost'
      }
    }, articleDom.window.document);
    expect(articleValidation.valid).toBe(true);
    expect(articleValidation.acceptedCount).toBe(1);
  });

  it('8. returns null for unavailable optional fields in canonical extraction results and JSON export', async () => {
    const dom = new JSDOM(`
      <div class="catalog">
        <div class="product">
          <h2 class="name">Minimal Product</h2>
          <span class="price">$ 10.00</span>
          <a href="/prod" class="link">View</a>
        </div>
      </div>
    `);

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://store.example.com/items',
      rules: {
        cardSelector: '.product',
        titleSelector: '.name',
        priceSelector: '.price',
        urlSelector: '.link',
        mrpSelector: null,
        ratingSelector: null,
        imageSelector: null
      }
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(1);
    const item = result.items[0];
    expect(item.mrp).toBeNull();
    expect(item.rating).toBeNull();
    expect(item.rating_count).toBeNull();
    expect(item.review_count).toBeNull();

    const payload = formatExtractionPayload({ url: 'https://store.example.com/items', title: 'Catalog' }, result.items);
    const jsonStr = serializeToJson(payload, false);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.items[0].mrp).toBeNull();
    expect(parsed.items[0].rating).toBeNull();
  });

  it('9. prevents rule saving when Gemini returns a historical selector unsupported by the current DOM', () => {
    const dom = new JSDOM(`
      <div class="shelf">
        <div class="item">
          <h2 class="item-name">Smartphone</h2>
          <span class="current-deal-price">₹14,999</span>
          <a class="item-link" href="/phone">View</a>
        </div>
      </div>
    `);

    const hallucinatedHistoricalRule = {
      cardSelector: '.item',
      fieldSelectors: {
        titleSelector: '.item-name',
        priceSelector: '._30jeq3',
        urlSelector: '.item-link'
      }
    };

    const validation = validateRuleAgainstDoc(hallucinatedHistoricalRule, dom.window.document);
    expect(validation.valid).toBe(false);
    expect(validation.invalidFields).toContain('priceSelector');
    expect(validation.errors.some((e) => e.includes('matched 0 elements across all sampled cards'))).toBe(true);
  });

  it('10. retries failed selector with feedback and blocks rule saving until validation passes', async () => {
    const dom = new JSDOM(`
      <div class="product-grid">
        <div class="product-card">
          <h2 class="title">Ergonomic Mouse</h2>
          <span class="price-val">$ 25.00</span>
          <a href="/mouse" class="link">View</a>
        </div>
      </div>
    `);

    let callCount = 0;
    aiLearning.setMockProvider((payload) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          cardSelector: '.product-card',
          fieldSelectors: {
            titleSelector: '.title',
            priceSelector: 'div.wrong-price-selector',
            urlSelector: 'a.link'
          },
          confidence: 0.7
        };
      }
      expect(payload.feedback).not.toBeNull();
      expect(payload.feedback.invalidFields).toContain('priceSelector');
      return {
        cardSelector: '.product-card',
        fieldSelectors: {
          titleSelector: '.title',
          priceSelector: '.price-val',
          urlSelector: 'a.link'
        },
        confidence: 0.95
      };
    });

    let currentRule = null;
    let validation = null;
    let feedback = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await aiLearning.learnLayout({
        hostname: 'example.com',
        feedback
      });

      currentRule = {
        cardSelector: res.proposedRule.cardSelector,
        fieldSelectors: res.proposedRule.fieldSelectors
      };

      validation = validateRuleAgainstDoc(currentRule, dom.window.document, 'https://example.com');
      if (validation.valid) break;

      feedback = {
        attempt,
        invalidFields: validation.invalidFields,
        errors: validation.errors
      };
    }

    expect(callCount).toBe(2);
    expect(validation.valid).toBe(true);
    expect(validation.acceptedCount).toBe(1);
    expect(currentRule.fieldSelectors.priceSelector).toBe('.price-val');

    const saveRes = await rulesRepository.saveRule({
      hostname: 'example.com',
      layoutFingerprint: 'fp_retry_mouse',
      cardSelector: currentRule.cardSelector,
      fieldSelectors: currentRule.fieldSelectors,
      testResults: validation,
      validationStatus: 'VALIDATED'
    });
    expect(saveRes.success).toBe(true);
    expect(saveRes.rule.validationStatus).toBe('VALIDATED');
  });

  it('11. guarantees zero AI calls when reusing a saved rule and formats normalized JSON export', async () => {
    const dom = new JSDOM(`
      <div class="grid">
        <div class="card">
          <h2 class="product-title">Phone Case</h2>
          <span class="price">₹499</span>
          <s class="strike">₹999</s>
          <a class="url" href="/case">View</a>
        </div>
      </div>
    `);

    const hostname = 'shop.in';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const ruleDefinition = {
      id: `rule_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.price',
        mrpSelector: '.strike',
        urlSelector: '.url'
      },
      testResults: { valid: true },
      validationStatus: 'VALIDATED'
    };

    await rulesRepository.saveRule(ruleDefinition);

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://shop.in/search',
      rules: {
        cardSelector: ruleDefinition.cardSelector,
        ...ruleDefinition.fieldSelectors
      }
    });

    expect(result.items.length).toBe(1);
    const item = result.items[0];
    expect(item.selling_price).toBe(499);
    expect(item.mrp).toBe(999);
    expect(item.currency).toBe('₹');

    const logs = await getAiLogs();
    expect(logs.length).toBe(0);

    const payload = formatExtractionPayload({ url: 'https://shop.in/search', title: 'Search' }, result.items);
    payload.extractionSource = EXTRACTION_SOURCE.SAVED_RULE;
    payload.ruleId = ruleDefinition.id;

    const jsonString = serializeToJson(payload, false);
    const parsedJson = JSON.parse(jsonString);

    expect(parsedJson.totalItems).toBe(1);
    expect(parsedJson.items[0].selling_price).toBe(499);
    expect(parsedJson.items[0].mrp).toBe(999);
    expect(parsedJson.items[0].currency).toBe('₹');
    expect(parsedJson.extractionSource).toBe(EXTRACTION_SOURCE.SAVED_RULE);
  });

  it('12. isolates multiple layouts on the same hostname independently without collisions', async () => {
    const hostname = 'multi-store.org';
    const gridDom = new JSDOM(`
      <div class="product-grid-container">
        <div class="grid-card">
          <h3 class="grid-title">Grid Item 1</h3>
          <span class="grid-price">$ 20</span>
          <a href="/g1" class="grid-link">Buy</a>
        </div>
      </div>
    `);

    const tableDom = new JSDOM(`
      <div class="search-results-table">
        <div class="row-entry">
          <h3 class="row-title">Row Item 1</h3>
          <span class="row-price">$ 30</span>
          <a href="/r1" class="row-link">Buy</a>
        </div>
      </div>
    `);

    const fpGrid = computeLayoutFingerprint(gridDom.window.document, hostname);
    const fpTable = computeLayoutFingerprint(tableDom.window.document, hostname);

    expect(fpGrid).not.toBe(fpTable);

    const gridRule = {
      id: `rule_${hostname}_${fpGrid}`,
      hostname,
      layoutFingerprint: fpGrid,
      cardSelector: '.grid-card',
      fieldSelectors: {
        titleSelector: '.grid-title',
        priceSelector: '.grid-price',
        urlSelector: '.grid-link'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    };

    const tableRule = {
      id: `rule_${hostname}_${fpTable}`,
      hostname,
      layoutFingerprint: fpTable,
      cardSelector: '.row-entry',
      fieldSelectors: {
        titleSelector: '.row-title',
        priceSelector: '.row-price',
        urlSelector: '.row-link'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    };

    await rulesRepository.saveRule(gridRule);
    await rulesRepository.saveRule(tableRule);

    const matchedForGrid = await rulesRepository.findMatchingRule(hostname, fpGrid);
    expect(matchedForGrid.cardSelector).toBe('.grid-card');

    const matchedForTable = await rulesRepository.findMatchingRule(hostname, fpTable);
    expect(matchedForTable.cardSelector).toBe('.row-entry');
  });

  it('proves Flipkart layout with top banner rows and data-id cards isolates cards and validates priceSelector div.Nx9bqj', () => {
    let html = '<body><div id="container"><div class="_1YokD2 _3Mn1Gg col-10-12">';
    // Top banner/filter/sort rows (as found on live Flipkart search pages)
    for (let i = 0; i < 5; i++) {
      html += '<div class="cPHDOP col-12-12"><div class="top-banner">Ad / Filter Bar ' + i + '</div></div>';
    }
    // Repeating product rows containing data-id cards with Nx9bqj price
    for (let i = 0; i < 6; i++) {
      html += `
        <div class="cPHDOP col-12-12">
          <div class="_13oc-S" data-id="PROD_${i}">
            <div data-id="PROD_${i}" class="slAVV4">
              <a class="VJA3rP" href="/product-${i}/p/itm${i}">
                <img src="https://example.com/p${i}.jpg" alt="Smart Phone ${i}">
              </a>
              <a class="wjcEIp" href="/product-${i}/p/itm${i}">Smart Phone ${i} (Black, 128 GB)</a>
              <div class="hl05eU">
                <div class="Nx9bqj">₹14,999</div>
                <div class="yRaY8j">₹19,999</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }
    html += '</div></div></body>';

    const dom = new JSDOM(html, { url: 'https://www.flipkart.com/search?q=phone' });
    const doc = dom.window.document;

    // Verify card detector identifies the actual product cards instead of outer row containers
    const cards = findProductCards(doc);
    expect(cards.candidateCards.length).toBe(6);
    expect(cards.candidateCards[0].getAttribute('data-id')).toBe('PROD_0');

    // Verify sampled candidate selectors offer clean card selectors (e.g. div[data-id] or [data-id])
    const { candidateSelectors, domSnippets } = sampleCardSnippetsForAi(doc, 2, 4500);
    expect(candidateSelectors.some((s) => s.includes('data-id'))).toBe(true);
    expect(domSnippets.length).toBe(2);
    expect(domSnippets[0]).toContain('Nx9bqj');

    // Verify rule validation succeeds for div[data-id] and div.Nx9bqj
    const rule = {
      cardSelector: 'div[data-id]',
      fieldSelectors: {
        titleSelector: '.wjcEIp',
        priceSelector: 'div.Nx9bqj',
        mrpSelector: '.yRaY8j',
        urlSelector: 'a.wjcEIp'
      }
    };

    const validation = validateRuleAgainstDoc(rule, doc, 'https://www.flipkart.com');
    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);
    expect(validation.sampleItems[0].selling_price).toBe(14999);
    expect(validation.sampleItems[0].mrp).toBe(19999);
  });

  it('proves rich media e-commerce cards with slideshows (Fabb6 pattern) preserve title and price during snippet extraction and validation', () => {
    const cardHtml = `
      <div id="catalog">
        <product-card class="product-card" data-product-id="1001">
          <a href="/products/shampoo-1" class="product-card__link">
            <span>Salon Moisture Shampoo 500ml</span>
          </a>
          <div class="product-card__content">
            <div class="card-gallery">
              <slideshow-component>
                <slideshow-arrows>
                  <button class="slideshow-arrow prev">Prev</button>
                  <button class="slideshow-arrow next">Next</button>
                </slideshow-arrows>
                <slideshow-slides>
                  <slideshow-slide slide-id="s1">
                    <img src="//cdn.example.com/slide1.jpg?v=123" width="1000" sizes="(min-width: 1000px) 25vw, 100vw">
                  </slideshow-slide>
                  <slideshow-slide slide-id="s2">
                    <img src="//cdn.example.com/slide2.jpg?v=456" width="1000" sizes="(min-width: 1000px) 25vw, 100vw">
                  </slideshow-slide>
                </slideshow-slides>
              </slideshow-component>
            </div>
            <form action="/cart/add">
              <input type="hidden" name="id" value="1001">
              <button type="submit">Quick Add</button>
            </form>
            <h3 class="product-title">Salon Moisture Shampoo 500ml</h3>
            <product-price class="fabb-pricing">
              <div class="fabb-price-row">
                <span class="fabb-price-now">Rs. 899</span>
                <span class="fabb-price-was">Rs. 1,099</span>
              </div>
            </product-price>
          </div>
        </product-card>
        <product-card class="product-card" data-product-id="1002">
          <a href="/products/conditioner-2" class="product-card__link">
            <span>Salon Repair Conditioner 500ml</span>
          </a>
          <div class="product-card__content">
            <h3 class="product-title">Salon Repair Conditioner 500ml</h3>
            <product-price class="fabb-pricing">
              <div class="fabb-price-row">
                <span class="fabb-price-now">Rs. 949</span>
                <span class="fabb-price-was">Rs. 1,199</span>
              </div>
            </product-price>
          </div>
        </product-card>
      </div>
    `;

    const dom = new JSDOM(cardHtml, { url: 'https://www.fabb6.com/search?q=shampoo' });
    const doc = dom.window.document;

    const { candidateSelectors, domSnippets } = sampleCardSnippetsForAi(doc, 2, 4500);
    expect(candidateSelectors.some((s) => s.includes('product-card'))).toBe(true);
    expect(domSnippets[0]).toContain('fabb-price-now');
    expect(domSnippets[0]).toContain('Rs. 899');
    expect(domSnippets[0]).not.toContain('slideshow-arrow');

    const rule = {
      cardSelector: 'product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.fabb-price-now',
        mrpSelector: '.fabb-price-was',
        urlSelector: 'a.product-card__link'
      }
    };

    const validation = validateRuleAgainstDoc(rule, doc, 'https://www.fabb6.com');
    expect(validation.valid).toBe(true);
    expect(validation.sampleItems[0].selling_price).toBe(899);
    expect(validation.sampleItems[0].mrp).toBe(1099);
  });

  it('proves queryCardElement successfully resolves compound leaf selectors when DOM containers vary', () => {
    const dom = new JSDOM(`
      <div class="card">
        <div class="pricing-container">
          <div class="Nx9bqj">₹1,299</div>
        </div>
      </div>
    `);
    const card = dom.window.document.querySelector('.card');

    // Rigid compound selector should resolve to the leaf .Nx9bqj
    const el = queryCardElement(card, 'div.unknown-wrapper > div.Nx9bqj');
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('₹1,299');
  });

  it('proves low match rate flags cardSelector as invalidField to steer AI learning', () => {
    const dom = new JSDOM(`
      <div class="wrapper">
        <div class="card">Empty Card 1</div>
        <div class="card">Empty Card 2</div>
        <div class="card">Empty Card 3</div>
      </div>
    `);

    const rule = {
      cardSelector: '.card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.price'
      }
    };

    const validation = validateRuleAgainstDoc(rule, dom.window.document);
    expect(validation.valid).toBe(false);
    expect(validation.invalidFields).toContain('cardSelector');
  });
});
