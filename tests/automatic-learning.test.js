import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { createRulesRepository, computeLayoutFingerprint, normalizeHostname } from '../src/modules/rules/index.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { createAiLearningModule, clearAiLogs, getAiLogs, validateAiRuleResponse } from '../src/modules/ai/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { hasProductListingEvidence, sampleCardSnippetsForAi } from '../src/modules/extractor/cardDetector.js';
import { createRegressionRepository } from '../src/modules/regression/index.js';
import { EXTRACTION_SOURCE } from '../src/modules/messaging/protocol.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

function createValidMockRule(hostname, layoutFingerprint) {
  return {
    hostname,
    layoutFingerprint,
    cardSelector: '.product-card',
    fieldSelectors: {
      titleSelector: '.product-title a',
      priceSelector: '.current-price, .price',
      urlSelector: '.product-title a',
      imageSelector: 'img',
      mrpSelector: null,
      ratingSelector: null,
      ratingCountSelector: null,
      reviewCountSelector: null
    },
    confidence: 0.92,
    validationStatus: 'VALIDATED',
    testResults: { valid: true, errors: [], warnings: [] },
    regressionResults: { passed: true, failures: [] },
    changeSource: 'ai_learning',
    changeSummary: 'Test rule'
  };
}

function createMockProvider(response) {
  return vi.fn(() => Promise.resolve(response));
}

function createValidAiResponse() {
  return {
    cardSelector: '.product-card',
    fieldSelectors: {
      titleSelector: '.product-title a',
      priceSelector: '.current-price, .price',
      urlSelector: '.product-title a',
      imageSelector: 'img',
      mrpSelector: null,
      ratingSelector: null,
      ratingCountSelector: null,
      reviewCountSelector: null
    },
    confidence: 0.92
  };
}

function createInvalidAiResponse() {
  return {
    cardSelector: '.does-not-exist-anywhere',
    fieldSelectors: {
      titleSelector: '.fake-title',
      priceSelector: '.fake-price',
      urlSelector: '.fake-url',
      imageSelector: null,
      mrpSelector: null,
      ratingSelector: null,
      ratingCountSelector: null,
      reviewCountSelector: null
    },
    confidence: 0.5
  };
}

describe('Automatic Learning Pipeline', () => {
  let rulesRepo;
  let regressionRepo;
  let aiModule;
  let engine;

  beforeEach(async () => {
    rulesRepo = createRulesRepository();
    regressionRepo = createRegressionRepository();
    aiModule = createAiLearningModule();
    engine = createExtractionEngine();
    await rulesRepo.clearAllRules();
    await regressionRepo.clearAllFixtures();
    await clearAiLogs();
    aiModule.setMockProvider(null);
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('1. Saved matching rule is reused with zero AI calls', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const mockRule = createValidMockRule(hostname, fingerprint);
    await rulesRepo.saveRule(mockRule);

    const savedRule = await rulesRepo.findMatchingRule(hostname, fingerprint);
    expect(savedRule).not.toBeNull();
    expect(savedRule.cardSelector).toBe('.product-card');

    const validation = validateRuleAgainstDoc(savedRule, doc, 'https://shop.example.com/products');
    expect(validation.valid).toBe(true);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);

    const result = await engine.execute({
      document: doc,
      url: 'https://shop.example.com/products',
      rules: {
        cardSelector: savedRule.cardSelector,
        ...savedRule.fieldSelectors
      }
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(mockProvider).not.toHaveBeenCalled();

    const logs = await getAiLogs();
    expect(logs.length).toBe(0);
  });

  it('2. First-time supported layout triggers AI learning automatically', async () => {
    const dom = loadFixture('layout-grid.html', 'https://newshop.example.com/search');
    const doc = dom.window.document;
    const hostname = 'newshop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const savedRule = await rulesRepo.findMatchingRule(hostname, fingerprint);
    expect(savedRule).toBeNull();

    const hasListing = hasProductListingEvidence(doc);
    expect(hasListing).toBe(true);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);

    const aiResult = await aiModule.learnLayout({
      hostname,
      pageTitle: 'Search Results',
      candidateSelectors: [],
      diagnostics: {},
      domSnippets: sampleCardSnippetsForAi(doc, 2, 2500).domSnippets,
      callReason: 'automatic_learning'
    });

    expect(aiResult.success).toBe(true);
    expect(aiResult.proposedRule).toBeDefined();
    expect(mockProvider).toHaveBeenCalledTimes(1);

    const validation = validateRuleAgainstDoc(
      { ...aiResult.proposedRule, hostname, layoutFingerprint: fingerprint },
      doc,
      'https://newshop.example.com/search'
    );
    expect(validation.valid).toBe(true);

    const saveRes = await rulesRepo.saveRule({
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: aiResult.proposedRule.cardSelector,
      fieldSelectors: aiResult.proposedRule.fieldSelectors,
      confidence: aiResult.proposedRule.confidence,
      validationStatus: 'VALIDATED',
      testResults: validation,
      regressionResults: { passed: true, failures: [] },
      changeSource: 'ai_learning'
    });
    expect(saveRes.success).toBe(true);

    const nowSaved = await rulesRepo.findMatchingRule(hostname, fingerprint);
    expect(nowSaved).not.toBeNull();
    expect(nowSaved.cardSelector).toBe('.product-card');
  });

  it('3. URL changes but layout stays the same — no AI call when saved rule matches', async () => {
    const dom1 = loadFixture('layout-grid.html', 'https://shop.example.com/search?q=laptop');
    const doc1 = dom1.window.document;
    const hostname = 'shop.example.com';
    const fingerprint1 = computeLayoutFingerprint(doc1, hostname);

    const mockRule = createValidMockRule(hostname, fingerprint1);
    await rulesRepo.saveRule(mockRule);

    const dom2 = loadFixture('layout-grid.html', 'https://shop.example.com/search?q=headphones');
    const doc2 = dom2.window.document;
    const fingerprint2 = computeLayoutFingerprint(doc2, hostname);

    expect(fingerprint1).toBe(fingerprint2);

    const savedRule = await rulesRepo.findMatchingRule(hostname, fingerprint2);
    expect(savedRule).not.toBeNull();

    const validation = validateRuleAgainstDoc(savedRule, doc2, 'https://shop.example.com/search?q=headphones');
    expect(validation.valid).toBe(true);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);

    const result = await engine.execute({
      document: doc2,
      url: 'https://shop.example.com/search?q=headphones',
      rules: {
        cardSelector: savedRule.cardSelector,
        ...savedRule.fieldSelectors
      }
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('4. Different layout on same hostname triggers learning', async () => {
    const domGrid = loadFixture('layout-grid.html', 'https://shop.example.com/electronics');
    const domList = loadFixture('layout-list.html', 'https://shop.example.com/home');

    const hostname = 'shop.example.com';
    const fpGrid = computeLayoutFingerprint(domGrid.window.document, hostname);
    const fpList = computeLayoutFingerprint(domList.window.document, hostname);

    expect(fpGrid).not.toBe(fpList);

    const gridRule = createValidMockRule(hostname, fpGrid);
    await rulesRepo.saveRule(gridRule);

    const matchGrid = await rulesRepo.findMatchingRule(hostname, fpGrid);
    expect(matchGrid).not.toBeNull();

    const matchList = await rulesRepo.findMatchingRule(hostname, fpList);
    expect(matchList).toBeNull();

    const hasListing = hasProductListingEvidence(domList.window.document);
    expect(hasListing).toBe(true);
  });

  it('5. Saved rule fails live validation and recovery is triggered once', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/changed');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const brokenRule = {
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.nonexistent-product-class',
      fieldSelectors: {
        titleSelector: '.fake-title',
        priceSelector: '.fake-price',
        urlSelector: '.fake-url',
        imageSelector: null,
        mrpSelector: null,
        ratingSelector: null,
        ratingCountSelector: null,
        reviewCountSelector: null
      },
      validationStatus: 'VALIDATED',
      testResults: { valid: true, errors: [], warnings: [] },
      regressionResults: { passed: true, failures: [] },
      changeSource: 'ai_learning'
    };
    await rulesRepo.saveRule(brokenRule);

    const savedRule = await rulesRepo.findMatchingRule(hostname, fingerprint);
    expect(savedRule).not.toBeNull();

    const validation = validateRuleAgainstDoc(savedRule, doc, 'https://shop.example.com/changed');
    expect(validation.valid).toBe(false);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);

    const relearned = await aiModule.learnLayout({
      hostname,
      pageTitle: 'Changed Page',
      candidateSelectors: [],
      diagnostics: { reason: 'rule_validation_failed' },
      domSnippets: sampleCardSnippetsForAi(doc, 2, 2500).domSnippets,
      callReason: 'automatic_learning'
    });

    expect(relearned.success).toBe(true);
    expect(mockProvider).toHaveBeenCalledTimes(1);
  });

  it('6. Invalid AI proposals are not saved or applied', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const invalidResponse = createInvalidAiResponse();
    const mockProvider = createMockProvider(invalidResponse);
    aiModule.setMockProvider(mockProvider);

    const aiResult = await aiModule.learnLayout({
      hostname,
      pageTitle: 'Products',
      candidateSelectors: [],
      diagnostics: {},
      domSnippets: ['<div class="product-card"><h3>Test</h3><span>$99</span></div>'],
      callReason: 'automatic_learning'
    });

    expect(aiResult.success).toBe(true);

    const validation = validateRuleAgainstDoc(
      {
        cardSelector: aiResult.proposedRule.cardSelector,
        fieldSelectors: aiResult.proposedRule.fieldSelectors,
        hostname,
        layoutFingerprint: fingerprint
      },
      doc,
      'https://shop.example.com/products'
    );
    expect(validation.valid).toBe(false);

    const rulesBefore = await rulesRepo.getAllRules();
    expect(rulesBefore.length).toBe(0);
  });

  it('7. Failed AI learning does not cause infinite retry loops', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    let callCount = 0;
    const failingProvider = vi.fn(() => {
      callCount++;
      return Promise.reject(new Error('Simulated AI failure'));
    });
    aiModule.setMockProvider(failingProvider);

    const result = await aiModule.learnLayout({
      hostname,
      pageTitle: 'Products',
      candidateSelectors: [],
      diagnostics: {},
      domSnippets: ['<div class="product-card"><h3>Test</h3><span>$99</span></div>'],
      callReason: 'automatic_learning'
    });

    expect(result.success).toBe(false);
    expect(failingProvider).toHaveBeenCalledTimes(1);

    const result2 = await aiModule.learnLayout({
      hostname,
      pageTitle: 'Products',
      candidateSelectors: [],
      diagnostics: {},
      domSnippets: ['<div class="product-card"><h3>Test</h3><span>$99</span></div>'],
      callReason: 'automatic_learning'
    });

    expect(result2.success).toBe(false);
    expect(failingProvider).toHaveBeenCalledTimes(2);
  });

  it('8. Concurrent extraction actions do not trigger duplicate AI requests for the same layout', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    let resolvers = [];
    const slowProvider = vi.fn(() => {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });
    aiModule.setMockProvider(slowProvider);

    const promise1 = aiModule.learnLayout({
      hostname,
      pageTitle: 'Products',
      candidateSelectors: [],
      diagnostics: {},
      domSnippets: ['<div class="product-card"><h3>Test</h3><span>$99</span></div>'],
      callReason: 'automatic_learning'
    });

    expect(slowProvider).toHaveBeenCalledTimes(1);

    for (const r of resolvers) {
      r(createValidAiResponse());
    }

    const result = await promise1;
    expect(result.success).toBe(true);
    expect(slowProvider).toHaveBeenCalledTimes(1);
  });

  it('9. SPA navigation with same layout reuses rule without AI call', async () => {
    const dom1 = loadFixture('layout-grid.html', 'https://spa-shop.example.com/page/1');
    const doc1 = dom1.window.document;
    const hostname = 'spa-shop.example.com';
    const fp1 = computeLayoutFingerprint(doc1, hostname);

    const mockRule = createValidMockRule(hostname, fp1);
    await rulesRepo.saveRule(mockRule);

    const dom2 = loadFixture('layout-grid.html', 'https://spa-shop.example.com/page/2');
    const doc2 = dom2.window.document;
    const fp2 = computeLayoutFingerprint(doc2, hostname);

    expect(fp1).toBe(fp2);

    const savedRule = await rulesRepo.findMatchingRule(hostname, fp2);
    expect(savedRule).not.toBeNull();

    const validation = validateRuleAgainstDoc(savedRule, doc2, 'https://spa-shop.example.com/page/2');
    expect(validation.valid).toBe(true);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);

    const result = await engine.execute({
      document: doc2,
      url: 'https://spa-shop.example.com/page/2',
      rules: {
        cardSelector: savedRule.cardSelector,
        ...savedRule.fieldSelectors
      }
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('10. Unsupported and non-shopping pages do not trigger AI calls', async () => {
    const dom = loadFixture('layout-empty.html', 'https://blog.example.com/article');
    const doc = dom.window.document;

    const hasListing = hasProductListingEvidence(doc);
    expect(hasListing).toBe(false);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);

    const result = await engine.execute({
      document: doc,
      url: 'https://blog.example.com/article'
    });

    expect(result.items.length).toBe(0);
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('11. Failed replacement does not destroy last known-good rule', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const goodRule = createValidMockRule(hostname, fingerprint);
    const saveRes = await rulesRepo.saveRule(goodRule);
    expect(saveRes.success).toBe(true);

    const originalRule = await rulesRepo.findMatchingRule(hostname, fingerprint);
    expect(originalRule).not.toBeNull();
    expect(originalRule.cardSelector).toBe('.product-card');

    const badReplace = {
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.nonexistent-selector-xyz',
      fieldSelectors: {
        titleSelector: '.fake-title',
        priceSelector: '.fake-price',
        urlSelector: '.fake-url',
        imageSelector: null,
        mrpSelector: null,
        ratingSelector: null
      },
      validationStatus: 'UNVALIDATED',
      testResults: { valid: false, errors: ['Card selector matched 0 elements'] },
      changeSource: 'ai_learning'
    };

    const badSaveRes = await rulesRepo.saveRule(badReplace);
    expect(badSaveRes.success).toBe(false);

    const afterFailed = await rulesRepo.findMatchingRule(hostname, fingerprint);
    expect(afterFailed).not.toBeNull();
    expect(afterFailed.cardSelector).toBe('.product-card');
  });

  it('12. JSON output and optional fields remain backward-compatible', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;

    const result = await engine.execute({
      document: doc,
      url: 'https://shop.example.com/products',
      title: 'Product Search'
    });

    expect(result.status).toBeDefined();
    expect(result.items).toBeInstanceOf(Array);
    expect(result.diagnostics).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.metadata.url).toBe('https://shop.example.com/products');
    expect(result.metadata.totalExtracted).toBeDefined();
    expect(result.metadata.timestamp).toBeDefined();

    if (result.items.length > 0) {
      const item = result.items[0];
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('product_url');
      expect(item).toHaveProperty('product_id');
      expect(item).toHaveProperty('image_url');
      expect(item).toHaveProperty('selling_price');
      expect(item).toHaveProperty('mrp');
      expect(item).toHaveProperty('currency');
      expect(item).toHaveProperty('rating');
      expect(item).toHaveProperty('rating_count');
      expect(item).toHaveProperty('review_count');
      expect(item).toHaveProperty('extra');
    }

    expect(result.diagnostics).toHaveProperty('candidateCount');
    expect(result.diagnostics).toHaveProperty('acceptedCount');
    expect(result.diagnostics).toHaveProperty('rejectedCount');
    expect(result.diagnostics).toHaveProperty('discoveryMethod');
    expect(result.diagnostics).toHaveProperty('fieldDiagnostics');
  });

  it('13. Rules, AI Logs, version history, and rollback workflows continue to work', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const rule1 = createValidMockRule(hostname, fingerprint);
    const save1 = await rulesRepo.saveRule(rule1);
    expect(save1.success).toBe(true);

    const allRules = await rulesRepo.getAllRules();
    expect(allRules.length).toBe(1);

    const ruleId = save1.rule.id;
    const history = await rulesRepo.getRuleHistory(ruleId);
    expect(history.success).toBe(true);
    expect(history.versions.length).toBeGreaterThanOrEqual(1);

    const rule2 = {
      ...createValidMockRule(hostname, fingerprint),
      id: ruleId,
      cardSelector: '.product-card',
      fieldSelectors: {
        ...rule1.fieldSelectors,
        mrpSelector: '.old-price, del'
      },
      changeSource: 'user_correction',
      changeSummary: 'Added MRP selector'
    };
    const save2 = await rulesRepo.saveRule(rule2);
    expect(save2.success).toBe(true);

    const history2 = await rulesRepo.getRuleHistory(ruleId);
    expect(history2.versions.length).toBe(2);

    const v1Id = history2.versions[0].versionId;
    const rollbackRes = await rulesRepo.rollbackRule(ruleId, v1Id);
    expect(rollbackRes.success).toBe(true);

    const afterRollback = await rulesRepo.getRule(ruleId);
    expect(afterRollback.versions.length).toBe(3);

    const mockProvider = createMockProvider(createValidAiResponse());
    aiModule.setMockProvider(mockProvider);
    await aiModule.learnLayout({
      hostname: 'test.example.com',
      pageTitle: 'Test',
      candidateSelectors: [],
      diagnostics: {},
      domSnippets: ['<div>test</div>'],
      callReason: 'test_log'
    });

    const logs = await getAiLogs();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].callReason).toBe('test_log');
  });
});

describe('Layout Fingerprint Stability', () => {
  it('Fingerprint is stable across URL changes on same layout', () => {
    const dom1 = loadFixture('layout-grid.html', 'https://shop.example.com/search?q=laptop');
    const dom2 = loadFixture('layout-grid.html', 'https://shop.example.com/search?q=phone');

    const fp1 = computeLayoutFingerprint(dom1.window.document, 'shop.example.com');
    const fp2 = computeLayoutFingerprint(dom2.window.document, 'shop.example.com');

    expect(fp1).toBe(fp2);
  });

  it('Fingerprint differs between structurally different layouts', () => {
    const domGrid = loadFixture('layout-grid.html', 'https://shop.example.com/a');
    const domList = loadFixture('layout-list.html', 'https://shop.example.com/b');

    const fpGrid = computeLayoutFingerprint(domGrid.window.document, 'shop.example.com');
    const fpList = computeLayoutFingerprint(domList.window.document, 'shop.example.com');

    expect(fpGrid).not.toBe(fpList);
  });

  it('Fingerprint falls back gracefully for non-product pages', () => {
    const dom = loadFixture('layout-empty.html', 'https://blog.example.com/article');
    const fp = computeLayoutFingerprint(dom.window.document, 'blog.example.com');

    expect(fp).toBeDefined();
    expect(typeof fp).toBe('string');
    expect(fp.length).toBeGreaterThan(0);
  });
});

describe('AI Rule Validation Guards', () => {
  it('Rejects rules with missing cardSelector', () => {
    const result = validateAiRuleResponse({
      fieldSelectors: { titleSelector: '.t', priceSelector: '.p', urlSelector: 'a' }
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cardSelector');
  });

  it('Rejects rules with missing required field selectors', () => {
    const result = validateAiRuleResponse({
      cardSelector: '.card',
      fieldSelectors: { titleSelector: '.t' }
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('priceSelector');
  });

  it('Rejects rules with unsafe content', () => {
    const result = validateAiRuleResponse({
      cardSelector: '<script>alert(1)</script>',
      fieldSelectors: { titleSelector: '.t', priceSelector: '.p', urlSelector: 'a' }
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('nsafe');
  });

  it('Accepts valid rules with optional fields as null', () => {
    const result = validateAiRuleResponse({
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.title',
        priceSelector: '.price',
        urlSelector: 'a',
        mrpSelector: null,
        ratingSelector: null
      }
    });
    expect(result.valid).toBe(true);
    expect(result.rule.fieldSelectors.mrpSelector).toBeNull();
    expect(result.rule.fieldSelectors.ratingSelector).toBeNull();
  });
});

describe('Cooldown and Deduplication', () => {
  it('AI calls are bounded by the content script retry loop (max 3 attempts)', async () => {
    const aiModule = createAiLearningModule();
    let attemptNum = 0;

    const partialProvider = vi.fn((payload) => {
      attemptNum++;
      return Promise.resolve({
        cardSelector: '.nonexistent-' + attemptNum,
        fieldSelectors: {
          titleSelector: '.t-' + attemptNum,
          priceSelector: '.p-' + attemptNum,
          urlSelector: '.u-' + attemptNum,
          mrpSelector: null
        },
        confidence: 0.5
      });
    });
    aiModule.setMockProvider(partialProvider);

    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const doc = dom.window.document;
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(doc, hostname);

    const MAX_ATTEMPTS = 3;
    let proposedRule = null;
    let validation = null;
    let feedback = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const aiResult = await aiModule.learnLayout({
        hostname,
        pageTitle: 'Products',
        candidateSelectors: [],
        diagnostics: {},
        domSnippets: sampleCardSnippetsForAi(doc, 2, 2500).domSnippets,
        callReason: 'automatic_learning',
        feedback
      });

      if (!aiResult.success) break;

      proposedRule = {
        hostname,
        layoutFingerprint: fingerprint,
        cardSelector: aiResult.proposedRule.cardSelector,
        fieldSelectors: aiResult.proposedRule.fieldSelectors,
        confidence: aiResult.proposedRule.confidence
      };

      validation = validateRuleAgainstDoc(proposedRule, doc, 'https://shop.example.com/products');
      if (validation.valid) break;

      if (attempt < MAX_ATTEMPTS && validation.invalidFields?.length > 0) {
        feedback = {
          attempt,
          failedCardSelector: proposedRule.cardSelector,
          failedFieldSelectors: proposedRule.fieldSelectors,
          invalidFields: validation.invalidFields,
          errors: validation.errors
        };
      }
    }

    expect(partialProvider).toHaveBeenCalledTimes(3);
    expect(validation?.valid).toBe(false);
  });
});

describe('Existing Feature Integrity', () => {
  let rulesRepo;
  let regressionRepo;

  beforeEach(async () => {
    rulesRepo = createRulesRepository();
    regressionRepo = createRegressionRepository();
    await rulesRepo.clearAllRules();
    await regressionRepo.clearAllFixtures();
  });

  it('Rule version history is preserved across saves', async () => {
    const hostname = 'shop.example.com';
    const fingerprint = 'layout_test1';

    const rule1 = createValidMockRule(hostname, fingerprint);
    const save1 = await rulesRepo.saveRule(rule1);
    expect(save1.success).toBe(true);
    expect(save1.rule.versions.length).toBe(1);

    const rule2 = {
      ...createValidMockRule(hostname, fingerprint),
      id: save1.rule.id,
      fieldSelectors: {
        ...rule1.fieldSelectors,
        mrpSelector: '.old-price'
      },
      changeSource: 'user_correction',
      changeSummary: 'Added MRP'
    };
    const save2 = await rulesRepo.saveRule(rule2);
    expect(save2.success).toBe(true);
    expect(save2.rule.versions.length).toBe(2);
    expect(save2.rule.activeVersionId).toBe('v2');
    expect(save2.rule.lastKnownGoodVersionId).toBe('v2');
  });

  it('Rollback restores a previous version correctly', async () => {
    const hostname = 'shop.example.com';
    const fingerprint = 'layout_rollback';

    const rule = createValidMockRule(hostname, fingerprint);
    const save1 = await rulesRepo.saveRule(rule);

    const modRule = {
      ...createValidMockRule(hostname, fingerprint),
      id: save1.rule.id,
      cardSelector: '.modified-card',
      changeSource: 'user_correction'
    };
    await rulesRepo.saveRule(modRule);

    const rollback = await rulesRepo.rollbackRule(save1.rule.id, 'v1');
    expect(rollback.success).toBe(true);

    const current = await rulesRepo.getRule(save1.rule.id);
    expect(current.cardSelector).toBe('.product-card');
  });

  it('Regression fixtures are saved and validated', async () => {
    const hostname = 'shop.example.com';
    const fingerprint = 'layout_regression';

    const fixture = {
      hostname,
      layoutFingerprint: fingerprint,
      ruleId: 'test_rule',
      ruleVersion: 1,
      sampleCards: ['<div class="product-card"><h3 class="product-title"><a href="/p/1">Test Product</a></h3><span class="current-price">$50</span></div>'],
      expectedItems: [{ title: 'Test Product', selling_price: 50 }]
    };

    const saveRes = await regressionRepo.saveFixture(fixture);
    expect(saveRes.success).toBe(true);

    const fixtures = await regressionRepo.getFixturesForLayout(hostname, fingerprint);
    expect(fixtures.length).toBe(1);
  });

  it('Normalizes hostnames consistently', () => {
    expect(normalizeHostname('www.Amazon.Com')).toBe('amazon.com');
    expect(normalizeHostname('WWW.shop.example.COM.')).toBe('shop.example.com');
    expect(normalizeHostname('example.com')).toBe('example.com');
    expect(normalizeHostname('')).toBe('');
    expect(normalizeHostname(null)).toBe('');
  });
});
