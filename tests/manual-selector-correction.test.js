import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { rulesRepository, computeLayoutFingerprint } from '../src/modules/rules/index.js';
import {
  previewSelectorCorrection,
  applySelectorCorrection,
  detectMrpConfusion
} from '../src/modules/corrections/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { EXTRACTION_SOURCE } from '../src/modules/messaging/protocol.js';

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('Manual Selector Correction Suite', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('rejects invalid CSS syntax and unsafe selector expressions', () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;

    const invalidCases = [
      'div:::bad-pseudo',
      'span[open-bracket',
      '.price >',
      ', .bad-comma',
      'script<alert>'
    ];

    for (const invalidSelector of invalidCases) {
      const preview = previewSelectorCorrection({
        cardSelector: '.product-card',
        field: 'sellingPrice',
        proposedSelector: invalidSelector,
        doc
      });

      expect(preview.valid).toBe(false);
      expect(preview.errors.length).toBeGreaterThan(0);
      expect(preview.sampledCards.length).toBe(0);
    }
  });

  it('reports zero matches when selector matches no elements in the current DOM', () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;

    const preview = previewSelectorCorrection({
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.completely-non-existent-selector-xyz',
      doc
    });

    expect(preview.valid).toBe(false);
    expect(preview.summary.matchedCount).toBe(0);
    expect(preview.summary.validCount).toBe(0);
    expect(preview.errors.some((e) => e.includes('matched 0 elements'))).toBe(true);
  });

  it('detects and flags selectors targeting elements outside product cards', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <div id="site-header">
            <span class="header-cart-total">$999.00</span>
          </div>
          <div class="product-grid">
            <div class="product-card">
              <h3>Item 1</h3>
            </div>
            <div class="product-card">
              <h3>Item 2</h3>
            </div>
          </div>
        </body>
      </html>
    `, { url: 'https://store.example.com' });
    const doc = dom.window.document;

    const preview = previewSelectorCorrection({
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.header-cart-total',
      doc
    });

    expect(preview.valid).toBe(false);
    expect(preview.summary.validCount).toBe(0);
    expect(preview.sampledCards.every((c) => c.validationStatus === 'OUTSIDE_CARD')).toBe(true);
    expect(preview.errors.some((e) => e.includes('outside product cards'))).toBe(true);
  });

  it('handles missing values without inventing data and preserves null schema', () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <div class="product-card">
            <span class="product-title">Item A</span>
            <span class="price-val">$45.00</span>
          </div>
          <div class="product-card">
            <span class="product-title">Item B</span>
          </div>
        </body>
      </html>
    `, { url: 'https://store.example.com' });
    const doc = dom.window.document;

    const preview = previewSelectorCorrection({
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.price-val',
      doc
    });

    expect(preview.sampledCards.length).toBe(2);
    expect(preview.sampledCards[0].validationStatus).toBe('VALID');
    expect(preview.sampledCards[0].parsedValue).toBe(45);

    expect(preview.sampledCards[1].validationStatus).toBe('MISSING');
    expect(preview.sampledCards[1].rawText).toBeNull();
    expect(preview.sampledCards[1].parsedValue).toBeNull();
  });

  it('detects likely MRP-vs-selling-price confusion and blocks activation without confirmation', async () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;
    const cardEl = doc.querySelector('.product-card');
    const oldPriceEl = cardEl.querySelector('.old-price');

    const domEvidence = detectMrpConfusion(oldPriceEl, cardEl, '.old-price');
    expect(domEvidence.isLikelyMrp).toBe(true);

    const preview = previewSelectorCorrection({
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.old-price, .list-price',
      doc
    });

    expect(preview.summary.likelyMrpCount).toBeGreaterThan(0);
    expect(preview.summary.requiresUserConfirmation).toBe(true);
    expect(preview.warnings.some((w) => w.includes('targets MRP / list price'))).toBe(true);

    const unconfirmedAttempt = await applySelectorCorrection({
      hostname: 'store.example.com',
      layoutFingerprint: computeLayoutFingerprint(doc, 'store.example.com'),
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.old-price, .list-price',
      userConfirmedAmbiguity: false,
      doc,
      url: 'https://store.example.com/search'
    });

    expect(unconfirmedAttempt.success).toBe(false);
    expect(unconfirmedAttempt.error).toContain('Explicit user confirmation is required');

    const confirmedAttempt = await applySelectorCorrection({
      hostname: 'store.example.com',
      layoutFingerprint: computeLayoutFingerprint(doc, 'store.example.com'),
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.old-price, .list-price',
      userConfirmedAmbiguity: true,
      doc,
      url: 'https://store.example.com/search'
    });

    expect(confirmedAttempt.success).toBe(true);
  });

  it('produces a comprehensive multiple-card preview with identity, raw text, and status', () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;

    const preview = previewSelectorCorrection({
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.current-price, .price',
      doc
    });

    expect(preview.valid).toBe(true);
    expect(preview.sampledCards.length).toBeGreaterThan(1);

    for (const card of preview.sampledCards) {
      expect(typeof card.cardIndex).toBe('number');
      expect(typeof card.productIdentity).toBe('string');
      expect(card.productIdentity.length).toBeGreaterThan(0);
      if (card.validationStatus === 'VALID') {
        expect(typeof card.rawText).toBe('string');
        expect(typeof card.parsedValue).toBe('number');
        expect(card.parsedValue).toBeGreaterThan(0);
      }
    }
  });

  it('successfully activates a valid correction and increments the rule version', async () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;
    const host = 'store.example.com';
    const fingerprint = computeLayoutFingerprint(doc, host);

    const initialRule = {
      id: `rule_${host}_${fingerprint}`,
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.old-price'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    };
    await rulesRepository.saveRule(initialRule);

    const preRule = await rulesRepository.findMatchingRule(host, fingerprint);
    expect(preRule.activeVersionId).toBe('v1');

    const result = await applySelectorCorrection({
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.current-price, .price',
      userConfirmedAmbiguity: false,
      doc,
      url: 'https://store.example.com/search'
    });

    expect(result.success).toBe(true);
    expect(result.rule.activeVersionId).toBe('v2');
    expect(result.rule.fieldSelectors.priceSelector).toBe('.current-price, .price');
    expect(result.rule.versions.length).toBe(2);
  });

  it('preserves the existing working rule when a proposed correction fails', async () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;
    const host = 'store.example.com';
    const fingerprint = computeLayoutFingerprint(doc, host);

    const initialRule = {
      id: `rule_${host}_${fingerprint}`,
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.current-price, .price'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    };
    await rulesRepository.saveRule(initialRule);

    const failedAttempt = await applySelectorCorrection({
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.non-existent-selector-99',
      doc,
      url: 'https://store.example.com/search'
    });

    expect(failedAttempt.success).toBe(false);

    const currentRule = await rulesRepository.findMatchingRule(host, fingerprint);
    expect(currentRule.activeVersionId).toBe('v1');
    expect(currentRule.fieldSelectors.priceSelector).toBe('.current-price, .price');
  });

  it('persists corrected rules to repository with activeVersionId and lastKnownGoodVersionId', async () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;
    const host = 'store.example.com';
    const fingerprint = computeLayoutFingerprint(doc, host);

    await rulesRepository.saveRule({
      id: `rule_${host}_${fingerprint}`,
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.price-base'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const corrResult = await applySelectorCorrection({
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.current-price, .price',
      doc,
      url: 'https://store.example.com/search'
    });
    expect(corrResult.success).toBe(true);

    const reloadedRule = await rulesRepository.getRule(`rule_${host}_${fingerprint}`);
    expect(reloadedRule.activeVersionId).toBe('v2');
    expect(reloadedRule.lastKnownGoodVersionId).toBe('v2');
    expect(reloadedRule.fieldSelectors.priceSelector).toBe('.current-price, .price');
  });

  it('supports rollback to previous known-good version creating an immutable rollback record', async () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;
    const host = 'store.example.com';
    const fingerprint = computeLayoutFingerprint(doc, host);

    await rulesRepository.saveRule({
      id: `rule_${host}_${fingerprint}`,
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.price-base'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    await applySelectorCorrection({
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      field: 'sellingPrice',
      proposedSelector: '.current-price, .price',
      doc,
      url: 'https://store.example.com/search'
    });

    const reloadedRule = await rulesRepository.getRule(`rule_${host}_${fingerprint}`);
    const rollbackResult = await rulesRepository.rollbackRule(reloadedRule.id, 'v1');

    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.activeVersion.versionId).toBe('v3');
    expect(rollbackResult.activeVersion.restoredFromVersion).toBe('v1');
    expect(rollbackResult.rule.fieldSelectors.priceSelector).toBe('.price-base');
  });

  it('reuses the corrected rule on future matching layouts with zero AI calls', async () => {
    const dom = loadFixture('layout-grid.html');
    const doc = dom.window.document;
    const host = 'store.example.com';
    const fingerprint = computeLayoutFingerprint(doc, host);

    await rulesRepository.saveRule({
      id: `rule_${host}_${fingerprint}`,
      hostname: host,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.current-price, .price'
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const matchingRule = await rulesRepository.findMatchingRule(host, fingerprint);
    expect(matchingRule).not.toBeNull();

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: doc,
      url: 'https://store.example.com/search',
      title: 'Search Results',
      rules: {
        cardSelector: matchingRule.cardSelector,
        ...matchingRule.fieldSelectors
      }
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].selling_price).toBe(199.99);

    const differentFingerprint = 'layout_different_structure';
    const nonMatchingRule = await rulesRepository.findMatchingRule(host, differentFingerprint);
    expect(nonMatchingRule).toBeNull();
  });
});
