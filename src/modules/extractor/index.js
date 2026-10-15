export function createExtractionEngine(config = {}) {
  const settings = {
    timeoutMs: config.timeoutMs || 10000,
    maxRetries: config.maxRetries || 2,
    ...config
  };

  return {
    isConfigured() {
      return Boolean(settings);
    },
    async execute(context = {}) {
      return {
        status: 'READY_FOR_PIPELINE',
        targetUrl: context.url || '',
        pageTitle: context.title || '',
        timestamp: new Date().toISOString(),
        items: []
      };
    },
    getCapabilities() {
      return {
        engineVersion: '1.0.0',
        supportedPipelines: ['rules', 'ai_discovery', 'hybrid'],
        activePipeline: null
      };
    }
  };
}

export const extractionEngine = createExtractionEngine();
