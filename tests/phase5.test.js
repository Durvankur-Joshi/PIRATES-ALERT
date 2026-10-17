import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { rulesRepository, computeLayoutFingerprint } from '../src/modules/rules/index.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { preferencesRepository, getDefaultFieldPreferences, ALL_CANONICAL_FIELDS } from '../src/modules/preferences/index.js';
import { correctionsRepository, validateFieldValue } from '../src/modules/corrections/index.js';
import { regressionRepository } from '../src/modules/regression/index.js';
import { aiLearning, getAiLogs, clearAiLogs } from '../src/modules/ai/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { resolveAbsoluteUrl, parseCurrencyAndPrice, parseRating, parseCounts } from '../src/modules/extractor/utils.js';
import { findProductCards } from '../src/modules/extractor/cardDetector.js';
import { formatExtractionPayload, serializeToJson } from '../src/modules/export/index.js';
import { MESSAGE_TYPES, EXTRACTION_SOURCE } from '../src/modules/messaging/protocol.js';

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('Phase 5: Final Automated Acceptance Suite', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
    await preferencesRepository.clearAllPreferences();
    await correctionsRepository.clearAllCorrections();
    await regressionRepository.clearAllFixtures();
    await clearAiLogs();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('1. adheres strictly to canonical schema and handles missing optional fields as null', async () => {
    const dom = loadFixture('layout-grid.html', 'https://store.example.com');
    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://store.example.com/search'
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBeGreaterThan(0);

    const first = result.items[0];
    const canonicalKeys = [
      'title',
      'product_url',
      'product_id',
      'image_url',
      'selling_price',
      'mrp',
      'currency',
      'rating',
      'rating_count',
      'review_count',
      'extra'
    ];

    for (const key of canonicalKeys) {
      expect(key in first).toBe(true);
    }

    expect(typeof first.title).toBe('string');
    expect(typeof first.selling_price).toBe('number');
  });

  it('2. safely normalizes URLs, prices, ratings, and rejects dangerous protocols like javascript:', () => {
    expect(resolveAbsoluteUrl('javascript:alert(1)', 'https://example.com')).toBeNull();
    expect(resolveAbsoluteUrl('JAVASCRIPT:void(0)', 'https://example.com')).toBeNull();
    expect(resolveAbsoluteUrl('data:text/html,bad', 'https://example.com')).toBeNull();
    expect(resolveAbsoluteUrl('vbscript:msgbox', 'https://example.com')).toBeNull();
    expect(resolveAbsoluteUrl('#section', 'https://example.com')).toBeNull();

    expect(resolveAbsoluteUrl('/item/123', 'https://example.com')).toBe('https://example.com/item/123');
    expect(resolveAbsoluteUrl('https://example.com/item/123', 'https://other.com')).toBe('https://example.com/item/123');

    const parsedPrice = parseCurrencyAndPrice('$1,499.99');
    expect(parsedPrice.price).toBe(1499.99);
    expect(parsedPrice.currency).toBe('$');

    const parsedEuro = parseCurrencyAndPrice('49,90 €');
    expect(parsedEuro.price).toBe(49.9);

    const doc = new JSDOM('<div aria-label="Rated 4.8 out of 5 stars">Rating</div>').window.document;
    const ratingVal = parseRating(doc.querySelector('div'));
    expect(ratingVal).toBe(4.8);

    const countDoc = new JSDOM('<div>1,420 ratings and 250 reviews</div>').window.document;
    const counts = parseCounts(countDoc.querySelector('div'));
    expect(counts.rating_count).toBe(1420);
    expect(counts.review_count).toBe(250);
  });

  it('3. rejects false positives such as navigation, headers, footers, and deduplicates identical cards', async () => {
    const rawHtml = `
      <html>
        <body>
          <nav>
            <div class="product-item">
              <a href="/nav-item">Nav Link Fake Product</a>
              <span>$10.00</span>
            </div>
          </nav>
          <main>
            <div class="product-item">
              <a href="/product/1">Genuine Product 1</a>
              <span>$29.00</span>
              <img src="/img1.jpg" />
            </div>
            <div class="product-item">
              <a href="/product/1">Duplicate of Product 1</a>
              <span>$29.00</span>
              <img src="/img1.jpg" />
            </div>
            <div class="product-item">
              <a href="/product/2">Genuine Product 2</a>
              <span>$49.00</span>
              <img src="/img2.jpg" />
            </div>
          </main>
          <footer>
            <div class="product-item">
              <a href="/footer-item">Footer Link</a>
              <span>$5.00</span>
            </div>
          </footer>
        </body>
      </html>
    `;

    const dom = new JSDOM(rawHtml, { url: 'https://shop.com/catalog' });
    const engine = createExtractionEngine();
    const res = await engine.execute({
      document: dom.window.document,
      url: 'https://shop.com/catalog'
    });

    expect(res.status).toBe('PARTIAL');
    expect(res.items.length).toBe(2);
    expect(res.items[0].product_url).toBe('https://shop.com/product/1');
    expect(res.items[1].product_url).toBe('https://shop.com/product/2');
    expect(res.diagnostics.rejectedCount).toBeGreaterThan(0);
  });

  it('4. matches exact validated saved rule and extracts with zero AI calls', async () => {
    const dom = loadFixture('layout-custom.html', 'https://mystore.com/search');
    const hostname = 'mystore.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const validation = validateRuleAgainstDoc(
      {
        hostname,
        layoutFingerprint: fingerprint,
        cardSelector: '.custom-catalog-item',
        fieldSelectors: {
          titleSelector: '.item-heading',
          priceSelector: '.amount-tag',
          imageSelector: '.lazy-prod'
        }
      },
      dom.window.document,
      'https://mystore.com/search'
    );

    await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.item-heading',
        priceSelector: '.amount-tag',
        imageSelector: '.lazy-prod'
      },
      validationStatus: 'VALIDATED',
      testResults: validation
    });

    let aiInvocationCount = 0;
    aiLearning.setMockProvider(async () => {
      aiInvocationCount += 1;
      return {};
    });

    const matchingRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchingRule).not.toBeNull();
    expect(matchingRule.cardSelector).toBe('.custom-catalog-item');

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://mystore.com/search',
      rules: {
        cardSelector: matchingRule.cardSelector,
        ...matchingRule.fieldSelectors
      }
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(2);
    expect(aiInvocationCount).toBe(0);

    const logs = await getAiLogs();
    expect(logs.length).toBe(0);
  });

  it('5. isolates different layouts under the same hostname independently', async () => {
    const hostname = 'brandhub.com';
    const fpSearch = 'layout_search_results';
    const fpDeals = 'layout_flash_deals';

    await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fpSearch,
      cardSelector: '.search-card',
      fieldSelectors: { titleSelector: '.search-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fpDeals,
      cardSelector: '.deal-card',
      fieldSelectors: { titleSelector: '.deal-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const ruleSearch = await rulesRepository.findMatchingRule(hostname, fpSearch);
    const ruleDeals = await rulesRepository.findMatchingRule(hostname, fpDeals);

    expect(ruleSearch.cardSelector).toBe('.search-card');
    expect(ruleDeals.cardSelector).toBe('.deal-card');
    expect(ruleSearch.id).not.toBe(ruleDeals.id);

    const ruleUnknown = await rulesRepository.findMatchingRule(hostname, 'layout_other');
    expect(ruleUnknown).toBeNull();
  });

  it('6. safely falls back when selectors break without activating invalid rules', () => {
    const dom = loadFixture('layout-grid.html', 'https://store.com/search');
    const brokenRule = {
      hostname: 'store.com',
      layoutFingerprint: 'layout_grid',
      cardSelector: '.completely-missing-class',
      fieldSelectors: {
        titleSelector: '.missing-title'
      }
    };

    const check = validateRuleAgainstDoc(brokenRule, dom.window.document, 'https://store.com/search');
    expect(check.valid).toBe(false);
    expect(check.errors.length).toBeGreaterThan(0);
  });

  it('7. preserves last known-good rule on regression failure and records rollback history', async () => {
    const hostname = 'acme.com';
    const fingerprint = 'layout_acme_main';

    const saveInitial = await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.good-selector',
      fieldSelectors: { titleSelector: '.good-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    expect(saveInitial.success).toBe(true);
    expect(saveInitial.rule.activeVersionId).toBe('v1');

    const failingRegressionCandidate = {
      id: saveInitial.rule.id,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.bad-selector',
      fieldSelectors: { titleSelector: '.bad-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true },
      regressionResults: {
        passed: false,
        failures: ['Card 1: Title mismatch: expected "Widget", received null']
      }
    };

    const rejectRes = await rulesRepository.saveRule(failingRegressionCandidate);
    expect(rejectRes.success).toBe(false);
    expect(rejectRes.error).toContain('regression testing');

    const active = await rulesRepository.getRule(saveInitial.rule.id);
    expect(active.activeVersionId).toBe('v1');
    expect(active.cardSelector).toBe('.good-selector');

    const saveV2 = await rulesRepository.saveRule({
      id: saveInitial.rule.id,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.good-selector-v2',
      fieldSelectors: { titleSelector: '.good-title-v2' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    expect(saveV2.success).toBe(true);
    expect(saveV2.rule.activeVersionId).toBe('v2');

    const rollback = await rulesRepository.rollbackRule(saveInitial.rule.id, 'v1');
    expect(rollback.success).toBe(true);
    expect(rollback.rule.activeVersionId).toBe('v3');
    expect(rollback.rule.cardSelector).toBe('.good-selector');
    expect(rollback.rule.versions.length).toBe(3);
    expect(rollback.rule.versions[2].changeSource).toBe('rollback');
  });

  it('8. overrides global preferences with site-specific settings while preserving canonical extraction', async () => {
    await preferencesRepository.saveGlobalPreferences({
      mrp: false,
      rating: false
    });

    await preferencesRepository.saveSitePreferences('deals.com', {
      mrp: true
    });

    const globalEff = await preferencesRepository.getEffectivePreferences('regular.com');
    expect(globalEff.mrp).toBe(false);
    expect(globalEff.rating).toBe(false);
    expect(globalEff.title).toBe(true);

    const siteEff = await preferencesRepository.getEffectivePreferences('deals.com');
    expect(siteEff.mrp).toBe(true);
    expect(siteEff.rating).toBe(false);
    expect(siteEff.title).toBe(true);

    const product = {
      title: 'Headphones',
      selling_price: 99.0,
      mrp: 149.0,
      rating: 4.7
    };

    const exported = formatExtractionPayload(
      { url: 'https://deals.com', title: 'Deals' },
      [product],
      siteEff
    );

    expect(exported.items[0].mrp).toBe(149.0);
    expect(exported.items[0].rating).toBeUndefined();
    expect(product.rating).toBe(4.7);
  });

  it('9. validates and persists user corrections associated with layout and card', async () => {
    const invalidPrice = validateFieldValue('selling_price', 'not-a-number');
    expect(invalidPrice.valid).toBe(false);

    const validPrice = validateFieldValue('selling_price', '$89.95');
    expect(validPrice.valid).toBe(true);
    expect(validPrice.value).toBe(89.95);

    const saveRes = await correctionsRepository.saveCorrection({
      cardIndex: 1,
      productId: 'P_999',
      hostname: 'gear.com',
      layoutFingerprint: 'layout_gear',
      ruleId: 'rule_gear',
      field: 'selling_price',
      originalValue: 100.0,
      correctedValue: validPrice.value
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.correction.field).toBe('selling_price');
    expect(saveRes.correction.correctedValue).toBe(89.95);

    const hostCorrections = await correctionsRepository.getCorrectionsForHost('gear.com');
    expect(hostCorrections.length).toBe(1);
    expect(hostCorrections[0].productId).toBe('P_999');
  });

  it('10. logs actual AI requests accurately and does not fabricate AI logs during heuristic extractions', async () => {
    const dom = loadFixture('layout-grid.html', 'https://teststore.com/search');
    const engine = createExtractionEngine();
    await engine.execute({
      document: dom.window.document,
      url: 'https://teststore.com/search'
    });

    const initialLogs = await getAiLogs();
    expect(initialLogs.length).toBe(0);

    aiLearning.setMockProvider(async () => ({
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.price',
        urlSelector: 'a'
      },
      confidence: 0.9,
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 }
    }));

    const learnRes = await aiLearning.learnLayout({
      hostname: 'teststore.com',
      pageTitle: 'Test Search',
      candidateSelectors: ['.product-card'],
      domSnippets: ['<div class="product-card"></div>']
    });

    expect(learnRes.success).toBe(true);

    const updatedLogs = await getAiLogs();
    expect(updatedLogs.length).toBe(1);
    expect(updatedLogs[0].hostname).toBe('teststore.com');
    expect(updatedLogs[0].inputTokens).toBe(150);
    expect(updatedLogs[0].outputTokens).toBe(40);
    expect(updatedLogs[0].isEstimated).toBe(false);
  });

  it('11. exports valid JSON that conforms to schema and respects field preferences', () => {
    const items = [
      {
        title: 'Smartphone',
        product_url: 'https://store.com/phone',
        product_id: 'PHONE_01',
        image_url: 'https://store.com/phone.jpg',
        selling_price: 699,
        mrp: 799,
        currency: '$',
        rating: 4.6,
        rating_count: 500,
        review_count: 80,
        extra: { discount: '12% OFF' }
      }
    ];

    const prefs = {
      title: true,
      selling_price: true,
      currency: true,
      image_url: false,
      extra: false
    };

    const payload = formatExtractionPayload(
      { url: 'https://store.com', title: 'Catalog' },
      items,
      prefs
    );

    const jsonStr = serializeToJson(payload);
    expect(typeof jsonStr).toBe('string');

    const parsed = JSON.parse(jsonStr);
    expect(parsed.extractor).toBe('PIRATES ALERT');
    expect(parsed.totalItems).toBe(1);
    expect(parsed.items[0].title).toBe('Smartphone');
    expect(parsed.items[0].selling_price).toBe(699);
    expect(parsed.items[0].image_url).toBeUndefined();
    expect(parsed.items[0].extra).toBeUndefined();
  });

  it('12. enforces conservative candidate bounds and handles empty or non-product pages gracefully', async () => {
    const emptyDom = new JSDOM('<html><body><div class="about-us"><h1>About Our Company</h1></div></body></html>');
    const engine = createExtractionEngine();
    const res = await engine.execute({
      document: emptyDom.window.document,
      url: 'https://company.com/about'
    });

    expect(res.status).toBe('EMPTY');
    expect(res.items.length).toBe(0);
    expect(res.diagnostics.candidateCount).toBe(0);

    const largeDoc = new JSDOM(
      '<html><body><div>' +
      Array.from({ length: 300 }).map((_, i) => `<div class="product-item"><a href="/p/${i}">Product ${i}</a><span>$${i}</span><img src="/img.jpg"/></div>`).join('') +
      '</div></body></html>'
    );

    const { candidateCards, truncated } = findProductCards(largeDoc.window.document);
    expect(candidateCards.length).toBeLessThanOrEqual(250);
    expect(truncated).toBe(true);
  });
});
