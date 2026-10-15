import { MESSAGE_TYPES } from '../modules/messaging/protocol.js';

chrome.runtime.onInstalled.addListener(() => {
  console.log('PIRATES ALERT service worker initialized');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.STATUS_UPDATE) {
    sendResponse({
      acknowledged: true,
      timestamp: new Date().toISOString()
    });
    return true;
  }
  return false;
});
