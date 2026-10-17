import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runGeminiDiagnostic, getGeminiModel } from './proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvKeyIfPresent() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^GEMINI_API_KEY=(.*)$/m);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {}
  }
  return '';
}

async function main() {
  const apiKey = loadEnvKeyIfPresent();
  const model = getGeminiModel();

  console.log('=== PIRATES ALERT - Gemini Upstream Diagnostic ===');
  console.log(`Configured Model  : ${model}`);
  console.log(`API Key Configured: ${apiKey ? 'YES (Key loaded safely from environment)' : 'NO (Missing GEMINI_API_KEY)'}`);

  if (!apiKey) {
    console.error('\nResult: FAILED');
    console.error('Diagnosis: GEMINI_API_KEY is not set.');
    console.error('Fix: Set process.env.GEMINI_API_KEY before running proxy.');
    process.exit(1);
  }

  console.log('Dispatching minimal probe to Gemini generateContent endpoint...');
  const result = await runGeminiDiagnostic(apiKey, model, 15000);

  console.log(`Headers Received  : ${result.headersReceived ? 'YES' : 'NO'}`);
  if (result.upstreamStatusCode) {
    console.log(`Upstream Status   : HTTP ${result.upstreamStatusCode}`);
  }
  if (result.ttfbMs !== null) {
    console.log(`Time to First Byte: ${result.ttfbMs} ms`);
  }
  console.log(`Total Duration    : ${result.totalDurationMs} ms`);

  if (result.status === 'PASS') {
    console.log('\nResult: SUCCESS (Gemini upstream API is fully responsive and compatible)');
    console.log(`Parsed Response   : ${JSON.stringify(result.parsed)}`);
    process.exit(0);
  } else {
    console.error(`\nResult: FAILED (${result.category || 'ERROR'})`);
    console.error(`Error Detail      : ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Diagnostic error:', err.message);
  process.exit(1);
});
