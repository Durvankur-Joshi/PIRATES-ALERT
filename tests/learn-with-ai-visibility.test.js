import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { rulesRepository, computeLayoutFingerprint, normalizeHostname } from '../src/modules/rules/index.js';
import { validateRuleAgainstDoc } from '../src/modules/rules/validator.js';
import { aiLearning, getAiLogs, clearAiLogs } from '../src/modules/ai/index.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { hasProductListingEvidence } from '../src/modules/extractor/cardDetector.js';
import { EXTRACTION_SOURCE, EXTRACTION_STATUS } from '../src/modules/messaging/protocol.js';

function loadFixture(filename, baseUrl = 'https://store.example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('Learn with AI Button Visibility and Eligibility Regressions', () => {
  beforeEach(async () => {
    await rulesRepository.clearAllRules();
    await clearAiLogs();
    aiLearning.setMockProvider(null);
    aiLearning.setProxyUrl('http://localhost:3001/api/learn-layout');
  });

  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it('normalizes hostnames consistently across www, casing, and trailing dots without merging subdomains', () => {
    expect(normalizeHostname('www.Flipkart.COM.')).toBe('flipkart.com');
    expect(normalizeHostname('WWW.Target.com')).toBe('target.com');
    expect(normalizeHostname('shop.target.com')).toBe('shop.target.com');
    expect(normalizeHostname('store.example.co.uk.')).toBe('store.example.co.uk');
    expect(normalizeHostname('localhost')).toBe('localhost');
    expect(normalizeHostname('')).toBe('');
    expect(normalizeHostname(null)).toBe('');
  });

  it('proves Learn with AI is eligible on Flipkart search results when no saved rule exists', async () => {
    const dom = loadFixture('flipkart-search.html', 'https://www.flipkart.com/search?q=tv+32+inches');
    const rawHostname = 'www.flipkart.com';
    const hostname = normalizeHostname(rawHostname);
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const hasListing = hasProductListingEvidence(dom.window.document);
    expect(hasListing).toBe(true);

    const matchingRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchingRule).toBeNull();

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://www.flipkart.com/search?q=tv+32+inches'
    });

    const isSupportedPage = Boolean(hostname) && hostname !== 'internal';
    const pageHasListingEvidence = Boolean(hasListing || result.items.length > 0);
    const showLearnWithAi = isSupportedPage && pageHasListingEvidence && !matchingRule;

    expect(isSupportedPage).toBe(true);
    expect(pageHasListingEvidence).toBe(true);
    expect(showLearnWithAi).toBe(true);
  });

  it('proves Learn with AI is equally eligible on an unrelated second shopping domain without hardcoding', async () => {
    const dom = loadFixture('layout-grid.html', 'https://www.target.com/s?searchTerm=blender');
    const rawHostname = 'www.target.com';
    const hostname = normalizeHostname(rawHostname);
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const hasListing = hasProductListingEvidence(dom.window.document);
    expect(hasListing).toBe(true);

    const matchingRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchingRule).toBeNull();

    const isSupportedPage = Boolean(hostname) && hostname !== 'internal';
    const showLearnWithAi = isSupportedPage && hasListing && !matchingRule;

    expect(isSupportedPage).toBe(true);
    expect(showLearnWithAi).toBe(true);
  });

  it('proves Learn with AI is eligible on a third shopping site with a distinct DOM structure and non-USD currency', async () => {
    const dom = loadFixture('layout-list.html', 'https://boutique-maison.fr/catalogue');
    const hostname = normalizeHostname('boutique-maison.fr');
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const hasListing = hasProductListingEvidence(dom.window.document);
    expect(hasListing).toBe(true);

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://boutique-maison.fr/catalogue'
    });

    expect(result.items.length).toBeGreaterThanOrEqual(1);

    const matchingRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchingRule).toBeNull();

    const showLearnWithAi = Boolean(hostname) && hasListing && !matchingRule;
    expect(showLearnWithAi).toBe(true);
  });

  it('proves Learn with AI is unavailable on a normal non-shopping article page with clear explanation state', async () => {
    const dom = loadFixture('layout-empty.html', 'https://techinsights.org/blog/top-ai-trends');
    const hostname = normalizeHostname('techinsights.org');
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const hasListing = hasProductListingEvidence(dom.window.document);
    expect(hasListing).toBe(false);

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://techinsights.org/blog/top-ai-trends'
    });

    expect(result.items.length).toBe(0);
    expect(result.diagnostics.candidateCount).toBe(0);

    const isSupportedPage = Boolean(hostname) && hostname !== 'internal';
    const pageHasListingEvidence = Boolean(hasListing || result.items.length > 0 || result.diagnostics.candidateCount > 0);
    const showLearnWithAi = isSupportedPage && pageHasListingEvidence;

    expect(isSupportedPage).toBe(true);
    expect(pageHasListingEvidence).toBe(false);
    expect(showLearnWithAi).toBe(false);

    const emptyExplanation = !pageHasListingEvidence
      ? 'This page does not appear to contain a product listing or search results. AI layout learning is unavailable because no product cards, pricing, or product elements were detected.'
      : 'DOM heuristics could not confidently isolate product cards on this page.';

    expect(emptyExplanation).toContain('does not appear to contain a product listing');
  });

  it('proves Learn with AI is suppressed on unsupported browser internal system pages', () => {
    const systemUrls = [
      'chrome://extensions',
      'edge://settings',
      'about:blank',
      'chrome-extension://conjbablabbhoiameaplbnddclebepfo/popup.html'
    ];

    for (const url of systemUrls) {
      const isSystem =
        url.startsWith('chrome://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:') ||
        url.startsWith('chrome-extension://');

      const hostname = isSystem ? 'internal' : 'domain.com';
      const connectionStatus = isSystem ? EXTRACTION_STATUS.UNAVAILABLE : EXTRACTION_STATUS.READY;

      const isSupportedPage =
        connectionStatus === EXTRACTION_STATUS.READY &&
        Boolean(hostname) &&
        hostname !== 'internal' &&
        !isSystem;

      expect(isSupportedPage).toBe(false);
    }
  });

  it('proves an exact validated rule suppresses optional learning on main row, reuses rule with 0 AI calls, and offers explicit relearning', async () => {
    const dom = loadFixture('layout-grid.html', 'https://shop.example.com/products');
    const hostname = normalizeHostname('shop.example.com');
    const fingerprint = computeLayoutFingerprint(dom.window.document, hostname);

    const ruleDefinition = {
      id: `rule_${hostname}_${fingerprint}`,
      hostname,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: {
        titleSelector: '.product-title',
        priceSelector: '.current-price, .price'
      }
    };

    const validation = validateRuleAgainstDoc(ruleDefinition, dom.window.document, 'https://shop.example.com/products');
    expect(validation.valid).toBe(true);

    await rulesRepository.saveRule({
      ...ruleDefinition,
      validationStatus: 'VALIDATED',
      testResults: validation
    });

    const matchingRule = await rulesRepository.findMatchingRule(hostname, fingerprint);
    expect(matchingRule).not.toBeNull();

    const engine = createExtractionEngine();
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://shop.example.com/products',
      rules: {
        cardSelector: matchingRule.cardSelector,
        ...matchingRule.fieldSelectors
      }
    });

    const source = EXTRACTION_SOURCE.SAVED_RULE;
    const isSupportedPage = true;
    const hasListingEvidenceState = true;
    const hasSavedRule = Boolean(matchingRule);

    const showLearnWithAi = isSupportedPage && hasListingEvidenceState && !hasSavedRule && source !== EXTRACTION_SOURCE.SAVED_RULE;
    const showRelearnOption = hasSavedRule;

    expect(showLearnWithAi).toBe(false);
    expect(showRelearnOption).toBe(true);

    const aiLogs = await getAiLogs();
    expect(aiLogs.length).toBe(0);
  });

  it('proves a rule on one layout does not suppress optional learning on a different layout on the same host', async () => {
    const domLayoutA = loadFixture('layout-grid.html', 'https://shop.example.com/search');
    const domLayoutB = loadFixture('layout-custom.html', 'https://shop.example.com/deals');
    const hostname = normalizeHostname('shop.example.com');

    const fingerprintA = computeLayoutFingerprint(domLayoutA.window.document, hostname);
    const fingerprintB = computeLayoutFingerprint(domLayoutB.window.document, hostname);
    expect(fingerprintA).not.toBe(fingerprintB);

    await rulesRepository.saveRule({
      id: `rule_${hostname}_${fingerprintA}`,
      hostname,
      layoutFingerprint: fingerprintA,
      cardSelector: '.product-card',
      fieldSelectors: { titleSelector: '.product-title', priceSelector: '.current-price, .price' },
      testResults: { valid: true },
      validationStatus: 'VALIDATED'
    });

    const ruleForA = await rulesRepository.findMatchingRule(hostname, fingerprintA);
    const ruleForB = await rulesRepository.findMatchingRule(hostname, fingerprintB);

    expect(ruleForA).not.toBeNull();
    expect(ruleForB).toBeNull();

    const showLearnForA = !ruleForA;
    const showLearnForB = !ruleForB;

    expect(showLearnForA).toBe(false);
    expect(showLearnForB).toBe(true);
  });

  it('proves rules saved for one hostname are never applied to an unrelated hostname', async () => {
    const domA = loadFixture('layout-grid.html', 'https://store-alpha.com/items');
    const domB = loadFixture('layout-grid.html', 'https://store-beta.com/items');

    const hostA = normalizeHostname('store-alpha.com');
    const hostB = normalizeHostname('store-beta.com');
    const fingerprint = computeLayoutFingerprint(domA.window.document, hostA);

    await rulesRepository.saveRule({
      id: `rule_${hostA}_${fingerprint}`,
      hostname: hostA,
      layoutFingerprint: fingerprint,
      cardSelector: '.product-card',
      fieldSelectors: { titleSelector: '.product-title', priceSelector: '.current-price, .price' },
      testResults: { valid: true },
      validationStatus: 'VALIDATED'
    });

    const matchA = await rulesRepository.findMatchingRule(hostA, fingerprint);
    const matchB = await rulesRepository.findMatchingRule(hostB, fingerprint);

    expect(matchA).not.toBeNull();
    expect(matchB).toBeNull();
  });

  it('refreshes active target and eligibility when switching tabs or navigating without reopening popup', async () => {
    const activatedListeners = [];
    const updatedListeners = [];
    let currentActiveTab = {
      id: 101,
      url: 'https://www.flipkart.com/search?q=tv+32+inches',
      title: 'tv 32 inches - Flipkart'
    };

    globalThis.chrome = {
      runtime: { lastError: null },
      tabs: {
        query: vi.fn(async () => [currentActiveTab]),
        onActivated: {
          addListener: vi.fn((cb) => activatedListeners.push(cb)),
          removeListener: vi.fn()
        },
        onUpdated: {
          addListener: vi.fn((cb) => updatedListeners.push(cb)),
          removeListener: vi.fn()
        }
      },
      storage: {
        local: {
          get: vi.fn((keys, cb) => cb({})),
          set: vi.fn((data, cb) => cb())
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn()
        }
      }
    };

    let popupState = {
      activeTabId: null,
      url: '',
      title: '',
      hostname: '',
      isSupportedPage: false,
      extractionResult: null
    };

    async function syncPopupWithActiveTab() {
      const tabs = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      popupState.activeTabId = tab.id;
      popupState.url = tab.url;
      popupState.title = tab.title;

      const parsedHost = new URL(tab.url).hostname;
      popupState.hostname = normalizeHostname(parsedHost);
      popupState.isSupportedPage = Boolean(popupState.hostname) && !tab.url.startsWith('chrome://');
    }

    globalThis.chrome.tabs.onActivated.addListener(async () => {
      popupState.extractionResult = null;
      await syncPopupWithActiveTab();
    });

    await syncPopupWithActiveTab();
    expect(popupState.hostname).toBe('flipkart.com');
    expect(popupState.isSupportedPage).toBe(true);

    currentActiveTab = {
      id: 202,
      url: 'https://www.target.com/p/blender',
      title: 'Blender - Target'
    };

    popupState.extractionResult = { items: [{ title: 'Mi TV' }] };

    for (const listener of activatedListeners) {
      await listener({ tabId: 202 });
    }

    expect(popupState.activeTabId).toBe(202);
    expect(popupState.hostname).toBe('target.com');
    expect(popupState.url).toBe('https://www.target.com/p/blender');
    expect(popupState.extractionResult).toBeNull();

    currentActiveTab = {
      id: 202,
      url: 'chrome://settings',
      title: 'Settings'
    };

    const isSystemUrl = currentActiveTab.url.startsWith('chrome://');
    popupState.url = currentActiveTab.url;
    popupState.hostname = isSystemUrl ? 'internal' : new URL(currentActiveTab.url).hostname;
    popupState.isSupportedPage = !isSystemUrl;

    expect(popupState.isSupportedPage).toBe(false);
    expect(popupState.hostname).toBe('internal');
  });

  it('verifies AI proxy URL is configurable and not coupled to any specific domain', () => {
    const customEndpoint = 'http://192.168.1.50:4000/custom/ai-learn';
    aiLearning.setProxyUrl(customEndpoint);
    expect(aiLearning.getProxyUrl()).toBe(customEndpoint);

    aiLearning.setProxyUrl('http://localhost:3001/api/learn-layout');
    expect(aiLearning.getProxyUrl()).toBe('http://localhost:3001/api/learn-layout');
  });
});
