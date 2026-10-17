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

  if (message?.type === 'PIRATES_ALERT_PROXY_FETCH') {
    (async () => {
      let timeoutId;
      try {
        const controller = new AbortController();
        const timeoutMs = message.timeoutMs || 55000;
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(message.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: message.payloadString,
          signal: controller.signal
        });

        const status = response.status;
        const ok = response.ok;
        const text = await response.text();
        sendResponse({ handled: true, ok, status, text });
      } catch (err) {
        sendResponse({
          handled: true,
          ok: false,
          status: 0,
          error: err.name === 'AbortError' ? 'timeout' : err.message
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    })();
    return true;
  }
  return false;
});
