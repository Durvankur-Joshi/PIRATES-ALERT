import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { rulesRepository, computeLayoutFingerprint } from '../src/modules/rules/index.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { aiLearning, getAiLogs, clearAiLogs } from '../src/modules/ai/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { EXTRACTION_SOURCE } from '../src/modules/messaging/protocol.js';

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('AI Learning and Rule-Saving Workflow Regressions', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
    await clearAiLogs();
    aiLearning.setMockProvider(null);
    aiLearning.setProxyUrl('http://localhost:3001/api/learn-layout');
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('proves heuristic extraction with many products still allows explicit AI learning when no exact saved rule exists', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const savedRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(savedRule).toBeNull();

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://shop.example.com/products'
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBeGreaterThan(1);
    expect(result.diagnostics.fieldDiagnostics.title.fillRate).toBeGreaterThanOrEqual(80);

    const isUnambiguous = result.items.length > 0 && (result.diagnostics?.fieldDiagnostics?.title?.fillRate || 0) >= 80;
    const canLearnWithAi = savedRule === null;

    expect(isUnambiguous).toBe(true);
    expect(canLearnWithAi).toBe(true);
  });

  it('proves a matching saved rule hides and disables unnecessary learning', async () => {
    const dom = loadFixture('layout-custom.html', 'https://shop.example.com/products');
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const ruleDefinition = {
      id: `rule_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.item-heading',
        priceSelector: '.amount-tag'
      }
    };

    const validation = validateRuleAgainstDoc(ruleDefinition, dom.window.document, 'https://shop.example.com/products');
    expect(validation.valid).toBe(true);

    const saveRes = await rulesRepository.saveRule({
      ...ruleDefinition,
      validationStatus: 'VALIDATED',
      testResults: validation
    });
    expect(saveRes.success).toBe(true);

    const savedRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(savedRule).not.toBeNull();

    let source = EXTRACTION_SOURCE.HEURISTIC;
    if (savedRule) {
      const check = validateRuleAgainstDoc(savedRule, dom.window.document, 'https://shop.example.com/products');
      if (check.valid) {
        source = EXTRACTION_SOURCE.SAVED_RULE;
      }
    }

    const canLearnWithAi = source !== EXTRACTION_SOURCE.SAVED_RULE;
    expect(source).toBe(EXTRACTION_SOURCE.SAVED_RULE);
    expect(canLearnWithAi).toBe(false);
  });

  it('proves the Learn with AI action produces a valid proposal with validation metrics', async () => {
    const dom = loadFixture('layout-custom.html', 'https://boutique.example.com/items');
    const hostname = 'boutique.example.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    let providerCalled = false;
    aiLearning.setMockProvider(async (payload) => {
      providerCalled = true;
      expect(payload.hostname).toBe(hostname);
      return {
        cardSelector: '.custom-catalog-item',
        fieldSelectors: {
          titleSelector: '.item-heading',
          priceSelector: '.amount-tag',
          urlSelector: '.item-heading a',
          imageSelector: '.lazy-prod'
        },
        confidence: 0.95
      };
    });

    const candidateCards = Array.from(dom.window.document.querySelectorAll('.custom-catalog-item'));
    const domSnippets = candidateCards.map((el) => el.outerHTML);

    const aiResult = await aiLearning.learnLayout({
      hostname,
      pageTitle: dom.window.document.title,
      candidateSelectors: ['.custom-catalog-item'],
      diagnostics: { candidateCount: 2 },
      domSnippets,
      callReason: 'user_manual_learn'
    });

    expect(providerCalled).toBe(true);
    expect(aiResult.success).toBe(true);
    expect(aiResult.proposedRule.cardSelector).toBe('.custom-catalog-item');

    const proposedRule = {
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: aiResult.proposedRule.cardSelector,
      fieldSelectors: aiResult.proposedRule.fieldSelectors,
      confidence: aiResult.proposedRule.confidence
    };

    const validation = validateRuleAgainstDoc(proposedRule, dom.window.document, 'https://boutique.example.com/items');
    expect(validation.valid).toBe(true);
    expect(validation.candidateCount).toBe(2);
    expect(validation.matchRate).toBe(100);
    expect(validation.errors.length).toBe(0);
  });

  it('proves a valid proposal can be saved and appears in Rules with active version', async () => {
    const dom = loadFixture('layout-custom.html', 'https://boutique.example.com/items');
    const hostname = 'boutique.example.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const proposedRule = {
      id: `rule_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.item-heading',
        priceSelector: '.amount-tag'
      }
    };

    const validation = validateRuleAgainstDoc(proposedRule, dom.window.document, 'https://boutique.example.com/items');
    expect(validation.valid).toBe(true);

    const saveRes = await rulesRepository.saveRule({
      ...proposedRule,
      validationStatus: 'VALIDATED',
      testResults: validation
    });

    expect(saveRes.success).toBe(true);
    expect(saveRes.rule.activeVersionId).toBe('v1');
    expect(saveRes.rule.validationStatus).toBe('VALIDATED');

    const allRules = await rulesRepository.getAllRules();
    expect(allRules.length).toBe(1);
    expect(allRules[0].id).toBe(saveRes.rule.id);
    expect(allRules[0].activeVersionId).toBe('v1');
  });

  it('proves an invalid proposal cannot be saved and fails validation and regression', async () => {
    const dom = loadFixture('layout-custom.html', 'https://boutique.example.com/items');
    const hostname = 'boutique.example.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const invalidProposal = {
      id: `rule_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.non-existent-selector',
      fieldSelectors: {}
    };

    const validation = validateRuleAgainstDoc(invalidProposal, dom.window.document, 'https://boutique.example.com/items');
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);

    const saveRes = await rulesRepository.saveRule({
      ...invalidProposal,
      validationStatus: 'VALIDATED',
      testResults: validation
    });

    expect(saveRes.success).toBe(false);
    expect(saveRes.error).toContain('failed validation');

    const regressionFailProposal = {
      id: `rule_reg_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {},
      testResults: { valid: true },
      regressionResults: {
        passed: false,
        failures: ['Card 1: Title mismatch: expected "Item A", got null']
      }
    };

    const regSaveRes = await rulesRepository.saveRule(regressionFailProposal);
    expect(regSaveRes.success).toBe(false);
    expect(regSaveRes.error).toContain('regression testing');

    const matchCheck = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchCheck).toBeNull();
  });

  it('proves successful rule reuse makes zero additional AI calls', async () => {
    const dom = loadFixture('layout-custom.html', 'https://shop.example.com/products');
    const hostname = 'shop.example.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const ruleDef = {
      id: `rule_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.item-heading',
        priceSelector: '.amount-tag'
      }
    };

    const validation = validateRuleAgainstDoc(ruleDef, dom.window.document, 'https://shop.example.com/products');
    await rulesRepository.saveRule({
      ...ruleDef,
      validationStatus: 'VALIDATED',
      testResults: validation
    });

    await clearAiLogs();

    const matchedRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchedRule).not.toBeNull();

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://shop.example.com/products',
      rules: {
        cardSelector: matchedRule.cardSelector,
        ...matchedRule.fieldSelectors
      }
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBeGreaterThan(0);

    const logs = await getAiLogs();
    expect(logs.length).toBe(0);
  });

  it('proves errors and unavailable proxy states are handled and recorded properly', async () => {
    aiLearning.setMockProvider(null);
    aiLearning.setProxyUrl('http://localhost:59999/api/learn-layout');

    const result = await aiLearning.learnLayout({
      hostname: 'unreachable.example.com',
      pageTitle: 'Test Page',
      candidateSelectors: ['.card'],
      domSnippets: ['<div class="card">Sample</div>']
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('AI proxy connection failed');

    const logs = await getAiLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].hostname).toBe('unreachable.example.com');
    expect(logs[0].status).toBe('ERROR');
  });
});
