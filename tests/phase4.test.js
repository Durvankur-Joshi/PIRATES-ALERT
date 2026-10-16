import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { rulesRepository, computeLayoutFingerprint, migrateRuleRecord } from '../src/modules/rules/index.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { preferencesRepository, ALL_CANONICAL_FIELDS, getDefaultFieldPreferences, filterProductByPreferences } from '../src/modules/preferences/index.js';
import { correctionsRepository, validateFieldValue, deduceFieldSelectorFromCard } from '../src/modules/corrections/index.js';
import { regressionRepository, compareFieldValues, evaluateRuleOnFixture } from '../src/modules/regression/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { formatExtractionPayload, serializeToJson } from '../src/modules/export/index.js';

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('Phase 4: User Corrections, Preferences, Regression, and Versioning/Rollback', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
    await preferencesRepository.clearAllPreferences();
    await correctionsRepository.clearAllCorrections();
    await regressionRepository.clearAllFixtures();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('validates user corrections by field type and retains null for cleared optional fields', () => {
    expect(validateFieldValue('title', '  Mechanical Keyboard  ')).toEqual({ valid: true, value: 'Mechanical Keyboard' });
    expect(validateFieldValue('title', '   ')).toEqual({ valid: false, error: 'Title cannot be empty', value: null });

    expect(validateFieldValue('selling_price', ' $49.99 ')).toEqual({ valid: true, value: 49.99 });
    expect(validateFieldValue('selling_price', -10)).toEqual({ valid: false, error: 'selling_price must be a non-negative number', value: null });
    expect(validateFieldValue('selling_price', '')).toEqual({ valid: true, value: null });

    expect(validateFieldValue('rating', '4.5')).toEqual({ valid: true, value: 4.5 });
    expect(validateFieldValue('rating', 6.0)).toEqual({ valid: false, error: 'Rating must be between 0 and 5', value: null });
    expect(validateFieldValue('rating', '')).toEqual({ valid: true, value: null });

    expect(validateFieldValue('product_url', 'https://example.com/item/123')).toEqual({ valid: true, value: 'https://example.com/item/123' });
    expect(validateFieldValue('product_url', '/item/123')).toEqual({ valid: true, value: '/item/123' });
    expect(validateFieldValue('product_url', 'not-a-valid-url')).toEqual({ valid: false, error: 'Invalid URL format for product_url', value: null });
    expect(validateFieldValue('product_url', '')).toEqual({ valid: true, value: null });

    expect(validateFieldValue('rating_count', '1,250 ratings')).toEqual({ valid: true, value: 1250 });
    expect(validateFieldValue('rating_count', '')).toEqual({ valid: true, value: null });
  });

  it('persists user corrections and associates with product card, host, and rule', async () => {
    const saveRes = await correctionsRepository.saveCorrection({
      cardIndex: 0,
      productId: 'PROD_101',
      hostname: 'store.com',
      layoutFingerprint: 'layout_abc',
      ruleId: 'rule_store_abc',
      field: 'selling_price',
      originalValue: 120.0,
      correctedValue: 99.0
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.correction.correctedValue).toBe(99.0);
    expect(saveRes.correction.hostname).toBe('store.com');

    const all = await correctionsRepository.getAllCorrections();
    expect(all.length).toBe(1);
    expect(all[0].productId).toBe('PROD_101');
    expect(all[0].field).toBe('selling_price');
  });

  it('deduces refined field selector from card DOM element without replacing selector with raw value', () => {
    const dom = loadFixture('layout-custom.html', 'https://specialty.com/search');
    const cardEl = dom.window.document.querySelector('.custom-catalog-item');
    expect(cardEl).not.toBeNull();

    const refinedTitle = deduceFieldSelectorFromCard(cardEl, 'title', 'Smart Thermostat V2 WiFi');
    expect(refinedTitle).toBe('.item-heading');
    expect(refinedTitle).not.toBe('Smart Thermostat V2 WiFi');

    const refinedPrice = deduceFieldSelectorFromCard(cardEl, 'selling_price', 129.0);
    expect(refinedPrice).toBe('.amount-tag');
    expect(refinedPrice).not.toBe(129.0);
  });

  it('supports global defaults and site-specific preferences without mutating canonical data', async () => {
    const defaults = getDefaultFieldPreferences();
    for (const f of ALL_CANONICAL_FIELDS) {
      expect(defaults[f]).toBe(true);
    }

    const effDefault = await preferencesRepository.getEffectivePreferences('example.com');
    expect(effDefault.selling_price).toBe(true);

    await preferencesRepository.saveGlobalPreferences({
      mrp: false,
      review_count: false
    });

    const globalCheck = await preferencesRepository.getEffectivePreferences('othersite.com');
    expect(globalCheck.mrp).toBe(false);
    expect(globalCheck.review_count).toBe(false);
    expect(globalCheck.title).toBe(true);

    await preferencesRepository.saveSitePreferences('specialsite.com', {
      mrp: true,
      image_url: false
    });

    const specialSiteEff = await preferencesRepository.getEffectivePreferences('specialsite.com');
    expect(specialSiteEff.mrp).toBe(true);
    expect(specialSiteEff.image_url).toBe(false);
    expect(specialSiteEff.review_count).toBe(false);

    const normalSiteEff = await preferencesRepository.getEffectivePreferences('normalsite.com');
    expect(normalSiteEff.mrp).toBe(false);
    expect(normalSiteEff.image_url).toBe(true);

    const rawProduct = {
      title: 'Test Product',
      selling_price: 25.0,
      mrp: 35.0,
      image_url: 'https://site.com/img.jpg',
      rating: 4.5
    };

    const projected = filterProductByPreferences(rawProduct, specialSiteEff);
    expect(projected.title).toBe('Test Product');
    expect(projected.mrp).toBe(35.0);
    expect(projected.image_url).toBeUndefined();
    expect(rawProduct.image_url).toBe('https://site.com/img.jpg');

    const exportPayload = formatExtractionPayload(
      { url: 'https://specialsite.com/search', title: 'Search' },
      [rawProduct],
      specialSiteEff
    );
    expect(exportPayload.totalItems).toBe(1);
    expect(exportPayload.items[0].image_url).toBeUndefined();
    expect(exportPayload.items[0].mrp).toBe(35.0);
  });

  it('detects regressions on fixtures and rejects regression-failing candidate rules', async () => {
    const dom = loadFixture('layout-custom.html', 'https://specialty.com/search');
    const hostname = 'specialty.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const sampleCards = Array.from(dom.window.document.querySelectorAll('.custom-catalog-item')).map((el) => el.outerHTML);
    const expectedItems = [
      {
        title: 'Smart Thermostat V2 WiFi',
        selling_price: 129.0,
        image_url: '/assets/item1.png'
      },
      {
        title: 'Wireless Video Doorbell 1080p',
        selling_price: 79.0,
        image_url: '/assets/item2.png'
      }
    ];

    await regressionRepository.saveFixture({
      hostname,
      layoutFingerprint: fingerprint,
      ruleId: `rule_${hostname}_${fingerprint}`,
      ruleVersion: 1,
      sampleCards,
      expectedItems
    });

    const goodRule = {
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.item-heading',
        priceSelector: '.amount-tag',
        imageSelector: '.lazy-prod'
      }
    };

    const goodEval = await regressionRepository.runRegressionOnCandidate(
      goodRule,
      (html) => new JSDOM(html).window.document
    );
    expect(goodEval.passed).toBe(true);
    expect(goodEval.failures.length).toBe(0);

    const brokenRule = {
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.non-existent-header',
        priceSelector: '.amount-tag',
        imageSelector: '.lazy-prod'
      }
    };

    const badEval = await regressionRepository.runRegressionOnCandidate(
      brokenRule,
      (html) => new JSDOM(html).window.document
    );
    expect(badEval.passed).toBe(false);
    expect(badEval.failures.length).toBeGreaterThan(0);
    expect(badEval.failures[0]).toContain('Title mismatch');
  });

  it('creates immutable rule versions, preserves last known-good, and allows rollback', async () => {
    const hostname = 'shop.example.com';
    const fingerprint = 'layout_vtest';

    const v1Validation = { valid: true, candidateCount: 2, acceptedCount: 2 };

    const saveV1 = await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card-v1',
      fieldSelectors: { titleSelector: '.title-v1', priceSelector: '.price-v1' },
      validationStatus: 'VALIDATED',
      testResults: v1Validation
    });

    expect(saveV1.success).toBe(true);
    expect(saveV1.rule.activeVersionId).toBe('v1');
    expect(saveV1.rule.lastKnownGoodVersionId).toBe('v1');
    expect(saveV1.rule.versions.length).toBe(1);
    expect(saveV1.rule.versions[0].versionId).toBe('v1');

    const v2Validation = { valid: true, candidateCount: 2, acceptedCount: 2 };
    const saveV2 = await rulesRepository.saveRule({
      id: saveV1.rule.id,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card-v2',
      fieldSelectors: { titleSelector: '.title-v2', priceSelector: '.price-v2' },
      changeSource: 'user_correction',
      changeSummary: 'Refined title selector',
      validationStatus: 'VALIDATED',
      testResults: v2Validation
    });

    expect(saveV2.success).toBe(true);
    expect(saveV2.rule.activeVersionId).toBe('v2');
    expect(saveV2.rule.lastKnownGoodVersionId).toBe('v2');
    expect(saveV2.rule.versions.length).toBe(2);
    expect(saveV2.rule.cardSelector).toBe('.product-card-v2');

    const history = await rulesRepository.getRuleHistory(saveV1.rule.id);
    expect(history.success).toBe(true);
    expect(history.versions.length).toBe(2);

    const rollbackRes = await rulesRepository.rollbackRule(saveV1.rule.id, 'v1');
    expect(rollbackRes.success).toBe(true);
    expect(rollbackRes.rolledBackTo).toBe('v1');
    expect(rollbackRes.rule.activeVersionId).toBe('v3');
    expect(rollbackRes.rule.cardSelector).toBe('.product-card-v1');
    expect(rollbackRes.rule.versions.length).toBe(3);
    expect(rollbackRes.rule.versions[2].changeSource).toBe('rollback');
    expect(rollbackRes.rule.versions[2].restoredFromVersion).toBe('v1');
  });

  it('rejects candidate rule that fails regression and preserves active rule', async () => {
    const hostname = 'store.example.com';
    const fingerprint = 'layout_regtest';

    const saveInitial = await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.good-card',
      fieldSelectors: { titleSelector: '.good-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    expect(saveInitial.success).toBe(true);

    const failingCandidate = {
      id: saveInitial.rule.id,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.broken-card',
      fieldSelectors: { titleSelector: '.broken-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true },
      regressionResults: {
        passed: false,
        failures: ['Card 1: Title mismatch: expected "Gadget", received null']
      }
    };

    const failSave = await rulesRepository.saveRule(failingCandidate);
    expect(failSave.success).toBe(false);
    expect(failSave.error).toContain('failed regression testing');

    const activeRule = await rulesRepository.getRule(saveInitial.rule.id);
    expect(activeRule.cardSelector).toBe('.good-card');
    expect(activeRule.activeVersionId).toBe('v1');
  });

  it('seamlessly migrates legacy Phase 3 rule records to versioned format', () => {
    const legacyRecord = {
      id: 'rule_store_123',
      hostname: 'store.com',
      layoutFingerprint: 'layout_legacy',
      cardSelector: '.legacy-card',
      fieldSelectors: { titleSelector: '.legacy-title' },
      validationStatus: 'VALIDATED',
      schemaVersion: '1.0',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z'
    };

    const migrated = migrateRuleRecord(legacyRecord);
    expect(migrated.activeVersionId).toBe('v1');
    expect(migrated.lastKnownGoodVersionId).toBe('v1');
    expect(Array.isArray(migrated.versions)).toBe(true);
    expect(migrated.versions.length).toBe(1);
    expect(migrated.versions[0].cardSelector).toBe('.legacy-card');
    expect(migrated.versions[0].isActive).toBe(true);
  });

  it('guarantees multiple layouts on same hostname remain isolated under versioning', async () => {
    const hostname = 'multilayout.com';
    const fpGrid = 'layout_grid_cards';
    const fpList = 'layout_list_rows';

    await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fpGrid,
      cardSelector: '.grid-item',
      fieldSelectors: { titleSelector: '.grid-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    await rulesRepository.saveRule({
      hostname,
      layoutFingerprint: fpList,
      cardSelector: '.list-row',
      fieldSelectors: { titleSelector: '.list-title' },
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const matchGrid = await rulesRepository.findMatchingRule(hostname, fpGrid);
    expect(matchGrid.cardSelector).toBe('.grid-item');

    const matchList = await rulesRepository.findMatchingRule(hostname, fpList);
    expect(matchList.cardSelector).toBe('.list-row');

    expect(matchGrid.id).not.toBe(matchList.id);
  });

  it('reuses exact saved rule with zero AI calls during extraction', async () => {
    const hostname = 'reuse.com';
    const dom = loadFixture('layout-custom.html', `https://${hostname}/category/gadgets`);
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
      `https://${hostname}/category/gadgets`
    );

    const saved = await rulesRepository.saveRule({
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

    expect(saved.success).toBe(true);

    const matching = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matching).not.toBeNull();
    expect(matching.cardSelector).toBe('.custom-catalog-item');

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: `https://${hostname}/category/gadgets`,
      rules: {
        cardSelector: matching.cardSelector,
        ...matching.fieldSelectors
      }
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(2);
    expect(result.items[0].title).toBe('Smart Thermostat V2 WiFi');
    expect(result.items[0].selling_price).toBe(129);
  });
});
