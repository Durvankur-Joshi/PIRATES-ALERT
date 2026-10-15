export function createRulesRepository() {
  const memoryStore = new Map();

  return {
    async getRule(hostname) {
      if (!hostname) return null;
      return memoryStore.get(hostname) || null;
    },
    async setRule(hostname, ruleDefinition) {
      if (!hostname || !ruleDefinition) return false;
      memoryStore.set(hostname, {
        ...ruleDefinition,
        updatedAt: new Date().toISOString()
      });
      return true;
    },
    async removeRule(hostname) {
      return memoryStore.delete(hostname);
    },
    async getAllRules() {
      return Array.from(memoryStore.entries()).map(([hostname, rule]) => ({
        hostname,
        ...rule
      }));
    }
  };
}

export const rulesRepository = createRulesRepository();
