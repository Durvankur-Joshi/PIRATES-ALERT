import { MESSAGE_TYPES } from '../modules/messaging/protocol.js';
import { extractionEngine } from '../modules/extractor/index.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === MESSAGE_TYPES.GET_PAGE_INFO) {
    sendResponse({
      url: window.location.href,
      title: document.title,
      hostname: window.location.hostname,
      status: 'READY'
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.EXTRACT_PRODUCTS) {
    extractionEngine
      .execute({
        document,
        url: window.location.href,
        title: document.title,
        rules: message.rules || {}
      })
      .then((result) => {
        sendResponse({
          success: true,
          ...result
        });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          status: 'ERROR',
          message: err?.message || 'Extraction execution failed',
          items: [],
          diagnostics: {
            candidateCount: 0,
            acceptedCount: 0,
            rejectedCount: 0,
            discoveryMethod: 'none',
            fieldDiagnostics: {}
          },
          metadata: {
            url: window.location.href,
            title: document.title,
            totalExtracted: 0,
            timestamp: new Date().toISOString()
          }
        });
      });
    return true;
  }

  return false;
});
