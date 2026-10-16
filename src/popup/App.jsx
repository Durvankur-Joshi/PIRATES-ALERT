import React, { useState, useEffect } from 'react';
import { MESSAGE_TYPES, EXTRACTION_STATUS, EXTRACTION_SOURCE } from '../modules/messaging/protocol.js';
import { getActiveTab, sendMessageToTab, isExtensionEnvironment } from '../modules/messaging/index.js';
import { formatExtractionPayload, triggerJsonDownload } from '../modules/export/index.js';
import { ALL_CANONICAL_FIELDS, getDefaultFieldPreferences } from '../modules/preferences/index.js';

export default function App() {
  const [pageInfo, setPageInfo] = useState({
    url: 'Loading current tab...',
    title: 'Detecting page title...',
    hostname: '',
    layoutFingerprint: '',
    hasSavedRule: false,
    savedRuleId: null,
    activeVersionId: null
  });
  const [connectionStatus, setConnectionStatus] = useState(EXTRACTION_STATUS.CONNECTING);
  const [statusMessage, setStatusMessage] = useState('Querying active tab and content script...');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLearning, setIsLearning] = useState(false);
  const [activeTabId, setActiveTabId] = useState(null);
  const [extractionResult, setExtractionResult] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [activeView, setActiveView] = useState('main');
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  const [aiProposal, setAiProposal] = useState(null);
  const [learningError, setLearningError] = useState(null);

  const [savedRules, setSavedRules] = useState([]);
  const [aiLogs, setAiLogs] = useState([]);

  const [effectivePreferences, setEffectivePreferences] = useState(getDefaultFieldPreferences());
  const [allPreferences, setAllPreferences] = useState({ global: getDefaultFieldPreferences(), sites: {} });
  const [prefScope, setPrefScope] = useState('global');

  const [editingCard, setEditingCard] = useState(null);
  const [correctionForm, setCorrectionForm] = useState({});
  const [correctionError, setCorrectionError] = useState(null);

  const [expandedRuleId, setExpandedRuleId] = useState(null);
  const [ruleHistories, setRuleHistories] = useState({});

  useEffect(() => {
    async function initPageConnection() {
      if (!isExtensionEnvironment()) {
        setPageInfo({
          url: window.location.href,
          title: 'Development Preview',
          hostname: window.location.hostname,
          layoutFingerprint: 'layout_preview',
          hasSavedRule: false,
          savedRuleId: null,
          activeVersionId: null
        });
        setConnectionStatus(EXTRACTION_STATUS.READY);
        setStatusMessage('Running in browser preview mode');
        return;
      }

      try {
        const tab = await getActiveTab();
        if (!tab || !tab.id) {
          setPageInfo({
            url: 'Unavailable',
            title: 'No active tab detected',
            hostname: '',
            layoutFingerprint: '',
            hasSavedRule: false,
            savedRuleId: null,
            activeVersionId: null
          });
          setConnectionStatus(EXTRACTION_STATUS.UNAVAILABLE);
          setStatusMessage('Could not detect an active browser tab.');
          return;
        }

        setActiveTabId(tab.id);

        if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
          setPageInfo({
            url: tab.url,
            title: tab.title || 'System Tab',
            hostname: 'internal',
            layoutFingerprint: '',
            hasSavedRule: false,
            savedRuleId: null,
            activeVersionId: null
          });
          setConnectionStatus(EXTRACTION_STATUS.UNAVAILABLE);
          setStatusMessage('Browser system pages cannot be extracted.');
          return;
        }

        const response = await sendMessageToTab(tab.id, {
          type: MESSAGE_TYPES.GET_PAGE_INFO
        });

        if (response.success && response.data) {
          setPageInfo({
            url: response.data.url || tab.url || '',
            title: response.data.title || tab.title || '',
            hostname: response.data.hostname || '',
            layoutFingerprint: response.data.layoutFingerprint || '',
            hasSavedRule: Boolean(response.data.hasSavedRule),
            savedRuleId: response.data.savedRuleId || null,
            activeVersionId: response.data.activeVersionId || null
          });
          if (response.data.effectivePreferences) {
            setEffectivePreferences(response.data.effectivePreferences);
          }
          setConnectionStatus(EXTRACTION_STATUS.READY);
          setStatusMessage(
            response.data.hasSavedRule
              ? 'Saved rule detected for this layout. Zero-AI extraction ready.'
              : 'Content script connected. Ready for extraction.'
          );
        } else {
          setPageInfo({
            url: tab.url || 'Restricted Page',
            title: tab.title || 'Tab Detected',
            hostname: '',
            layoutFingerprint: '',
            hasSavedRule: false,
            savedRuleId: null,
            activeVersionId: null
          });
          setConnectionStatus(EXTRACTION_STATUS.READY);
          setStatusMessage('Active tab detected via activeTab permission.');
        }
      } catch (err) {
        setConnectionStatus(EXTRACTION_STATUS.ERROR);
        setStatusMessage(err?.message || 'Failed to initialize active tab connection.');
      }
    }

    initPageConnection();
  }, []);

  async function handleExtractClick() {
    if (isProcessing) return;
    setIsProcessing(true);
    setStatusMessage('Scanning DOM and running extraction pipeline...');

    if (!isExtensionEnvironment()) {
      setTimeout(() => {
        setIsProcessing(false);
        setExtractionResult({
          status: 'EMPTY',
          source: EXTRACTION_SOURCE.HEURISTIC,
          message: 'Preview mode: No product listing detected in standalone popup window.',
          items: [],
          canLearnWithAi: true,
          diagnostics: {
            candidateCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            discoveryMethod: 'heuristic',
            fieldDiagnostics: {}
          },
          metadata: {
            url: window.location.href,
            title: document.title,
            timestamp: new Date().toISOString()
          }
        });
        setStatusMessage('Preview mode: 0 products found.');
      }, 500);
      return;
    }

    if (!activeTabId) {
      setIsProcessing(false);
      setStatusMessage('No active tab ID available to extract.');
      return;
    }

    const response = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.EXTRACT_PRODUCTS
    });

    setIsProcessing(false);

    if (response.success && response.data) {
      const data = response.data;
      setExtractionResult(data);
      if (data.effectivePreferences) {
        setEffectivePreferences(data.effectivePreferences);
      }
      if (data.source === EXTRACTION_SOURCE.SAVED_RULE) {
        setStatusMessage(`Reused saved rule (0 AI calls): Extracted ${data.items?.length || 0} products.`);
      } else {
        setStatusMessage(data.message || `Extracted ${data.items?.length || 0} products.`);
      }
    } else {
      setConnectionStatus(EXTRACTION_STATUS.ERROR);
      setStatusMessage(response.error || 'Extraction failed or content script unreachable.');
    }
  }

  async function handleStartAiLearning() {
    if (isLearning || !activeTabId) return;
    setIsLearning(true);
    setLearningError(null);
    setAiProposal(null);
    setStatusMessage('Sampling candidate DOM cards and requesting AI layout proposal...');

    const response = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.AI_LEARN_LAYOUT,
      diagnostics: extractionResult?.diagnostics || {}
    });

    setIsLearning(false);

    if (response.success && response.data?.success) {
      setAiProposal(response.data);
      setStatusMessage('AI proposed layout rules. Review validation preview below.');
    } else {
      const errMsg = response.data?.error || response.error || 'AI learning failed. Is the AI proxy server running?';
      setLearningError(errMsg);
      setStatusMessage(errMsg);
    }
  }

  async function handleApplyAndSaveRule() {
    if (!aiProposal || !aiProposal.proposedRule || !activeTabId) return;
    setIsProcessing(true);
    setStatusMessage('Saving validated rule and executing extraction...');

    const saveResponse = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.SAVE_RULE,
      rule: {
        ...aiProposal.proposedRule,
        testResults: aiProposal.validation || {}
      }
    });

    if (saveResponse.success && saveResponse.data?.success) {
      setPageInfo((prev) => ({
        ...prev,
        hasSavedRule: true,
        savedRuleId: saveResponse.data.rule?.id || null,
        activeVersionId: saveResponse.data.rule?.activeVersionId || null
      }));
      setAiProposal(null);
      await handleExtractClick();
    } else {
      setIsProcessing(false);
      setStatusMessage(saveResponse.data?.error || 'Failed to save rule.');
    }
  }

  async function loadSavedRules() {
    if (!activeTabId) return;
    const res = await sendMessageToTab(activeTabId, { type: MESSAGE_TYPES.GET_RULES });
    if (res.success && res.data?.rules) {
      setSavedRules(res.data.rules);
    }
  }

  async function handleDeleteRule(ruleId) {
    if (!activeTabId) return;
    const res = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.DELETE_RULE,
      ruleId
    });
    if (res.success && res.data?.success) {
      setSavedRules((prev) => prev.filter((r) => r.id !== ruleId));
      if (pageInfo.savedRuleId === ruleId) {
        setPageInfo((prev) => ({ ...prev, hasSavedRule: false, savedRuleId: null, activeVersionId: null }));
      }
    }
  }

  async function toggleRuleHistory(ruleId) {
    if (expandedRuleId === ruleId) {
      setExpandedRuleId(null);
      return;
    }
    setExpandedRuleId(ruleId);
    if (!activeTabId) return;
    const res = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.GET_RULE_HISTORY,
      ruleId
    });
    if (res.success && res.data?.versions) {
      setRuleHistories((prev) => ({ ...prev, [ruleId]: res.data.versions }));
    }
  }

  async function handleRollback(ruleId, targetVersionId) {
    if (!activeTabId) return;
    setStatusMessage(`Rolling back rule to ${targetVersionId}...`);
    const res = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.ROLLBACK_RULE,
      ruleId,
      targetVersionId
    });
    if (res.success && res.data?.success) {
      setStatusMessage(`Successfully rolled back to ${targetVersionId}. New active version: ${res.data.activeVersion?.versionId}`);
      await loadSavedRules();
      const histRes = await sendMessageToTab(activeTabId, {
        type: MESSAGE_TYPES.GET_RULE_HISTORY,
        ruleId
      });
      if (histRes.success && histRes.data?.versions) {
        setRuleHistories((prev) => ({ ...prev, [ruleId]: histRes.data.versions }));
      }
      setPageInfo((prev) => ({
        ...prev,
        activeVersionId: res.data.activeVersion?.versionId || prev.activeVersionId
      }));
    } else {
      setStatusMessage(res.data?.error || 'Rollback failed.');
    }
  }

  async function loadAiLogs() {
    if (!activeTabId) return;
    const res = await sendMessageToTab(activeTabId, { type: MESSAGE_TYPES.GET_AI_LOGS });
    if (res.success && res.data?.logs) {
      setAiLogs(res.data.logs);
    }
  }

  async function loadPreferences() {
    if (!activeTabId) return;
    const res = await sendMessageToTab(activeTabId, { type: MESSAGE_TYPES.GET_PREFERENCES });
    if (res.success && res.data?.preferences) {
      setAllPreferences(res.data.preferences);
      if (res.data.effectivePreferences) {
        setEffectivePreferences(res.data.effectivePreferences);
      }
    }
  }

  async function handleSavePreferences(scope, fieldValues) {
    if (!activeTabId) return;
    const isSite = scope === 'site';
    const res = await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.SAVE_PREFERENCES,
      isSite,
      preferences: fieldValues
    });
    if (res.success) {
      await loadPreferences();
      setStatusMessage(`Saved ${isSite ? 'site' : 'global'} field preferences.`);
    }
  }

  function openCorrectionModal(cardIndex, item) {
    setEditingCard({ cardIndex, item });
    setCorrectionError(null);
    setCorrectionForm({
      title: item.title ?? '',
      selling_price: item.selling_price ?? '',
      mrp: item.mrp ?? '',
      currency: item.currency ?? '',
      product_url: item.product_url ?? '',
      image_url: item.image_url ?? '',
      rating: item.rating ?? '',
      rating_count: item.rating_count ?? '',
      review_count: item.review_count ?? '',
      product_id: item.product_id ?? ''
    });
  }

  async function handleSaveCorrection() {
    if (!editingCard || !activeTabId) return;
    setCorrectionError(null);

    let anyUpdated = false;
    const updatedItem = { ...editingCard.item };

    for (const [field, rawVal] of Object.entries(correctionForm)) {
      const origVal = editingCard.item[field];
      if (String(rawVal).trim() !== String(origVal ?? '').trim()) {
        const res = await sendMessageToTab(activeTabId, {
          type: MESSAGE_TYPES.SAVE_CORRECTION,
          cardIndex: editingCard.cardIndex,
          productId: editingCard.item.product_id,
          ruleId: extractionResult?.appliedRuleId,
          field,
          originalValue: origVal,
          correctedValue: rawVal
        });

        if (res.success && res.data?.success) {
          anyUpdated = true;
          updatedItem[field] = res.data.correction.correctedValue;
          if (res.data.ruleUpdated && res.data.updatedRule) {
            setStatusMessage(`Rule refined and saved as version ${res.data.updatedRule.activeVersionId}!`);
            setPageInfo((prev) => ({
              ...prev,
              activeVersionId: res.data.updatedRule.activeVersionId
            }));
          }
        } else {
          setCorrectionError(res.data?.error || `Failed to save correction for ${field}`);
          return;
        }
      }
    }

    if (anyUpdated && extractionResult?.items) {
      const newItems = [...extractionResult.items];
      newItems[editingCard.cardIndex] = updatedItem;
      setExtractionResult((prev) => ({ ...prev, items: newItems }));
      setStatusMessage('Correction saved successfully.');
    }

    setEditingCard(null);
  }

  function handleDownloadJson() {
    if (!extractionResult || !extractionResult.items || extractionResult.items.length === 0) {
      return;
    }
    const payload = formatExtractionPayload(
      extractionResult.metadata || { url: pageInfo.url, title: pageInfo.title },
      extractionResult.items,
      effectivePreferences
    );
    payload.diagnostics = extractionResult.diagnostics;
    payload.extractionSource = extractionResult.source || EXTRACTION_SOURCE.HEURISTIC;
    payload.ruleId = extractionResult.appliedRuleId || null;

    const hostname = pageInfo.hostname ? pageInfo.hostname.replace(/[^a-z0-9]/gi, '_') : 'products';
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `pirates_alert_${hostname}_${timestamp}.json`;

    const ok = triggerJsonDownload(payload, filename);
    if (ok) {
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 2500);
    }
  }

  const items = extractionResult?.items || [];
  const diagnostics = extractionResult?.diagnostics;
  const fieldDiagnostics = diagnostics?.fieldDiagnostics || {};

  return (
    <div className="popup-container">
      <header className="header">
        <div className="brand">
          <div className="brand-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </div>
          <div className="brand-title-group">
            <h1 className="brand-title">PIRATES ALERT</h1>
            <span className="brand-subtitle">AI-Assisted Extractor</span>
          </div>
        </div>
        <div className="header-nav">
          <button
            className={`nav-tab-btn ${activeView === 'main' ? 'active' : ''}`}
            onClick={() => setActiveView('main')}
          >
            Extract
          </button>
          <button
            className={`nav-tab-btn ${activeView === 'rules' ? 'active' : ''}`}
            onClick={() => {
              setActiveView('rules');
              loadSavedRules();
            }}
          >
            Rules
          </button>
          <button
            className={`nav-tab-btn ${activeView === 'ai_logs' ? 'active' : ''}`}
            onClick={() => {
              setActiveView('ai_logs');
              loadAiLogs();
            }}
          >
            AI Logs
          </button>
          <button
            className={`nav-tab-btn ${activeView === 'preferences' ? 'active' : ''}`}
            onClick={() => {
              setActiveView('preferences');
              loadPreferences();
            }}
          >
            Prefs
          </button>
        </div>
      </header>

      {activeView === 'main' && (
        <>
          <section className="card">
            <div className="card-label-group">
              <span className="card-label">Active Target</span>
              <div className="status-indicator">
                <span className={`status-dot ${connectionStatus === EXTRACTION_STATUS.READY ? 'ready' : connectionStatus === EXTRACTION_STATUS.CONNECTING ? 'connecting' : 'unavailable'}`}></span>
                <span>{connectionStatus === EXTRACTION_STATUS.READY ? 'Ready' : connectionStatus === EXTRACTION_STATUS.CONNECTING ? 'Connecting' : 'Offline'}</span>
              </div>
            </div>
            <div className="url-title" title={pageInfo.title}>
              {pageInfo.title}
            </div>
            <div className="url-container">
              <span className="url-text" title={pageInfo.url}>
                {pageInfo.url}
              </span>
            </div>
            {pageInfo.hasSavedRule && (
              <div className="rule-badge-indicator">
                <span className="badge-dot"></span>
                <span>
                  Saved Rule Active: <strong>{pageInfo.savedRuleId}</strong> ({pageInfo.activeVersionId || 'v1'}) (0 AI calls)
                </span>
              </div>
            )}
          </section>

          <div className="button-row">
            <button
              id="btn-extract-products"
              className="btn-extract"
              onClick={handleExtractClick}
              disabled={isProcessing || isLearning || connectionStatus === EXTRACTION_STATUS.UNAVAILABLE}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <span>{isProcessing ? 'Extracting...' : items.length > 0 ? 'Re-extract' : 'Extract Products'}</span>
            </button>

            {extractionResult?.canLearnWithAi && (
              <button
                id="btn-ai-learn"
                className="btn-ai-learn"
                onClick={handleStartAiLearning}
                disabled={isLearning || isProcessing}
                title="Use AI to discover selectors for this layout"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                <span>{isLearning ? 'Learning...' : 'Learn with AI'}</span>
              </button>
            )}

            {items.length > 0 && (
              <button
                id="btn-download-json"
                className={`btn-download ${downloadSuccess ? 'downloaded' : ''}`}
                onClick={handleDownloadJson}
                title="Download extracted products as JSON (with field preferences applied)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>{downloadSuccess ? 'Saved!' : 'JSON'}</span>
              </button>
            )}
          </div>

          <section className="status-placeholder-card">
            <div className="status-header-row">
              <span className="status-header-title">Status & Engine</span>
              {extractionResult?.source && (
                <span className={`source-pill ${extractionResult.source}`}>
                  {extractionResult.source === EXTRACTION_SOURCE.SAVED_RULE && 'Rule (0 AI calls)'}
                  {extractionResult.source === EXTRACTION_SOURCE.HEURISTIC && 'Heuristics (0 AI calls)'}
                  {extractionResult.source === EXTRACTION_SOURCE.AI_LEARNED && 'AI Learned'}
                </span>
              )}
            </div>
            <p className="status-message">
              {statusMessage}
            </p>
            {diagnostics && (
              <div className="metrics-bar">
                <span className="metric-item">Candidates: <strong>{diagnostics.candidateCount}</strong></span>
                <span className="metric-item">Accepted: <strong>{diagnostics.acceptedCount}</strong></span>
                <span className="metric-item">Rejected: <strong>{diagnostics.rejectedCount}</strong></span>
                <button
                  className="btn-toggle-diagnostics"
                  onClick={() => setShowDiagnostics(!showDiagnostics)}
                >
                  {showDiagnostics ? 'Hide Fields' : 'View Fields'}
                </button>
              </div>
            )}
          </section>

          {aiProposal && (
            <section className="proposal-card">
              <div className="proposal-header">
                <span className="proposal-title">AI Layout Rule Proposal</span>
                <span className={`validation-badge ${aiProposal.validation?.valid ? 'valid' : 'invalid'}`}>
                  {aiProposal.validation?.valid ? 'Validated' : 'Unreliable'}
                </span>
              </div>
              <div className="proposal-content">
                <div className="proposal-field">
                  <span className="field-lbl">Card Selector:</span>
                  <code>{aiProposal.proposedRule?.cardSelector}</code>
                </div>
                <div className="proposal-field">
                  <span className="field-lbl">Title:</span>
                  <code>{aiProposal.proposedRule?.fieldSelectors?.titleSelector || 'auto'}</code>
                </div>
                <div className="proposal-field">
                  <span className="field-lbl">Price:</span>
                  <code>{aiProposal.proposedRule?.fieldSelectors?.priceSelector || 'auto'}</code>
                </div>
                <div className="proposal-stats">
                  <span>Matched: <strong>{aiProposal.validation?.candidateCount || 0}</strong> cards</span>
                  <span>Match Rate: <strong>{aiProposal.validation?.matchRate || 0}%</strong></span>
                </div>
              </div>
              <div className="proposal-actions">
                <button
                  className="btn-apply-rule"
                  onClick={handleApplyAndSaveRule}
                  disabled={!aiProposal.validation?.valid}
                >
                  Save & Apply Rule
                </button>
                <button
                  className="btn-cancel-rule"
                  onClick={() => setAiProposal(null)}
                >
                  Dismiss
                </button>
              </div>
            </section>
          )}

          {learningError && (
            <div className="error-banner">
              <span>{learningError}</span>
            </div>
          )}

          {showDiagnostics && diagnostics && (
            <section className="diagnostics-details-card">
              <div className="diagnostics-grid">
                {Object.entries(fieldDiagnostics).map(([field, diag]) => (
                  <div key={field} className="diag-field-row">
                    <span className="diag-field-name">{field}</span>
                    <span className={`diag-field-status ${diag.status.toLowerCase()}`}>
                      {diag.present}/{items.length} ({diag.fillRate}%)
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {items.length > 0 ? (
            <section className="results-container">
              <div className="results-header">
                <span className="results-title">Extracted Products ({items.length})</span>
                <span className="discovery-pill">{diagnostics?.discoveryMethod || 'heuristic'}</span>
              </div>
              <div className="product-list">
                {items.map((prod, index) => (
                  <div key={prod.product_id || prod.product_url || index} className="product-card-item">
                    {effectivePreferences.image_url !== false && (
                      <div className="product-thumb-container">
                        {prod.image_url ? (
                          <img src={prod.image_url} alt="" className="product-thumb" />
                        ) : (
                          <div className="product-thumb-fallback">No Img</div>
                        )}
                      </div>
                    )}
                    <div className="product-info-block">
                      {effectivePreferences.title !== false && (
                        <div className="product-title-row" title={prod.title}>
                          {effectivePreferences.product_url !== false && prod.product_url ? (
                            <a href={prod.product_url} target="_blank" rel="noreferrer" className="product-title-link">
                              {prod.title}
                            </a>
                          ) : (
                            <span className="product-title-text">{prod.title}</span>
                          )}
                        </div>
                      )}
                      <div className="product-price-row">
                        {effectivePreferences.selling_price !== false && prod.selling_price !== null && (
                          <span className="price-selling">
                            {effectivePreferences.currency !== false ? prod.currency || '' : ''} {prod.selling_price}
                          </span>
                        )}
                        {effectivePreferences.mrp !== false && prod.mrp !== null && (
                          <span className="price-mrp">
                            {effectivePreferences.currency !== false ? prod.currency || '' : ''} {prod.mrp}
                          </span>
                        )}
                        {effectivePreferences.rating !== false && prod.rating !== null && (
                          <span className="rating-badge">
                            ★ {prod.rating}
                            {effectivePreferences.rating_count !== false && prod.rating_count !== null && (
                              <span className="rating-count">({prod.rating_count})</span>
                            )}
                            {effectivePreferences.review_count !== false && prod.review_count !== null && (
                              <span className="review-count">[{prod.review_count} rev]</span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="product-meta-row">
                        {effectivePreferences.product_id !== false && prod.product_id && (
                          <span className="product-id-tag">ID: {prod.product_id}</span>
                        )}
                        {effectivePreferences.extra !== false && prod.extra?.badge && (
                          <span className="product-extra-tag">{prod.extra.badge}</span>
                        )}
                        {effectivePreferences.extra !== false && prod.extra?.discount && (
                          <span className="product-discount-tag">{prod.extra.discount}</span>
                        )}
                        <button
                          className="btn-correct-product"
                          onClick={() => openCorrectionModal(index, prod)}
                          title="Correct field values on this card"
                        >
                          Correct
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <main className="empty-state-view">
              <div className="empty-state-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
              </div>
              <h2 className="empty-state-title">
                {extractionResult ? 'No Products Identified' : 'No Extraction Initiated'}
              </h2>
              <p className="empty-state-description">
                {extractionResult
                  ? 'DOM heuristics could not confidently isolate product cards on this page. Click "Learn with AI" above to deduce extraction rules.'
                  : 'Open any product search results or category listing page and click "Extract Products" to capture structured data.'}
              </p>
            </main>
          )}
        </>
      )}

      {activeView === 'rules' && (
        <section className="tab-view-container">
          <div className="tab-view-header">
            <span className="tab-view-title">Saved Layout Rules ({savedRules.length})</span>
            <span className="tab-view-hint">Persisted with immutable version history</span>
          </div>
          {savedRules.length === 0 ? (
            <div className="tab-empty-state">
              <span>No saved rules yet. Rules are saved when you validate an AI layout proposal.</span>
            </div>
          ) : (
            <div className="rules-list">
              {savedRules.map((rule) => {
                const isExpanded = expandedRuleId === rule.id;
                const historyList = ruleHistories[rule.id] || rule.versions || [];
                return (
                  <div key={rule.id} className="rule-item-card">
                    <div className="rule-item-header">
                      <span className="rule-host">{rule.hostname}</span>
                      <span className="rule-version-badge">{rule.activeVersionId || 'v1'}</span>
                    </div>
                    <div className="rule-item-header">
                      <span className="rule-fingerprint">{rule.layoutFingerprint}</span>
                      <span className="rule-source-badge">
                        {rule.versions?.find((v) => v.versionId === rule.activeVersionId)?.changeSource || 'active'}
                      </span>
                    </div>
                    <div className="rule-selector-row">
                      <code>{rule.cardSelector}</code>
                    </div>
                    <div className="rule-item-footer">
                      <button
                        className="btn-history-toggle"
                        onClick={() => toggleRuleHistory(rule.id)}
                      >
                        {isExpanded ? 'Hide History' : `History (${rule.versions?.length || 1})`}
                      </button>
                      <button
                        className="btn-delete-rule"
                        onClick={() => handleDeleteRule(rule.id)}
                      >
                        Delete
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="rule-history-drawer">
                        {historyList.map((ver) => {
                          const isCurrentActive = ver.versionId === rule.activeVersionId;
                          return (
                            <div key={ver.versionId} className={`history-item ${isCurrentActive ? 'active-ver' : ''}`}>
                              <div className="history-header">
                                <span className="history-ver-id">
                                  {ver.versionId} {isCurrentActive ? '(Active)' : ''}
                                </span>
                                <span className="history-source">{ver.changeSource}</span>
                              </div>
                              <div style={{ fontSize: '9px', color: '#cbd5e1' }}>
                                <code>{ver.cardSelector}</code>
                              </div>
                              <div style={{ fontSize: '8px', color: 'var(--text-muted)' }}>
                                {ver.changeSummary || new Date(ver.createdAt).toLocaleString()}
                              </div>
                              {!isCurrentActive && (
                                <button
                                  className="btn-rollback"
                                  onClick={() => handleRollback(rule.id, ver.versionId)}
                                  title="Restore and activate this version"
                                >
                                  Rollback to {ver.versionId}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeView === 'ai_logs' && (
        <section className="tab-view-container">
          <div className="tab-view-header">
            <span className="tab-view-title">AI Request Logs ({aiLogs.length})</span>
            <span className="tab-view-hint">Zero AI calls on saved rules</span>
          </div>
          {aiLogs.length === 0 ? (
            <div className="tab-empty-state">
              <span>No AI calls recorded. Deterministic extractions and saved rules make 0 AI calls.</span>
            </div>
          ) : (
            <div className="logs-list">
              {aiLogs.map((log) => (
                <div key={log.id} className="log-item-card">
                  <div className="log-item-header">
                    <span className="log-host">{log.hostname}</span>
                    <span className={`log-status ${log.status.toLowerCase()}`}>{log.status}</span>
                  </div>
                  <div className="log-reason-row">
                    <span>Reason: {log.callReason}</span>
                  </div>
                  <div className="log-tokens-row">
                    <span>In: {log.inputTokens} {log.isEstimated ? '(est)' : ''}</span>
                    <span>Out: {log.outputTokens} {log.isEstimated ? '(est)' : ''}</span>
                    <span className="log-date">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeView === 'preferences' && (
        <section className="tab-view-container prefs-tab-container">
          <div className="tab-view-header">
            <span className="tab-view-title">Field Preferences</span>
            <span className="tab-view-hint">Controls display and JSON export</span>
          </div>

          <div className="prefs-scope-switch">
            <button
              className={`prefs-scope-btn ${prefScope === 'global' ? 'active' : ''}`}
              onClick={() => setPrefScope('global')}
            >
              Global Defaults
            </button>
            <button
              className={`prefs-scope-btn ${prefScope === 'site' ? 'active' : ''}`}
              onClick={() => setPrefScope('site')}
              disabled={!pageInfo.hostname}
            >
              Site: {pageInfo.hostname || 'None'}
            </button>
          </div>

          <div className="prefs-list">
            {ALL_CANONICAL_FIELDS.map((fieldName) => {
              const currentScopePrefs =
                prefScope === 'site'
                  ? allPreferences.sites?.[pageInfo.hostname] || allPreferences.global || getDefaultFieldPreferences()
                  : allPreferences.global || getDefaultFieldPreferences();

              const isChecked = currentScopePrefs[fieldName] !== false;

              return (
                <label key={fieldName} className="pref-row">
                  <span className="pref-name">{fieldName.replace(/_/g, ' ')}</span>
                  <input
                    type="checkbox"
                    className="pref-checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                      const updated = { ...currentScopePrefs, [fieldName]: e.target.checked };
                      if (prefScope === 'site') {
                        setAllPreferences((prev) => ({
                          ...prev,
                          sites: { ...(prev.sites || {}), [pageInfo.hostname]: updated }
                        }));
                      } else {
                        setAllPreferences((prev) => ({ ...prev, global: updated }));
                      }
                      handleSavePreferences(prefScope, updated);
                    }}
                  />
                </label>
              );
            })}
          </div>

          <div className="prefs-actions">
            {prefScope === 'site' && (
              <button
                className="btn-cancel-rule"
                onClick={async () => {
                  if (activeTabId && pageInfo.hostname) {
                    await sendMessageToTab(activeTabId, {
                      type: MESSAGE_TYPES.SAVE_PREFERENCES,
                      isSite: true,
                      preferences: allPreferences.global || getDefaultFieldPreferences()
                    });
                    await loadPreferences();
                    setStatusMessage('Reset site preferences to global defaults.');
                  }
                }}
              >
                Reset to Global
              </button>
            )}
          </div>
        </section>
      )}

      {editingCard && (
        <div className="modal-backdrop">
          <div className="correction-dialog">
            <div className="dialog-header">
              <span className="dialog-title">Correct Product #{editingCard.cardIndex + 1}</span>
              <button className="btn-dialog-close" onClick={() => setEditingCard(null)}>✕</button>
            </div>
            <div className="dialog-body">
              {correctionError && (
                <div className="error-banner">
                  <span>{correctionError}</span>
                </div>
              )}
              {Object.keys(correctionForm).map((field) => (
                <div key={field} className="correction-input-group">
                  <label className="correction-label">{field.replace(/_/g, ' ')}</label>
                  <input
                    type="text"
                    className="correction-input"
                    value={correctionForm[field]}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCorrectionForm((prev) => ({ ...prev, [field]: val }));
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="dialog-footer">
              <button className="btn-dialog-cancel" onClick={() => setEditingCard(null)}>
                Cancel
              </button>
              <button className="btn-dialog-save" onClick={handleSaveCorrection}>
                Save Correction
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        <div className="footer-pill-group">
          <span className="footer-pill active">Core</span>
          <span className="footer-pill active">Rules</span>
          <span className="footer-pill active">AI</span>
          <span className="footer-pill active">Export</span>
          <span className="footer-pill active">P4</span>
        </div>
        <span className="footer-meta">v0.4.0 • Phase 4</span>
      </footer>
    </div>
  );
}
