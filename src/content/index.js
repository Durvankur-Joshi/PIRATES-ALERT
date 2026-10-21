import { MESSAGE_TYPES, EXTRACTION_SOURCE } from '../modules/messaging/protocol.js';
import { extractionEngine } from '../modules/extractor/index.js';
import { rulesRepository, computeLayoutFingerprint, normalizeHostname } from '../modules/rules/index.js';
import { validateRuleAgainstDoc } from '../modules/rules/validator.js';
import { aiLearning, getAiLogs } from '../modules/ai/index.js';
import { preferencesRepository } from '../modules/preferences/index.js';
import {
  correctionsRepository,
  deduceFieldSelectorFromCard,
  previewSelectorCorrection,
  applySelectorCorrection
} from '../modules/corrections/index.js';
import { normalizeText } from '../modules/extractor/utils.js';
import { regressionRepository } from '../modules/regression/index.js';
import { sampleCardSnippetsForAi, hasProductListingEvidence } from '../modules/extractor/cardDetector.js';

let isExtractionBusy = false;
let isLearningBusy = false;

const VALID_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));

const AI_COOLDOWN_MS = 30000;
const _aiCooldowns = new Map();

function isOnCooldown(fingerprint) {
  const last = _aiCooldowns.get(fingerprint);
  if (!last) return false;
  return (Date.now() - last) < AI_COOLDOWN_MS;
}

function setCooldown(fingerprint) {
  _aiCooldowns.set(fingerprint, Date.now());
}

export function _resetCooldowns() {
  _aiCooldowns.clear();
}

async function performAutoLearning(hostname, layoutFingerprint, title, document, url, diagnostics) {
  const { candidateSelectors, domSnippets } = sampleCardSnippetsForAi(document, 2, 2500);

  if (!domSnippets || domSnippets.length === 0) {
    return {
      success: false,
      error: 'No product card elements could be isolated for AI learning.'
    };
  }

  let proposedRule = null;
  let validation = null;
  let lastError = null;
  const MAX_ATTEMPTS = 3;
  let feedback = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const aiResult = await aiLearning.learnLayout({
      hostname,
      pageTitle: title,
      candidateSelectors,
      diagnostics: diagnostics || {},
      domSnippets,
      callReason: 'automatic_learning',
      feedback
    });

    if (!aiResult.success) {
      lastError = aiResult.error;
      break;
    }

    proposedRule = {
      hostname,
      layoutFingerprint,
      cardSelector: aiResult.proposedRule.cardSelector,
      fieldSelectors: aiResult.proposedRule.fieldSelectors,
      confidence: aiResult.proposedRule.confidence
    };

    validation = validateRuleAgainstDoc(proposedRule, document, url);

    if (validation.valid) {
      break;
    }

    if (attempt < MAX_ATTEMPTS && validation.invalidFields && validation.invalidFields.length > 0) {
      const invalidFields = [...validation.invalidFields];
      if (validation.acceptedCount === 0 && !invalidFields.includes('cardSelector')) {
        invalidFields.unshift('cardSelector');
      }
      feedback = {
        attempt,
        failedCardSelector: proposedRule.cardSelector,
        failedFieldSelectors: proposedRule.fieldSelectors,
        invalidFields,
        errors: validation.errors
      };
    }
  }

  if (!proposedRule && lastError) {
    return { success: false, error: lastError };
  }

  if (!proposedRule) {
    return { success: false, error: 'AI did not produce a rule proposal.' };
  }

  if (!validation || !validation.valid) {
    return {
      success: false,
      error: `AI proposed selectors failed validation: ${(validation?.errors || []).join('; ')}`,
      proposedRule,
      validation
    };
  }

  const regressionCheck = await regressionRepository.runRegressionOnCandidate(
    proposedRule,
    (html) => new DOMParser().parseFromString(html, 'text/html')
  );

  if (!regressionCheck.passed) {
    return {
      success: false,
      error: `Rule passed live validation but failed regression: ${regressionCheck.failures.join('; ')}`,
      proposedRule,
      validation
    };
  }

  const saveRes = await rulesRepository.saveRule({
    ...proposedRule,
    validationStatus: 'VALIDATED',
    testResults: validation,
    regressionResults: regressionCheck,
    changeSource: 'ai_learning',
    changeSummary: 'Automatically learned layout rule'
  });

  if (!saveRes.success) {
    return {
      success: false,
      error: saveRes.error || 'Failed to save validated rule.',
      proposedRule,
      validation
    };
  }

  try {
    const sampleElements = Array.from(document.querySelectorAll(proposedRule.cardSelector)).slice(0, 3);
    const sampleCards = sampleElements.map((el) => el.outerHTML);
    if (sampleCards.length > 0) {
      await regressionRepository.saveFixture({
        hostname,
        layoutFingerprint,
        ruleId: saveRes.rule.id,
        ruleVersion: saveRes.rule.ruleVersion || 1,
        sampleCards,
        expectedItems: (validation.sampleItems || []).slice(0, 3)
      });
    }
  } catch {}

  return {
    success: true,
    rule: saveRes.rule,
    validation
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (!VALID_MESSAGE_TYPES.has(message.type)) {
    sendResponse({ success: false, error: 'Invalid or unsupported message type' });
    return false;
  }

  try {
    const serialized = JSON.stringify(message);
    if (serialized.length > 100 * 1024) {
      sendResponse({ success: false, error: 'Message payload exceeds maximum allowed size (100KB)' });
      return false;
    }
  } catch {
    sendResponse({ success: false, error: 'Malformed message payload' });
    return false;
  }

  const url = window.location.href;
  const title = document.title;
  const hostname = normalizeHostname(window.location.hostname);
  const layoutFingerprint = computeLayoutFingerprint(document, hostname);

  if (message.type === MESSAGE_TYPES.GET_PAGE_INFO) {
    (async () => {
      const savedRule = await rulesRepository.findMatchingRule(hostname, layoutFingerprint);
      let isActuallyValid = false;
      if (savedRule) {
        const check = validateRuleAgainstDoc(savedRule, document, url);
        isActuallyValid = check.valid;
      }

      const effectivePreferences = await preferencesRepository.getEffectivePreferences(hostname);
      const hasListing = hasProductListingEvidence(document);

      sendResponse({
        url,
        title,
        hostname,
        layoutFingerprint,
        hasSavedRule: isActuallyValid,
        savedRuleId: isActuallyValid ? savedRule.id : null,
        activeVersionId: isActuallyValid ? savedRule.activeVersionId : null,
        cardSelector: isActuallyValid ? savedRule.cardSelector : null,
        hasListingEvidence: hasListing,
        canLearnWithAi: !isActuallyValid && hasListing,
        effectivePreferences,
        status: 'READY'
      });
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.EXTRACT_PRODUCTS) {
    if (isExtractionBusy) {
      sendResponse({
        success: false,
        status: 'BUSY',
        message: 'Extraction is currently in progress. Please wait.'
      });
      return false;
    }

    isExtractionBusy = true;
    (async () => {
      try {
        let extractionRule = null;
        let source = EXTRACTION_SOURCE.HEURISTIC;
        let appliedRuleId = null;
        let autoLearnStatus = null;

        const savedRule = await rulesRepository.findMatchingRule(hostname, layoutFingerprint);

        if (savedRule) {
          const validation = validateRuleAgainstDoc(savedRule, document, url);
          if (validation.valid) {
            extractionRule = {
              cardSelector: savedRule.cardSelector,
              ...savedRule.fieldSelectors
            };
            source = EXTRACTION_SOURCE.SAVED_RULE;
            appliedRuleId = savedRule.id;
          } else {
            autoLearnStatus = 'Saved rule failed validation. Attempting recovery...';

            if (!isOnCooldown(layoutFingerprint) && !isLearningBusy) {
              isLearningBusy = true;
              setCooldown(layoutFingerprint);
              try {
                const learnResult = await performAutoLearning(
                  hostname, layoutFingerprint, title, document, url,
                  { reason: 'rule_validation_failed', previousErrors: validation.errors }
                );
                if (learnResult.success && learnResult.rule) {
                  extractionRule = {
                    cardSelector: learnResult.rule.cardSelector,
                    ...learnResult.rule.fieldSelectors
                  };
                  source = EXTRACTION_SOURCE.SAVED_RULE;
                  appliedRuleId = learnResult.rule.id;
                  autoLearnStatus = 'Layout re-learned and saved.';
                } else {
                  if (savedRule.lastKnownGoodVersionId && savedRule.versions) {
                    const lastGood = savedRule.versions.find(
                      v => v.versionId === savedRule.lastKnownGoodVersionId
                    );
                    if (lastGood) {
                      const fallbackRule = {
                        ...savedRule,
                        cardSelector: lastGood.cardSelector,
                        fieldSelectors: lastGood.fieldSelectors
                      };
                      const fallbackCheck = validateRuleAgainstDoc(fallbackRule, document, url);
                      if (fallbackCheck.valid) {
                        extractionRule = {
                          cardSelector: lastGood.cardSelector,
                          ...lastGood.fieldSelectors
                        };
                        source = EXTRACTION_SOURCE.SAVED_RULE;
                        appliedRuleId = savedRule.id;
                        autoLearnStatus = 'Fell back to last known-good version.';
                      }
                    }
                  }
                  if (!extractionRule) {
                    autoLearnStatus = `Recovery failed: ${learnResult.error || 'AI relearning unsuccessful.'}`;
                  }
                }
              } catch (err) {
                autoLearnStatus = `Recovery error: ${err?.message || 'Unknown error'}`;
              } finally {
                isLearningBusy = false;
              }
            } else if (isOnCooldown(layoutFingerprint)) {
              autoLearnStatus = 'Rule validation failed. Recovery on cooldown—retry shortly.';
            } else if (isLearningBusy) {
              autoLearnStatus = 'Rule validation failed. Recovery already in progress.';
            }
          }
        } else {
          const hasListing = hasProductListingEvidence(document);

          if (hasListing && !isOnCooldown(layoutFingerprint) && !isLearningBusy) {
            isLearningBusy = true;
            setCooldown(layoutFingerprint);
            autoLearnStatus = 'New layout detected. Learning automatically...';
            try {
              const learnResult = await performAutoLearning(
                hostname, layoutFingerprint, title, document, url, {}
              );
              if (learnResult.success && learnResult.rule) {
                extractionRule = {
                  cardSelector: learnResult.rule.cardSelector,
                  ...learnResult.rule.fieldSelectors
                };
                source = EXTRACTION_SOURCE.SAVED_RULE;
                appliedRuleId = learnResult.rule.id;
                autoLearnStatus = 'Layout learned and saved.';
              } else {
                autoLearnStatus = `Automatic learning failed: ${learnResult.error || 'Unknown error'}`;
              }
            } catch (err) {
              autoLearnStatus = `Automatic learning error: ${err?.message || 'Unknown error'}`;
            } finally {
              isLearningBusy = false;
            }
          } else if (!hasListing) {
            autoLearnStatus = 'No product listing detected on this page.';
          } else if (isOnCooldown(layoutFingerprint)) {
            autoLearnStatus = 'Learning on cooldown for this layout—retry shortly.';
          } else if (isLearningBusy) {
            autoLearnStatus = 'Learning already in progress for this layout.';
          }
        }

        const result = await extractionEngine.execute({
          document,
          url,
          title,
          rules: extractionRule || message.rules || {}
        });

        const effectivePreferences = await preferencesRepository.getEffectivePreferences(hostname);

        if (source === EXTRACTION_SOURCE.SAVED_RULE && result.items.length > 0 && extractionRule) {
          const existingFixtures = await regressionRepository.getFixturesForLayout(hostname, layoutFingerprint);
          if (existingFixtures.length === 0) {
            try {
              const sampleElements = Array.from(document.querySelectorAll(extractionRule.cardSelector)).slice(0, 3);
              const sampleCards = sampleElements.map((el) => el.outerHTML);
              if (sampleCards.length > 0) {
                await regressionRepository.saveFixture({
                  hostname,
                  layoutFingerprint,
                  ruleId: appliedRuleId,
                  ruleVersion: savedRule?.ruleVersion || 1,
                  sampleCards,
                  expectedItems: result.items.slice(0, 3)
                });
              }
            } catch {}
          }
        }

        const hasListing = result.items.length > 0 || (result.diagnostics?.candidateCount > 0) || hasProductListingEvidence(document);
        const isUnambiguous = result.items.length > 0 && (result.diagnostics?.fieldDiagnostics?.title?.fillRate || 0) >= 80;

        sendResponse({
          success: true,
          ...result,
          source,
          appliedRuleId,
          layoutFingerprint,
          cardSelector: extractionRule?.cardSelector || null,
          effectivePreferences,
          hasListingEvidence: hasListing,
          canLearnWithAi: false,
          isUnambiguous,
          autoLearnStatus
        });
      } catch (err) {
        sendResponse({
          success: false,
          status: 'ERROR',
          message: err?.message || 'Extraction execution failed',
          items: [],
          source: EXTRACTION_SOURCE.HEURISTIC,
          diagnostics: {
            candidateCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            rejectionReasons: { missing_identity: 0, duplicate_url: 0, duplicate_id: 0 },
            truncated: false,
            discoveryMethod: 'none',
            fieldDiagnostics: {}
          },
          metadata: {
            url,
            title,
            totalExtracted: 0,
            timestamp: new Date().toISOString()
          }
        });
      } finally {
        isExtractionBusy = false;
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.AI_LEARN_LAYOUT) {
    if (isLearningBusy) {
      sendResponse({
        success: false,
        error: 'AI learning request is already in progress. Please wait.'
      });
      return false;
    }

    isLearningBusy = true;
    (async () => {
      try {
        const { candidateSelectors, domSnippets } = sampleCardSnippetsForAi(document, 2, 2500);

        if (!domSnippets || domSnippets.length === 0) {
          sendResponse({
            success: false,
            error: 'No product card or listing elements could be isolated on this page for AI learning.'
          });
          return;
        }

        let proposedRule = null;
        let validation = null;
        let lastError = null;
        const MAX_ATTEMPTS = 3;
        let feedback = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const aiResult = await aiLearning.learnLayout({
            hostname,
            pageTitle: title,
            candidateSelectors,
            diagnostics: message.diagnostics || {},
            domSnippets,
            callReason: message.callReason || 'heuristics_insufficient',
            feedback
          });

          if (!aiResult.success) {
            lastError = aiResult.error;
            break;
          }

          proposedRule = {
            hostname,
            layoutFingerprint,
            cardSelector: aiResult.proposedRule.cardSelector,
            fieldSelectors: aiResult.proposedRule.fieldSelectors,
            confidence: aiResult.proposedRule.confidence
          };

          validation = validateRuleAgainstDoc(proposedRule, document, url);

          if (validation.valid) {
            break;
          }

          if (attempt < MAX_ATTEMPTS && validation.invalidFields && validation.invalidFields.length > 0) {
            const invalidFields = [...validation.invalidFields];
            if (validation.acceptedCount === 0 && !invalidFields.includes('cardSelector')) {
              invalidFields.unshift('cardSelector');
            }
            feedback = {
              attempt,
              failedCardSelector: proposedRule.cardSelector,
              failedFieldSelectors: proposedRule.fieldSelectors,
              invalidFields,
              errors: validation.errors
            };
          }
        }

        if (!proposedRule && lastError) {
          sendResponse({
            success: false,
            error: lastError
          });
          return;
        }

        sendResponse({
          success: true,
          proposedRule,
          validation
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err?.message || 'AI layout learning failed'
        });
      } finally {
        isLearningBusy = false;
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.SAVE_RULE) {
    (async () => {
      try {
        const ruleToSave = message.rule;
        if (!ruleToSave || typeof ruleToSave !== 'object') {
          sendResponse({ success: false, error: 'Rule payload is missing or invalid' });
          return;
        }

        const validation = validateRuleAgainstDoc(ruleToSave, document, url);
        if (!validation.valid) {
          sendResponse({
            success: false,
            error: `Rule failed live validation: ${validation.errors.join('; ')}`
          });
          return;
        }

        const regressionCheck = await regressionRepository.runRegressionOnCandidate(
          ruleToSave,
          (html) => new DOMParser().parseFromString(html, 'text/html')
        );

        if (!regressionCheck.passed) {
          sendResponse({
            success: false,
            error: `Rule failed regression checks: ${regressionCheck.failures.join('; ')}`,
            regressionFailures: regressionCheck.failures
          });
          return;
        }

        const saveRes = await rulesRepository.saveRule({
          ...ruleToSave,
          validationStatus: 'VALIDATED',
          testResults: validation,
          regressionResults: regressionCheck
        });

        if (saveRes.success && saveRes.rule) {
          try {
            const sampleElements = Array.from(document.querySelectorAll(ruleToSave.cardSelector)).slice(0, 3);
            const sampleCards = sampleElements.map((el) => el.outerHTML);
            if (sampleCards.length > 0) {
              await regressionRepository.saveFixture({
                hostname,
                layoutFingerprint,
                ruleId: saveRes.rule.id,
                ruleVersion: saveRes.rule.ruleVersion || 1,
                sampleCards,
                expectedItems: (validation.sampleItems || []).slice(0, 3)
              });
            }
          } catch {}
        }

        sendResponse(saveRes);
      } catch (err) {
        sendResponse({ success: false, error: err?.message || 'Failed to validate and save rule' });
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_RULES) {
    rulesRepository.getAllRules().then((rules) => {
      sendResponse({ success: true, rules });
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.DELETE_RULE) {
    rulesRepository.deleteRule(message.ruleId).then((deleted) => {
      sendResponse({ success: deleted });
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_AI_LOGS) {
    getAiLogs().then((logs) => {
      sendResponse({ success: true, logs });
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_PREFERENCES) {
    (async () => {
      const allPrefs = await preferencesRepository.getAllPreferences();
      const effective = await preferencesRepository.getEffectivePreferences(hostname);
      sendResponse({ success: true, preferences: allPrefs, effectivePreferences: effective });
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.SAVE_PREFERENCES) {
    (async () => {
      if (message.isSite) {
        const res = await preferencesRepository.saveSitePreferences(hostname, message.preferences);
        sendResponse(res);
      } else {
        const res = await preferencesRepository.saveGlobalPreferences(message.preferences);
        sendResponse(res);
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_CORRECTIONS) {
    correctionsRepository.getAllCorrections().then((corrections) => {
      sendResponse({ success: true, corrections });
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.SAVE_CORRECTION) {
    (async () => {
      try {
        const corrRes = await correctionsRepository.saveCorrection({
          cardIndex: message.cardIndex,
          productId: message.productId,
          hostname,
          layoutFingerprint,
          ruleId: message.ruleId,
          field: message.field,
          originalValue: message.originalValue,
          correctedValue: message.correctedValue
        });

        if (!corrRes.success) {
          sendResponse({ success: false, error: corrRes.error });
          return;
        }

        let ruleUpdated = false;
        let updatedRule = null;

        const currentRule = await rulesRepository.findMatchingRule(hostname, layoutFingerprint);
        if (currentRule && typeof message.cardIndex === 'number') {
          const cards = Array.from(document.querySelectorAll(currentRule.cardSelector));
          const targetCard = cards[message.cardIndex];
          if (targetCard) {
            const selectorKeyMap = {
              title: 'titleSelector',
              selling_price: 'priceSelector',
              mrp: 'mrpSelector',
              product_url: 'urlSelector',
              image_url: 'imageSelector',
              rating: 'ratingSelector'
            };

            const targetKey = selectorKeyMap[message.field];
            if (targetKey) {
              const refinedSelector = deduceFieldSelectorFromCard(
                targetCard,
                message.field,
                message.correctedValue
              );

              if (refinedSelector) {
                const candidateRule = {
                  ...currentRule,
                  fieldSelectors: {
                    ...(currentRule.fieldSelectors || {}),
                    [targetKey]: refinedSelector
                  }
                };

                const valCheck = validateRuleAgainstDoc(candidateRule, document, url);
                if (valCheck.valid) {
                  const regCheck = await regressionRepository.runRegressionOnCandidate(
                    candidateRule,
                    (html) => new DOMParser().parseFromString(html, 'text/html')
                  );

                  if (regCheck.passed) {
                    const saveRes = await rulesRepository.saveRule({
                      ...candidateRule,
                      changeSource: 'user_correction',
                      changeSummary: `Updated ${message.field} selector via user correction`,
                      validationStatus: 'VALIDATED',
                      testResults: valCheck,
                      regressionResults: regCheck
                    });
                    if (saveRes.success) {
                      ruleUpdated = true;
                      updatedRule = saveRes.rule;
                    }
                  }
                }
              }
            }
          }
        }

        sendResponse({
          success: true,
          correction: corrRes.correction,
          ruleUpdated,
          updatedRule
        });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || 'Failed to save correction' });
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_RULE_HISTORY) {
    rulesRepository.getRuleHistory(message.ruleId).then((history) => {
      sendResponse(history);
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.ROLLBACK_RULE) {
    rulesRepository.rollbackRule(message.ruleId, message.targetVersionId).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.RUN_REGRESSION_TESTS) {
    regressionRepository.runRegressionOnCandidate(
      message.rule,
      (html) => new DOMParser().parseFromString(html, 'text/html')
    ).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.PREVIEW_SELECTOR_CORRECTION) {
    (async () => {
      try {
        const currentRule = await rulesRepository.findMatchingRule(hostname, layoutFingerprint);
        const cardSelector = (message.cardSelector && message.cardSelector.trim()) || currentRule?.cardSelector;
        const preview = previewSelectorCorrection({
          cardSelector,
          field: message.field || 'sellingPrice',
          proposedSelector: message.proposedSelector,
          doc: document
        });
        sendResponse({ success: true, preview, currentRule });
      } catch (err) {
        sendResponse({ success: false, error: err?.message || 'Failed to preview selector correction' });
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.APPLY_SELECTOR_CORRECTION) {
    (async () => {
      try {
        const currentRule = await rulesRepository.findMatchingRule(hostname, layoutFingerprint);
        const cardSelector = (message.cardSelector && message.cardSelector.trim()) || currentRule?.cardSelector;
        const res = await applySelectorCorrection({
          hostname,
          layoutFingerprint,
          cardSelector,
          field: message.field || 'sellingPrice',
          proposedSelector: message.proposedSelector,
          userConfirmedAmbiguity: Boolean(message.userConfirmedAmbiguity),
          doc: document,
          url
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ success: false, error: err?.message || 'Failed to apply selector correction' });
      }
    })();
    return true;
  }

  if (message.type === MESSAGE_TYPES.START_ELEMENT_PICKER) {
    removePickerListeners();
    activePickerCallback = sendResponse;
    activePickerMode = message.mode || 'field';
    activePickerCardSelector = message.cardSelector ? message.cardSelector.trim() : '';
    document.addEventListener('mousemove', onPickerMouseMove, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKeyDown, true);
    return true;
  }

  if (message.type === MESSAGE_TYPES.STOP_ELEMENT_PICKER) {
    if (activePickerCallback) {
      activePickerCallback({ success: false, cancelled: true });
      activePickerCallback = null;
    }
    removePickerListeners();
    sendResponse({ success: true, stopped: true });
    return true;
  }

  return false;
});

let activePickerCallback = null;
let activePickerMode = 'field';
let activePickerCardSelector = '';

function removePickerListeners() {
  document.removeEventListener('mousemove', onPickerMouseMove, true);
  document.removeEventListener('click', onPickerClick, true);
  document.removeEventListener('keydown', onPickerKeyDown, true);
  const highlighted = document.querySelectorAll('.pirates-alert-highlight');
  for (const el of highlighted) {
    el.classList.remove('pirates-alert-highlight');
  }
}

function onPickerMouseMove(e) {
  const target = e.target;
  if (!target || target === document.body || target === document.documentElement) return;
  const prev = document.querySelector('.pirates-alert-highlight');
  if (prev && prev !== target) {
    prev.classList.remove('pirates-alert-highlight');
  }
  target.classList.add('pirates-alert-highlight');
}

function deriveContainerSelector(targetEl) {
  if (!targetEl || targetEl === document.body || targetEl === document.documentElement) return '';

  let cur = targetEl;
  let depth = 0;

  while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
    for (const attr of ['data-test', 'data-testid', 'data-component-type', 'data-item-id', 'data-card-id', 'data-qa']) {
      const val = cur.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${val}"]`;
        try {
          const matched = document.querySelectorAll(sel);
          if (matched.length >= 2 && matched.length <= 150) return sel;
        } catch {}
      }
    }

    if (cur.className && typeof cur.className === 'string') {
      const classes = cur.className.split(/\s+/).filter((c) => c && !c.startsWith('pirates-alert-'));
      for (const cls of classes) {
        if (/header|footer|navbar|nav|search|sidebar|filter|toolbar|wrapper|overlay|modal/i.test(cls)) continue;
        const sel = `.${cls}`;
        try {
          const matched = document.querySelectorAll(sel);
          if (matched.length >= 2 && matched.length <= 150) {
            return sel;
          }
        } catch {}
      }
      if (classes.length > 0) {
        const tag = cur.tagName.toLowerCase();
        for (const cls of classes) {
          const sel = `${tag}.${cls}`;
          try {
            const matched = document.querySelectorAll(sel);
            if (matched.length >= 2 && matched.length <= 150) {
              return sel;
            }
          } catch {}
        }
      }
    }

    const tag = cur.tagName.toLowerCase();
    if (tag === 'article' || tag === 'li') {
      try {
        const matched = document.querySelectorAll(tag);
        if (matched.length >= 2 && matched.length <= 150) {
          return tag;
        }
      } catch {}
    }

    cur = cur.parentElement;
    depth++;
  }

  if (targetEl.className && typeof targetEl.className === 'string') {
    const firstCls = targetEl.className.split(/\s+/).filter((c) => c && !c.startsWith('pirates-alert-'))[0];
    if (firstCls) return `.${firstCls}`;
  }

  return targetEl.tagName.toLowerCase();
}

function deriveCardRelativeSelector(targetEl, cardEl) {
  if (!targetEl) return '';
  const scopeEl = cardEl && cardEl.contains(targetEl) ? cardEl : document;
  const tag = targetEl.tagName.toLowerCase();

  if (targetEl.className && typeof targetEl.className === 'string') {
    const classes = targetEl.className.split(/\s+/).filter((c) => c && !c.startsWith('pirates-alert-'));
    for (const cls of classes) {
      const testSel = `.${cls}`;
      try {
        if (scopeEl.querySelectorAll(testSel).length === 1) {
          return testSel;
        }
      } catch {}
    }
    if (classes.length > 0) {
      const combined = `${tag}.${classes.slice(0, 2).join('.')}`;
      try {
        if (scopeEl.querySelectorAll(combined).length === 1) {
          return combined;
        }
      } catch {}
    }
  }

  for (const attr of ['data-test', 'data-component-type', 'itemprop', 'data-price-type', 'aria-label']) {
    const val = targetEl.getAttribute(attr);
    if (val) {
      const sel = `[${attr}="${val}"]`;
      try {
        if (scopeEl.querySelectorAll(sel).length === 1) {
          return sel;
        }
      } catch {}
    }
  }

  if (targetEl.className && typeof targetEl.className === 'string') {
    const firstCls = targetEl.className.split(/\s+/).filter((c) => c && !c.startsWith('pirates-alert-'))[0];
    if (firstCls) return `.${firstCls}`;
  }

  return tag;
}

function onPickerClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const target = e.target;
  const cb = activePickerCallback;
  const pickerMode = activePickerMode;
  const scopedCardSelector = activePickerCardSelector;
  activePickerCallback = null;
  removePickerListeners();
  if (!cb) return;

  if (pickerMode === 'card') {
    const containerSelector = deriveContainerSelector(target);
    cb({
      success: true,
      selector: containerSelector,
      mode: 'card',
      rawText: normalizeText(target.textContent),
      tagName: target.tagName.toLowerCase()
    });
    return;
  }

  const currentRulePromise = rulesRepository.findMatchingRule(normalizeHostname(window.location.hostname), computeLayoutFingerprint(document));
  currentRulePromise.then((rule) => {
    const cardSelector = scopedCardSelector || rule?.cardSelector;
    let cardEl = null;
    if (cardSelector) {
      try { cardEl = target.closest(cardSelector); } catch {}
    }
    const selector = deriveCardRelativeSelector(target, cardEl);
    cb({
      success: true,
      selector,
      mode: 'field',
      rawText: normalizeText(target.textContent),
      tagName: target.tagName.toLowerCase(),
      isInsideCard: Boolean(cardEl)
    });
  }).catch(() => {
    let cardEl = null;
    if (scopedCardSelector) {
      try { cardEl = target.closest(scopedCardSelector); } catch {}
    }
    const selector = deriveCardRelativeSelector(target, cardEl);
    cb({
      success: true,
      selector,
      mode: 'field',
      rawText: normalizeText(target.textContent),
      tagName: target.tagName.toLowerCase(),
      isInsideCard: Boolean(cardEl)
    });
  });
}

function onPickerKeyDown(e) {
  if (e.key === 'Escape') {
    const cb = activePickerCallback;
    activePickerCallback = null;
    removePickerListeners();
    if (cb) {
      cb({ success: false, cancelled: true });
    }
  }
}

