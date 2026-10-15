export function createRecoveryModule() {
  const recoveryStrategies = ['cache_fallback', 'parent_traverse', 'semantic_probe'];

  return {
    getStrategies() {
      return [...recoveryStrategies];
    },
    async attemptRecovery(errorContext) {
      return {
        recovered: false,
        exhausted: true,
        reason: errorContext?.message || 'No recovery strategy applicable in base phase'
      };
    },
    validateExtractionResult(result) {
      if (!result || typeof result !== 'object') {
        return { valid: false, issue: 'Empty or invalid extraction payload' };
      }
      return { valid: true };
    }
  };
}

export const recoveryModule = createRecoveryModule();
