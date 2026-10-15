import { MESSAGE_TYPES } from '../modules/messaging/protocol.js';

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
    sendResponse({
      status: 'READY',
      targetUrl: window.location.href,
      message: 'Extraction engine acknowledged request.'
    });
    return true;
  }

  return false;
});
