import React, { useState, useEffect } from 'react';
import { MESSAGE_TYPES, EXTRACTION_STATUS } from '../modules/messaging/protocol.js';
import { getActiveTab, sendMessageToTab, isExtensionEnvironment } from '../modules/messaging/index.js';
import { formatExtractionPayload, triggerJsonDownload } from '../modules/export/index.js';

export default function App() {
  const [pageInfo, setPageInfo] = useState({
    url: 'Loading current tab...',
    title: 'Detecting page title...',
    hostname: ''
  });
  const [connectionStatus, setConnectionStatus] = useState(EXTRACTION_STATUS.CONNECTING);
  const [statusMessage, setStatusMessage] = useState('Querying active tab and content script...');
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTabId, setActiveTabId] = useState(null);
  const [extractionResult, setExtractionResult] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  useEffect(() => {
    async function initPageConnection() {
      if (!isExtensionEnvironment()) {
        setPageInfo({
          url: window.location.href,
          title: 'Development Preview',
          hostname: window.location.hostname
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
            hostname: ''
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
            hostname: 'internal'
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
            hostname: response.data.hostname || ''
          });
          setConnectionStatus(EXTRACTION_STATUS.READY);
          setStatusMessage('Content script connected. Ready for extraction.');
        } else {
          setPageInfo({
            url: tab.url || 'Restricted Page',
            title: tab.title || 'Tab Detected',
            hostname: ''
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
    setStatusMessage('Scanning DOM and running generic extraction pipeline...');

    if (!isExtensionEnvironment()) {
      setTimeout(() => {
        setIsProcessing(false);
        setExtractionResult({
          status: 'EMPTY',
          message: 'Preview mode: No product listing detected in standalone popup window.',
          items: [],
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
      setStatusMessage(data.message || `Extracted ${data.items?.length || 0} products.`);
    } else {
      setConnectionStatus(EXTRACTION_STATUS.ERROR);
      setStatusMessage(response.error || 'Extraction failed or content script unreachable.');
    }
  }

  function handleDownloadJson() {
    if (!extractionResult || !extractionResult.items || extractionResult.items.length === 0) {
      return;
    }
    const payload = formatExtractionPayload(
      extractionResult.metadata || { url: pageInfo.url, title: pageInfo.title },
      extractionResult.items
    );
    payload.diagnostics = extractionResult.diagnostics;

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
            <span className="brand-subtitle">Generic Extractor</span>
          </div>
        </div>
        <span className="phase-badge">Phase 2</span>
      </header>

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
      </section>

      <div className="button-row">
        <button
          id="btn-extract-products"
          className="btn-extract"
          onClick={handleExtractClick}
          disabled={isProcessing || connectionStatus === EXTRACTION_STATUS.UNAVAILABLE}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <span>{isProcessing ? 'Extracting...' : items.length > 0 ? 'Re-extract Products' : 'Extract Products'}</span>
        </button>

        {items.length > 0 && (
          <button
            id="btn-download-json"
            className={`btn-download ${downloadSuccess ? 'downloaded' : ''}`}
            onClick={handleDownloadJson}
            title="Download extracted products as JSON"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{downloadSuccess ? 'Downloaded!' : 'Export JSON'}</span>
          </button>
        )}
      </div>

      <section className="status-placeholder-card">
        <div className="status-header-row">
          <span className="status-header-title">Status & Diagnostics</span>
          <span className={`status-badge ${isProcessing ? 'extracting' : items.length > 0 ? 'ready' : 'idle'}`}>
            {isProcessing ? 'Processing' : items.length > 0 ? `${items.length} Extracted` : 'Standby'}
          </span>
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
                <div className="product-thumb-container">
                  {prod.image_url ? (
                    <img src={prod.image_url} alt="" className="product-thumb" />
                  ) : (
                    <div className="product-thumb-fallback">No Img</div>
                  )}
                </div>
                <div className="product-info-block">
                  <div className="product-title-row" title={prod.title}>
                    {prod.product_url ? (
                      <a href={prod.product_url} target="_blank" rel="noreferrer" className="product-title-link">
                        {prod.title}
                      </a>
                    ) : (
                      <span className="product-title-text">{prod.title}</span>
                    )}
                  </div>
                  <div className="product-price-row">
                    {prod.selling_price !== null && (
                      <span className="price-selling">
                        {prod.currency || ''} {prod.selling_price}
                      </span>
                    )}
                    {prod.mrp !== null && (
                      <span className="price-mrp">
                        {prod.currency || ''} {prod.mrp}
                      </span>
                    )}
                    {prod.rating !== null && (
                      <span className="rating-badge">
                        ★ {prod.rating}
                        {prod.rating_count !== null && <span className="rating-count">({prod.rating_count})</span>}
                        {prod.review_count !== null && <span className="review-count">[{prod.review_count} rev]</span>}
                      </span>
                    )}
                  </div>
                  <div className="product-meta-row">
                    {prod.product_id && (
                      <span className="product-id-tag">ID: {prod.product_id}</span>
                    )}
                    {prod.extra?.badge && (
                      <span className="product-extra-tag">{prod.extra.badge}</span>
                    )}
                    {prod.extra?.discount && (
                      <span className="product-discount-tag">{prod.extra.discount}</span>
                    )}
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
              ? 'No repeating product cards met criteria on this page. Navigate to an active product listing or search results page.'
              : 'Open any product search results or category listing page and click "Extract Products" to capture structured data.'}
          </p>
        </main>
      )}

      <footer className="footer">
        <div className="footer-pill-group">
          <span className="footer-pill active">Core</span>
          <span className="footer-pill active">Extractor</span>
          <span className="footer-pill">Rules</span>
          <span className="footer-pill active">Export</span>
        </div>
        <span className="footer-meta">v0.2.0 • Phase 2</span>
      </footer>
    </div>
  );
}
