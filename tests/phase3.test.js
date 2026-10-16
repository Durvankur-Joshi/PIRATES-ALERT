import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { rulesRepository, computeLayoutFingerprint, createRulesRepository } from '../src/modules/rules/index.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { aiLearning, validateAiRuleResponse, getAiLogs, clearAiLogs, recordAiLog } from '../src/modules/ai/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { formatExtractionPayload, serializeToJson } from '../src/modules/export/index.js';

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('Phase 3: Stabilization & Strict Workflow Enforcement', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
    await clearAiLogs();
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('learns an unknown layout via mocked AI provider, validates and saves rule', async () => {
    const dom = loadFixture('layout-custom.html', 'https://specialty.com/search');
    const hostname = 'specialty.com';
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    let aiCallCount = 0;
    aiLearning.setMockProvider(async (payload) => {
      aiCallCount += 1;
      expect(payload.hostname).toBe('specialty.com');
      expect(payload.domSnippets.length).toBeGreaterThan(0);
      return {
        cardSelector: '.custom-catalog-item',
        fieldSelectors: {
          titleSelector: '.item-heading',
          priceSelector: '.amount-tag',
          imageSelector: '.lazy-prod'
        },
        confidence: 0.95
      };
    });

    const candidateCards = Array.from(dom.window.document.querySelectorAll('.custom-catalog-item'));
    const domSnippets = candidateCards.map((el) => el.outerHTML);

    const learnResult = await aiLearning.learnLayout({
      hostname,
      pageTitle: dom.window.document.title,
      candidateSelectors: ['.custom-catalog-item'],
      diagnostics: { candidateCount: 2 },
      domSnippets,
      callReason: 'heuristics_insufficient'
    });

    expect(learnResult.success).toBe(true);
    expect(aiCallCount).toBe(1);

    const proposedRule = {
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: learnResult.proposedRule.cardSelector,
      fieldSelectors: learnResult.proposedRule.fieldSelectors
    };

    const validation = validateRuleAgainstDoc(proposedRule, dom.window.document, 'https://specialty.com/search');
    expect(validation.valid).toBe(true);
    expect(validation.candidateCount).toBe(2);
    expect(validation.acceptedCount).toBe(2);
    expect(validation.fieldCoverage.title).toBe(1);
    expect(validation.fieldCoverage.price).toBe(1);

    const saveResult = await rulesRepository.saveRule({
      ...proposedRule,
      validationStatus: 'VALIDATED',
      testResults: validation
    });
    expect(saveResult.success).toBe(true);

    const saved = await rulesRepository.getRule(saveResult.rule.id);
    expect(saved).not.toBeNull();
    expect(saved.cardSelector).toBe('.custom-catalog-item');
    expect(saved.validationStatus).toBe('VALIDATED');

    const logs = await getAiLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('SUCCESS');
    expect(logs[0].isEstimated).toBe(true);
  });

  it('reuses exact matching rule with zero AI calls and rejects different layout fingerprint on same host', async () => {
    const hostname = 'store.example.com';
    const dom = loadFixture('layout-custom.html', `https://${hostname}/category/thermostats`);
    const fingerprint1 = computeLayoutFingerprint(dom.window.document, hostname);

    const validation = validateRuleAgainstDoc(
      {
        hostname,
        layoutFingerprint: fingerprint1,
        cardSelector: '.custom-catalog-item',
        fieldSelectors: {
          titleSelector: '.item-heading',
          priceSelector: '.amount-tag',
          imageSelector: '.lazy-prod'
        }
      },
      dom.window.document,
      `https://${hostname}/category/thermostats`
    );

    await rulesRepository.saveRule({
      id: `rule_${hostname}_${fingerprint1}`,
      hostname,
      layoutFingerprint: fingerprint1,
      cardSelector: '.custom-catalog-item',
      fieldSelectors: {
        titleSelector: '.item-heading',
        priceSelector: '.amount-tag',
        imageSelector: '.lazy-prod'
      },
      validationStatus: 'VALIDATED',
      testResults: validation
    });

    let aiCallCount = 0;
    aiLearning.setMockProvider(async () => {
      aiCallCount += 1;
      return {};
    });

    const matchingRule = await rulesRepository.findMatchingRule(hostname, fingerprint1);
    expect(matchingRule).not.toBeNull();
    expect(matchingRule.cardSelector).toBe('.custom-catalog-item');

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: `https://${hostname}/search?q=gadgets`,
      rules: {
        cardSelector: matchingRule.cardSelector,
        ...matchingRule.fieldSelectors
      }
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(2);
    expect(aiCallCount).toBe(0);

    const nonMatchingFingerprint = 'layout_completely_different_fingerprint';
    const noMatch = await rulesRepository.findMatchingRule(hostname, nonMatchingFingerprint);
    expect(noMatch).toBeNull();
  });

  it('supplied field selectors are strictly tested and cannot pass if invalid', () => {
    const dom = loadFixture('layout-grid.html', 'https://store.com/search');

    const ruleWithBrokenSelectors = {
      hostname: 'store.com',
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.completely-nonexistent-title-class',
        priceSelector: '.nonexistent-price-tag'
      }
    };

    const validation = validateRuleAgainstDoc(ruleWithBrokenSelectors, dom.window.document, 'https://store.com/search');
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes('titleSelector'))).toBe(true);
    expect(validation.errors.some((e) => e.includes('priceSelector'))).toBe(true);
    expect(validation.invalidFields).toContain('titleSelector');
    expect(validation.invalidFields).toContain('priceSelector');
  });

  it('rejects unverified rules and does not mark them validated without test results', async () => {
    const unverifiedRule = {
      id: 'rule_fake_valid',
      hostname: 'unverified.com',
      layoutFingerprint: 'fp_unverified',
      cardSelector: '.item',
      validationStatus: 'VALIDATED'
    };

    const saveResult = await rulesRepository.saveRule(unverifiedRule);
    expect(saveResult.success).toBe(true);
    expect(saveResult.rule.validationStatus).toBe('UNVALIDATED');

    const retrieved = await rulesRepository.getRule('rule_fake_valid');
    expect(retrieved.validationStatus).toBe('UNVALIDATED');

    const matched = await rulesRepository.findMatchingRule('unverified.com', 'fp_unverified');
    expect(matched).toBeNull();
  });

  it('preserves existing working rule when an invalid replacement is attempted', async () => {
    const hostname = 'preserve.com';
    const fingerprint = 'fp_preserve';
    const ruleId = `rule_${hostname}_${fingerprint}`;

    await rulesRepository.saveRule({
      id: ruleId,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.valid-card',
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const badReplacement = {
      id: ruleId,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.broken-card',
      validationStatus: 'UNVALIDATED'
    };

    const saveResult = await rulesRepository.saveRule(badReplacement);
    expect(saveResult.success).toBe(false);

    const preserved = await rulesRepository.getRule(ruleId);
    expect(preserved.cardSelector).toBe('.valid-card');
    expect(preserved.validationStatus).toBe('VALIDATED');
  });

  it('distinguishes multiple layouts under the same hostname independently', async () => {
    const hostname = 'multi-store.com';
    const domGrid = loadFixture('layout-grid.html', 'https://multi-store.com/grid');
    const domCustom = loadFixture('layout-custom.html', 'https://multi-store.com/shelf');

    const fpGrid = computeLayoutFingerprint(domGrid.window.document, hostname);
    const fpCustom = computeLayoutFingerprint(domCustom.window.document, hostname);

    expect(fpGrid).not.toBe(fpCustom);

    await rulesRepository.saveRule({
      id: `rule_grid`,
      hostname,
      layoutFingerprint: fpGrid,
      cardSelector: '.product-card',
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    await rulesRepository.saveRule({
      id: `rule_shelf`,
      hostname,
      layoutFingerprint: fpCustom,
      cardSelector: '.custom-catalog-item',
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const matchGrid = await rulesRepository.findMatchingRule(hostname, fpGrid);
    expect(matchGrid.cardSelector).toBe('.product-card');

    const matchCustom = await rulesRepository.findMatchingRule(hostname, fpCustom);
    expect(matchCustom.cardSelector).toBe('.custom-catalog-item');

    expect(await rulesRepository.findMatchingRule(hostname, 'fp_unknown')).toBeNull();
  });

  it('persists and survives repository reinitialization with mocked chrome.storage.local', async () => {
    const mockStorage = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: (keys, cb) => {
            const res = {};
            for (const k of keys) {
              if (mockStorage[k]) res[k] = JSON.parse(JSON.stringify(mockStorage[k]));
            }
            cb(res);
          },
          set: (items, cb) => {
            Object.assign(mockStorage, JSON.parse(JSON.stringify(items)));
            if (cb) cb();
          },
          remove: (keys, cb) => {
            for (const k of keys) delete mockStorage[k];
            if (cb) cb();
          }
        }
      }
    };

    const repo1 = createRulesRepository();
    await repo1.saveRule({
      id: 'persisted_rule_1',
      hostname: 'persistent.com',
      layoutFingerprint: 'fp_persist',
      cardSelector: '.persistent-item',
      validationStatus: 'VALIDATED',
      testResults: { valid: true }
    });

    const repo2 = createRulesRepository();
    const retrieved = await repo2.getRule('persisted_rule_1');
    expect(retrieved).not.toBeNull();
    expect(retrieved.hostname).toBe('persistent.com');
    expect(retrieved.cardSelector).toBe('.persistent-item');
  });

  it('correctly logs provider token counts versus estimates independently', async () => {
    const logBothReported = await recordAiLog({
      hostname: 'api-reported.com',
      callReason: 'layout_learning',
      status: 'SUCCESS',
      inputTokens: 150,
      outputTokens: 75,
      inputEstimated: false,
      outputEstimated: false
    });

    expect(logBothReported.inputTokens).toBe(150);
    expect(logBothReported.outputTokens).toBe(75);
    expect(logBothReported.isEstimated).toBe(false);
    expect(logBothReported.estimationMethod).toBe('provider_reported');

    const logInputReportedOnly = await recordAiLog({
      hostname: 'hybrid.com',
      callReason: 'layout_learning',
      status: 'SUCCESS',
      inputTokens: 200,
      responseChars: 400,
      inputEstimated: false,
      outputEstimated: true
    });

    expect(logInputReportedOnly.inputTokens).toBe(200);
    expect(logInputReportedOnly.outputTokens).toBe(100);
    expect(logInputReportedOnly.isEstimated).toBe(true);
    expect(logInputReportedOnly.estimationMethod).toBe('input_reported_output_estimated');

    const logBothEstimated = await recordAiLog({
      hostname: 'estimated.com',
      callReason: 'layout_learning',
      status: 'SUCCESS',
      payloadChars: 400,
      responseChars: 200
    });

    expect(logBothEstimated.inputTokens).toBe(100);
    expect(logBothEstimated.outputTokens).toBe(50);
    expect(logBothEstimated.isEstimated).toBe(true);
    expect(logBothEstimated.estimationMethod).toBe('4_chars_per_token_heuristic');
  });

  it('rejects broad card selectors and unsafe syntax', () => {
    const dom = loadFixture('layout-grid.html');

    expect(validateRuleAgainstDoc({ cardSelector: 'div' }, dom.window.document).valid).toBe(false);
    expect(validateRuleAgainstDoc({ cardSelector: 'a' }, dom.window.document).valid).toBe(false);
    expect(validateRuleAgainstDoc({ cardSelector: 'body' }, dom.window.document).valid).toBe(false);
    expect(validateRuleAgainstDoc({ cardSelector: '.item <script>' }, dom.window.document).valid).toBe(false);
  });

  it('keeps deterministic extraction and export usable even when AI provider fails', async () => {
    aiLearning.setMockProvider(async () => {
      throw new Error('AI service quota exceeded');
    });

    const learnAttempt = await aiLearning.learnLayout({
      hostname: 'failing-host.com',
      domSnippets: ['<div class="test"></div>']
    });
    expect(learnAttempt.success).toBe(false);
    expect(learnAttempt.error).toContain('AI service quota exceeded');

    const dom = loadFixture('layout-grid.html', 'https://store.com');
    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://store.com/search'
    });
    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(3);

    const payload = formatExtractionPayload(result.metadata, result.items);
    const jsonStr = serializeToJson(payload);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.totalItems).toBe(3);
  });
});
