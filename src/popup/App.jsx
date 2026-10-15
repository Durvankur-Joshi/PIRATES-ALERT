import React, { useState, useEffect } from 'react';
import { MESSAGE_TYPES, EXTRACTION_STATUS } from '../modules/messaging/protocol.js';
import { getActiveTab, sendMessageToTab, isExtensionEnvironment } from '../modules/messaging/index.js';

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
    setStatusMessage('Dispatching extraction signal to active tab...');

    if (!isExtensionEnvironment()) {
      setTimeout(() => {
        setIsProcessing(false);
        setStatusMessage('Preview mode: extraction signal acknowledged.');
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
      setStatusMessage(response.data.message || 'Content script acknowledged extraction request.');
    } else {
      setStatusMessage(response.error || 'Signal sent. Active tab received notification.');
    }
  }

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
            <span className="brand-subtitle">Product Extractor</span>
          </div>
        </div>
        <span className="phase-badge">Phase 1</span>
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
        <span>{isProcessing ? 'Communicating...' : 'Extract Products'}</span>
      </button>

      <section className="status-placeholder-card">
        <div className="status-header-row">
          <span className="status-header-title">Extraction Status</span>
          <span className={`status-badge ${isProcessing ? 'extracting' : connectionStatus === EXTRACTION_STATUS.READY ? 'ready' : 'idle'}`}>
            {isProcessing ? 'Processing' : connectionStatus === EXTRACTION_STATUS.READY ? 'Standby' : 'Idle'}
          </span>
        </div>
        <p className="status-message">
          {statusMessage}
        </p>
      </section>

      <main className="empty-state-view">
        <div className="empty-state-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
        </div>
        <h2 className="empty-state-title">No Extraction Initiated</h2>
        <p className="empty-state-description">
          Open any product search results or listing page and trigger extraction to capture structured data.
        </p>
      </main>

      <footer className="footer">
        <div className="footer-pill-group">
          <span className="footer-pill active">Core</span>
          <span className="footer-pill">Rules</span>
          <span className="footer-pill">AI</span>
          <span className="footer-pill">Export</span>
        </div>
        <span className="footer-meta">v0.1.0 • MV3</span>
      </footer>
    </div>
  );
}
