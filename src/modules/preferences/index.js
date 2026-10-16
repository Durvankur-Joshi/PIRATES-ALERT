const STORAGE_KEY = 'pirates_alert_preferences';

export const ALL_CANONICAL_FIELDS = Object.freeze([
  'title',
  'product_url',
  'product_id',
  'image_url',
  'selling_price',
  'mrp',
  'currency',
  'rating',
  'rating_count',
  'review_count',
  'extra'
]);

export function getDefaultFieldPreferences() {
  const prefs = {};
  for (const f of ALL_CANONICAL_FIELDS) {
    prefs[f] = true;
  }
  return prefs;
}

let inMemoryPreferences = {
  global: getDefaultFieldPreferences(),
  sites: {}
};

function isChromeStorageAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
}

async function readPreferencesStorage() {
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        if (chrome.runtime?.lastError) {
          resolve(inMemoryPreferences);
          return;
        }
        const data = res?.[STORAGE_KEY];
        if (data && typeof data === 'object') {
          resolve({
            global: { ...getDefaultFieldPreferences(), ...(data.global || {}) },
            sites: data.sites || {}
          });
          return;
        }
        resolve(inMemoryPreferences);
      });
    });
  }
  return {
    global: { ...inMemoryPreferences.global },
    sites: { ...inMemoryPreferences.sites }
  };
}

async function writePreferencesStorage(data) {
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
        if (chrome.runtime?.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
  inMemoryPreferences = {
    global: { ...data.global },
    sites: { ...data.sites }
  };
  return true;
}

export function createPreferencesRepository() {
  return {
    async getAllPreferences() {
      return await readPreferencesStorage();
    },

    async getEffectivePreferences(hostname = '') {
      const store = await readPreferencesStorage();
      const defaults = getDefaultFieldPreferences();
      const globalPrefs = { ...defaults, ...(store.global || {}) };
      if (!hostname) {
        return globalPrefs;
      }
      const sitePrefs = store.sites?.[hostname];
      if (sitePrefs && typeof sitePrefs === 'object') {
        return { ...globalPrefs, ...sitePrefs };
      }
      return globalPrefs;
    },

    async saveGlobalPreferences(fieldPrefs) {
      if (!fieldPrefs || typeof fieldPrefs !== 'object') {
        return { success: false, error: 'Invalid preferences payload' };
      }
      const store = await readPreferencesStorage();
      const updatedGlobal = { ...getDefaultFieldPreferences() };
      for (const field of ALL_CANONICAL_FIELDS) {
        if (field in fieldPrefs) {
          updatedGlobal[field] = Boolean(fieldPrefs[field]);
        }
      }
      store.global = updatedGlobal;
      const ok = await writePreferencesStorage(store);
      return { success: ok, preferences: store };
    },

    async saveSitePreferences(hostname, fieldPrefs) {
      if (!hostname || typeof hostname !== 'string') {
        return { success: false, error: 'Invalid hostname' };
      }
      if (!fieldPrefs || typeof fieldPrefs !== 'object') {
        return { success: false, error: 'Invalid preferences payload' };
      }
      const store = await readPreferencesStorage();
      if (!store.sites) store.sites = {};
      const currentSite = store.sites[hostname] || {};
      const updatedSite = { ...currentSite };
      for (const field of ALL_CANONICAL_FIELDS) {
        if (field in fieldPrefs) {
          updatedSite[field] = Boolean(fieldPrefs[field]);
        }
      }
      store.sites[hostname] = updatedSite;
      const ok = await writePreferencesStorage(store);
      return { success: ok, preferences: store };
    },

    async clearSitePreferences(hostname) {
      if (!hostname || typeof hostname !== 'string') return false;
      const store = await readPreferencesStorage();
      if (store.sites && store.sites[hostname]) {
        delete store.sites[hostname];
        return await writePreferencesStorage(store);
      }
      return true;
    },

    async clearAllPreferences() {
      inMemoryPreferences = {
        global: getDefaultFieldPreferences(),
        sites: {}
      };
      if (isChromeStorageAvailable()) {
        return new Promise((resolve) => {
          chrome.storage.local.remove([STORAGE_KEY], () => resolve(true));
        });
      }
      return true;
    }
  };
}

export function filterProductByPreferences(product, effectivePrefs) {
  if (!product || typeof product !== 'object') return product;
  if (!effectivePrefs || typeof effectivePrefs !== 'object') return { ...product };

  const filtered = {};
  for (const [key, val] of Object.entries(product)) {
    if (key in effectivePrefs) {
      if (effectivePrefs[key] === true) {
        filtered[key] = val;
      }
    } else {
      filtered[key] = val;
    }
  }
  return filtered;
}

export function projectExtractionExport(payload, effectivePrefs) {
  if (!payload || typeof payload !== 'object') return payload;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    ...payload,
    appliedPreferences: effectivePrefs,
    items: items.map((item) => filterProductByPreferences(item, effectivePrefs))
  };
}

export const preferencesRepository = createPreferencesRepository();
