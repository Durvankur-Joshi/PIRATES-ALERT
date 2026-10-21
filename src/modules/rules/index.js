const STORAGE_KEY = 'pirates_alert_rules';
const MAX_RULE_VERSIONS = 10;

let inMemoryStore = new Map();

function isChromeStorageAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
}

async function readStorage() {
  if (isChromeStorageAvailable()) {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime?.lastError) {
          resolve({});
          return;
        }
        resolve(result?.[STORAGE_KEY] || {});
      });
    });
  }
  const obj = {};
  for (const [k, v] of inMemoryStore.entries()) {
    obj[k] = v;
  }
  return obj;
}

async function writeStorage(data) {
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
  inMemoryStore = new Map(Object.entries(data));
  return true;
}

export function normalizeHostname(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let host = raw.trim().toLowerCase();
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }
  return host;
}

export function computeLayoutFingerprint(doc, hostname = '') {
  if (!doc) {
    return 'default_layout';
  }

  const containerCandidates = doc.querySelectorAll(
    'main, [class*="product-grid"], [class*="product-list"], [class*="search-result"], [class*="results"], [id*="results"], [id*="search"]'
  );

  let structuralSignature = '';
  for (const container of containerCandidates) {
    const cls = typeof container.className === 'string' ? container.className.split(' ').filter(Boolean).slice(0, 2).join('-') : '';
    const id = typeof container.id === 'string' && container.id ? container.id.slice(0, 15) : '';
    structuralSignature += `|${container.tagName.toLowerCase()}_${cls}_${id}`;
    if (structuralSignature.length > 80) break;
  }

  if (!structuralSignature) {
    const cards = doc.querySelectorAll('[class*="product"], [class*="item"], [class*="card"]');
    if (cards.length > 0) {
      const sample = cards[0];
      const cls = typeof sample.className === 'string' ? sample.className.split(' ').filter(Boolean).slice(0, 2).join('-') : '';
      structuralSignature = `${sample.tagName.toLowerCase()}_${cls}`;
    }
  }

  if (!structuralSignature) {
    return 'generic_layout';
  }

  let hash = 0;
  for (let i = 0; i < structuralSignature.length; i++) {
    const char = structuralSignature.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }

  return `layout_${Math.abs(hash).toString(36)}`;
}

export function migrateRuleRecord(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (Array.isArray(rule.versions) && rule.versions.length > 0) {
    return rule;
  }

  const v1 = {
    version: 1,
    versionId: 'v1',
    parentVersionId: null,
    createdAt: rule.createdAt || rule.updatedAt || new Date().toISOString(),
    changeSource: 'ai_learning',
    changeSummary: 'Initial version',
    cardSelector: rule.cardSelector,
    fieldSelectors: rule.fieldSelectors || {},
    parsingOptions: rule.parsingOptions || {},
    validationResults: rule.testResults || {},
    regressionResults: {},
    isActive: true
  };

  return {
    ...rule,
    activeVersionId: 'v1',
    lastKnownGoodVersionId: rule.validationStatus === 'VALIDATED' ? 'v1' : null,
    versions: [v1]
  };
}

function boundVersionHistory(versions, activeVersionId, lastKnownGoodVersionId) {
  if (!Array.isArray(versions) || versions.length <= MAX_RULE_VERSIONS) {
    return versions || [];
  }

  const essentialIds = new Set([activeVersionId, lastKnownGoodVersionId].filter(Boolean));
  const sorted = [...versions].sort((a, b) => (a.version || 0) - (b.version || 0));

  while (sorted.length > MAX_RULE_VERSIONS) {
    const indexToRemove = sorted.findIndex((v) => !essentialIds.has(v.versionId));
    if (indexToRemove >= 0) {
      sorted.splice(indexToRemove, 1);
    } else {
      break;
    }
  }
  return sorted;
}

export function createRulesRepository() {
  return {
    async computeFingerprint(doc, hostname) {
      return computeLayoutFingerprint(doc, hostname);
    },

    async getRule(ruleId) {
      if (!ruleId || typeof ruleId !== 'string') return null;
      try {
        const store = await readStorage();
        const raw = store[ruleId] || null;
        return raw ? migrateRuleRecord(raw) : null;
      } catch {
        return null;
      }
    },

    async findMatchingRule(hostname, layoutFingerprint) {
      if (!hostname || !layoutFingerprint) return null;
      try {
        const store = await readStorage();
        const rules = Object.values(store);
        const targetHost = normalizeHostname(hostname);

        const matchedRules = rules.filter(
          (r) =>
            r &&
            normalizeHostname(r.hostname) === targetHost &&
            r.layoutFingerprint === layoutFingerprint &&
            (r.validationStatus === 'VALIDATED' || r.validationStatus === 'PARTIAL') &&
            r.schemaVersion === '1.0' &&
            Boolean(r.cardSelector)
        );

        const exactMatch = matchedRules.find((r) => r.validationStatus === 'VALIDATED') || matchedRules[0];
        return exactMatch ? migrateRuleRecord(exactMatch) : null;
      } catch {
        return null;
      }
    },

    async saveRule(ruleDefinition) {
      if (
        !ruleDefinition ||
        typeof ruleDefinition !== 'object' ||
        !ruleDefinition.hostname ||
        !ruleDefinition.cardSelector ||
        !ruleDefinition.layoutFingerprint
      ) {
        return { success: false, error: 'Invalid or incomplete rule definition' };
      }

      try {
        const store = await readStorage();
        const normalizedHost = normalizeHostname(ruleDefinition.hostname);
        const id = ruleDefinition.id || `rule_${normalizedHost}_${ruleDefinition.layoutFingerprint}`;
        const now = new Date().toISOString();

        const rawExisting = store[id];
        const existing = rawExisting ? migrateRuleRecord(rawExisting) : null;

        let validationStatus = 'UNVALIDATED';
        if (ruleDefinition.validationStatus === 'VALIDATED' && ruleDefinition.testResults && ruleDefinition.testResults.valid === true) {
          validationStatus = 'VALIDATED';
        } else if (ruleDefinition.validationStatus === 'PARTIAL') {
          validationStatus = 'PARTIAL';
        }

        if (existing && (existing.validationStatus === 'VALIDATED' || existing.validationStatus === 'PARTIAL') && validationStatus === 'UNVALIDATED') {
          return {
            success: false,
            error: 'Cannot overwrite an existing validated rule with an unvalidated proposal',
            preservedRule: existing
          };
        }

        if (
          ruleDefinition.changeSource === 'ai_learning' &&
          existing &&
          (existing.versions?.[existing.versions.length - 1]?.changeSource === 'manual_selector_correction' ||
           existing.versions?.[existing.versions.length - 1]?.changeSource === 'user_correction')
        ) {
          const existingValidCount = existing.testResults?.acceptedCount || 0;
          const incomingValidCount = ruleDefinition.testResults?.acceptedCount || 0;
          if (incomingValidCount < existingValidCount) {
            return {
              success: false,
              error: 'Cannot overwrite manually confirmed selector rule with weaker AI proposal',
              preservedRule: existing
            };
          }
        }

        if (ruleDefinition.testResults && ruleDefinition.testResults.valid === false && validationStatus !== 'PARTIAL') {
          return {
            success: false,
            error: `Rule failed validation: ${(ruleDefinition.testResults.errors || []).join('; ')}`,
            preservedRule: existing
          };
        }

        if (ruleDefinition.regressionResults && ruleDefinition.regressionResults.passed === false) {
          return {
            success: false,
            error: `Rule failed regression testing: ${(ruleDefinition.regressionResults.failures || []).join('; ')}`,
            preservedRule: existing
          };
        }

        let newVersionNum = 1;
        let parentVersionId = null;
        let existingVersions = [];

        if (existing && Array.isArray(existing.versions) && existing.versions.length > 0) {
          existingVersions = existing.versions.map((v) => ({ ...v, isActive: false }));
          const maxVer = existingVersions.reduce((max, v) => Math.max(max, v.version || 1), 1);
          newVersionNum = maxVer + 1;
          parentVersionId = existing.activeVersionId || `v${maxVer}`;
        }

        const newVersionId = `v${newVersionNum}`;
        const newVersionRecord = {
          version: newVersionNum,
          versionId: newVersionId,
          parentVersionId,
          createdAt: now,
          changeSource: ruleDefinition.changeSource || (existing ? 'user_correction' : 'ai_learning'),
          changeSummary: ruleDefinition.changeSummary || `Version ${newVersionNum}`,
          pageType: ruleDefinition.pageType || existing?.pageType || 'ecommerce',
          cardSelector: ruleDefinition.cardSelector.trim(),
          fieldSelectors: ruleDefinition.fieldSelectors || {},
          parsingOptions: ruleDefinition.parsingOptions || {},
          validationResults: ruleDefinition.testResults || {},
          regressionResults: ruleDefinition.regressionResults || {},
          isActive: true
        };

        const allVersions = [...existingVersions, newVersionRecord];
        const activeVersionId = newVersionId;
        const lastKnownGoodVersionId =
          validationStatus === 'VALIDATED' ? newVersionId : existing?.lastKnownGoodVersionId || null;

        const boundedVersions = boundVersionHistory(allVersions, activeVersionId, lastKnownGoodVersionId);

        const ruleRecord = {
          id,
          hostname: normalizedHost,
          rawHostname: ruleDefinition.hostname,
          layoutFingerprint: ruleDefinition.layoutFingerprint,
          pageType: ruleDefinition.pageType || existing?.pageType || 'ecommerce',
          cardSelector: ruleDefinition.cardSelector.trim(),
          fieldSelectors: ruleDefinition.fieldSelectors || {},
          parsingOptions: ruleDefinition.parsingOptions || {},
          createdAt: existing?.createdAt || ruleDefinition.createdAt || now,
          updatedAt: now,
          lastUsedAt: now,
          ruleVersion: String(newVersionNum),
          schemaVersion: '1.0',
          validationStatus,
          testResults: ruleDefinition.testResults || {},
          activeVersionId,
          lastKnownGoodVersionId,
          versions: boundedVersions
        };

        store[id] = ruleRecord;
        const ok = await writeStorage(store);
        if (!ok) {
          return { success: false, error: 'Storage write operation failed' };
        }
        return { success: true, rule: ruleRecord };
      } catch (err) {
        return { success: false, error: err?.message || 'Storage write failed' };
      }
    },

    async rollbackRule(ruleId, targetVersionId) {
      if (!ruleId || !targetVersionId) {
        return { success: false, error: 'Missing ruleId or targetVersionId' };
      }

      try {
        const store = await readStorage();
        const raw = store[ruleId];
        if (!raw) {
          return { success: false, error: `Rule "${ruleId}" not found` };
        }

        const rule = migrateRuleRecord(raw);
        const targetVersion = (rule.versions || []).find((v) => v.versionId === targetVersionId);
        if (!targetVersion) {
          return { success: false, error: `Version "${targetVersionId}" not found in history` };
        }

        if (targetVersion.validationResults && targetVersion.validationResults.valid === false) {
          return { success: false, error: `Target version "${targetVersionId}" is unvalidated and cannot be restored` };
        }

        const now = new Date().toISOString();
        const currentMaxVer = rule.versions.reduce((max, v) => Math.max(max, v.version || 1), 1);
        const nextVersionNum = currentMaxVer + 1;
        const rollbackVersionId = `v${nextVersionNum}`;

        const updatedVersions = rule.versions.map((v) => ({ ...v, isActive: false }));

        const rollbackRecord = {
          version: nextVersionNum,
          versionId: rollbackVersionId,
          parentVersionId: rule.activeVersionId,
          createdAt: now,
          changeSource: 'rollback',
          changeSummary: `Rolled back to ${targetVersionId}`,
          cardSelector: targetVersion.cardSelector,
          fieldSelectors: { ...(targetVersion.fieldSelectors || {}) },
          parsingOptions: { ...(targetVersion.parsingOptions || {}) },
          validationResults: targetVersion.validationResults || {},
          regressionResults: targetVersion.regressionResults || {},
          restoredFromVersion: targetVersionId,
          isActive: true
        };

        updatedVersions.push(rollbackRecord);

        const boundedVersions = boundVersionHistory(
          updatedVersions,
          rollbackVersionId,
          rollbackVersionId
        );

        rule.cardSelector = targetVersion.cardSelector;
        rule.fieldSelectors = { ...(targetVersion.fieldSelectors || {}) };
        rule.parsingOptions = { ...(targetVersion.parsingOptions || {}) };
        rule.ruleVersion = String(nextVersionNum);
        rule.updatedAt = now;
        rule.lastUsedAt = now;
        rule.validationStatus = 'VALIDATED';
        rule.testResults = targetVersion.validationResults || {};
        rule.activeVersionId = rollbackVersionId;
        rule.lastKnownGoodVersionId = rollbackVersionId;
        rule.versions = boundedVersions;

        store[ruleId] = rule;
        const ok = await writeStorage(store);
        if (!ok) {
          return { success: false, error: 'Storage write failed during rollback' };
        }

        return {
          success: true,
          rule,
          rolledBackTo: targetVersionId,
          activeVersion: rollbackRecord
        };
      } catch (err) {
        return { success: false, error: err?.message || 'Rollback failed' };
      }
    },

    async getRuleHistory(ruleId) {
      if (!ruleId || typeof ruleId !== 'string') {
        return { success: false, error: 'Invalid rule ID' };
      }
      try {
        const store = await readStorage();
        const raw = store[ruleId];
        if (!raw) {
          return { success: false, error: `Rule "${ruleId}" not found` };
        }
        const rule = migrateRuleRecord(raw);
        return {
          success: true,
          ruleId,
          activeVersionId: rule.activeVersionId,
          lastKnownGoodVersionId: rule.lastKnownGoodVersionId,
          versions: rule.versions || []
        };
      } catch (err) {
        return { success: false, error: err?.message || 'Failed to read rule history' };
      }
    },

    async deleteRule(ruleId) {
      if (!ruleId || typeof ruleId !== 'string') return false;
      try {
        const store = await readStorage();
        if (store[ruleId]) {
          delete store[ruleId];
          return await writeStorage(store);
        }
        return false;
      } catch {
        return false;
      }
    },

    async getAllRules() {
      try {
        const store = await readStorage();
        return Object.values(store)
          .filter((r) => r && typeof r === 'object' && r.id)
          .map((r) => migrateRuleRecord(r));
      } catch {
        return [];
      }
    },

    async clearAllRules() {
      inMemoryStore.clear();
      if (isChromeStorageAvailable()) {
        return new Promise((resolve) => {
          chrome.storage.local.remove([STORAGE_KEY], () => resolve(true));
        });
      }
      return true;
    }
  };
}

export const rulesRepository = createRulesRepository();
