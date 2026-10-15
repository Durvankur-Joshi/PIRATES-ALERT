import { MESSAGE_TYPES } from './protocol.js';

export function isExtensionEnvironment() {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.tabs);
}

export async function getActiveTab() {
  if (!isExtensionEnvironment()) {
    return null;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

export function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    if (!isExtensionEnvironment() || !tabId) {
      resolve({ success: false, error: 'Extension environment or tab unavailable' });
      return;
    }
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }
      resolve({
        success: true,
        data: response
      });
    });
  });
}

export function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    if (!isExtensionEnvironment()) {
      resolve({ success: false, error: 'Extension environment unavailable' });
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }
      resolve({
        success: true,
        data: response
      });
    });
  });
}

export { MESSAGE_TYPES };
