import { MESSAGE_TYPES, EXTRACTION_SOURCE } from '../modules/messaging/protocol.js';
import { extractionEngine } from '../modules/extractor/index.js';
import { rulesRepository, computeLayoutFingerprint, normalizeHostname } from '../modules/rules/index.js';
import { validateRuleAgainstDoc } from '../modules/rules/validator.js';
import { aiLearning, getAiLogs } from '../modules/ai/index.js';
import { preferencesRepository } from '../modules/preferences/index.js';
import { correctionsRepository, deduceFieldSelectorFromCard } from '../modules/corrections/index.js';
import { regressionRepository } from '../modules/regression/index.js';
import { sampleCardSnippetsForAi, hasProductListingEvidence } from '../modules/extractor/cardDetector.js';

let isExtractionBusy = false;
let isLearningBusy = false;

const VALID_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));

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
                  ruleVersion: savedRule.ruleVersion || 1,
                  sampleCards,
                  expectedItems: result.items.slice(0, 3)
                });
              }
            } catch {}
          }
        }

        const hasListing = result.items.length > 0 || (result.diagnostics?.candidateCount > 0) || hasProductListingEvidence(document);
        const isUnambiguous = result.items.length > 0 && (result.diagnostics?.fieldDiagnostics?.title?.fillRate || 0) >= 80;
        const canLearnWithAi = source !== EXTRACTION_SOURCE.SAVED_RULE && hasListing;

        sendResponse({
          success: true,
          ...result,
          source,
          appliedRuleId,
          layoutFingerprint,
          effectivePreferences,
          hasListingEvidence: hasListing,
          canLearnWithAi,
          isUnambiguous
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

  return false;
});
