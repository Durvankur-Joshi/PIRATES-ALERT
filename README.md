# PIRATES ALERT

AI-Assisted Product Search Results Extractor — Chrome Manifest V3 Extension.

PIRATES ALERT extracts structured, normalized product listings from e-commerce search results and catalog pages. It combines high-precision deterministic DOM heuristics, layout-fingerprinted rule persistence, regression-tested rule versioning and rollback, field-level personalization preferences, user corrections, and an AI layout-learning proxy.

---

## Key Features

- **Deterministic DOM Extraction**: Scopes candidate product cards, extracts titles, normalized product and image URLs, selling prices, list MRPs, currencies, star ratings, review counts, and badges without making external network calls.
- **Strict Layout Matching & Zero-AI Reuse**: Computes an exact DOM structure fingerprint and hostname pair. Reuses validated rules with 0 AI requests and strictly isolates multiple layouts on the same host.
- **AI-Assisted Layout Learning**: When heuristics are insufficient or ambiguous, requests CSS selector proposals from an isolated backend proxy powered by Gemini.
- **Pre-Activation Validation & Regression Protection**: Every rule candidate must pass live DOM validation and automated regression fixture checks before being activated. Failing candidates never overwrite active rules.
- **Immutable Rule Versioning & Rollback**: Rules maintain an append-only version history (`v1`, `v2`, ...). Rolling back creates a new version referencing the restored version rather than rewriting history.
- **Field Preferences (Global & Site Overrides)**: Allows users to choose which fields to display and export to JSON without modifying internal canonical data.
- **User Corrections & Targeted Selector Deduction**: Users can edit extracted card values in the popup. Corrections are validated by field type and deduce improved card-relative selectors without replacing selectors with raw string values.
- **Hardened AI Proxy**: Keeps Google Gemini API credentials strictly server-side with in-memory IP rate limiting, 100KB payload caps, 12-second timeouts, and sanitized error responses.

---

## Canonical Data Schema

Extracted products adhere to this normalized schema:

| Field | Type | Description |
| :--- | :--- | :--- |
| `title` | `string` | Normalized product title |
| `product_url` | `string` \| `null` | Absolute `http:` or `https:` product URL |
| `product_id` | `string` \| `null` | Item identifier parsed from attributes or URL |
| `image_url` | `string` \| `null` | Absolute image URL |
| `selling_price` | `number` \| `null` | Current active purchase price |
| `mrp` | `number` \| `null` | Original or strikethrough list price |
| `currency` | `string` \| `null` | Currency symbol or ISO code (e.g. `$`, `€`, `USD`) |
| `rating` | `number` \| `null` | Score between 0.0 and 5.0 |
| `rating_count` | `number` \| `null` | Integer count of customer ratings |
| `review_count` | `number` \| `null` | Integer count of written customer reviews |
| `extra` | `object` | Supplementary metadata (badges, discount percentages) |

---

## Architecture & Module Organization

```
pirates-alert/
├── dist/                              # Compiled Chrome extension bundle
├── public/
│   ├── manifest.json                  # Manifest V3 configuration (activeTab, storage)
│   └── icons/                         # Extension icons (16, 48, 128px)
├── server/
│   └── proxy.js                       # Rate-limited Gemini AI proxy server
├── src/
│   ├── background/
│   │   └── index.js                   # Minimal Manifest V3 background service worker
│   ├── content/
│   │   └── index.js                   # In-page messaging, extraction, and validation runner
│   ├── modules/
│   │   ├── ai/                        # Proxy client, token estimation, and log storage
│   │   ├── corrections/               # Field validation, user corrections, selector deduction
│   │   ├── export/                    # Canonical payload formatting and JSON download
│   │   ├── extractor/                 # Deterministic extraction engine and card detector
│   │   ├── messaging/                 # Protocol constants, types, and tab messaging
│   │   ├── preferences/               # Field preferences repository and projections
│   │   ├── regression/                # Snapshot fixtures, comparison engine, regression runner
│   │   └── rules/                     # Rules repository, versioning, rollback, validator
│   ├── popup/
│   │   ├── App.jsx                    # Multi-tab popup UI (Extract, Rules, AI Logs, Prefs)
│   │   └── popup.css                  # Modern dark-mode interface styling
│   └── styles/
│       └── theme.css                  # Color tokens, borders, and typography variables
└── tests/                             # Vitest integration test suites and local HTML fixtures
```

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **Google Chrome**: Manifest V3 compatible browser

---

## Setup & Installation

1. Clone or navigate to the repository directory:
   ```powershell
   cd "e:\PIRATES ALERT"
   ```

2. Install dependencies:
   ```powershell
   npm install
   ```

---

## Configuration & Environment Variables

The browser extension contains **no API keys or hardcoded secrets**. The Gemini API key is configured only on the proxy server:

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Yes (for AI learning) | *(none)* | Google Gemini API Key |
| `PORT` | No | `3001` | Local proxy server listening port |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model identifier |

In PowerShell:
```powershell
$env:GEMINI_API_KEY="your-gemini-api-key-here"
$env:PORT="3001"
```

In bash / Linux / macOS:
```bash
export GEMINI_API_KEY="your-gemini-api-key-here"
export PORT="3001"
```

---

## Running the Proxy Server

To enable AI layout learning:
```powershell
npm run server
```
The server will start at `http://localhost:3001`. You can verify health by visiting:
```
http://localhost:3001/health
```

---

## Building the Extension

Build the production extension bundle into `dist/`:
```powershell
npm run build
```
This builds both the popup/background bundles and the standalone content script bundle into `dist/`.

---

## Loading into Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `dist` directory (`e:\PIRATES ALERT\dist`).
5. The **PIRATES ALERT** extension icon will appear in your Chrome toolbar. Pin it for quick access.

---

## Running Tests

Execute the full automated test suite:
```powershell
npm test
```
The test suite runs with Vitest using local JSDOM fixtures and mocked storage/AI APIs. No live network requests or Gemini API calls occur during automated tests.

---

## Conservative Resource Limits

To ensure browser responsiveness and prevent resource exhaustion, PIRATES ALERT enforces explicit bounds:

- **Candidate Cards**: Capped at 250 elements per extraction run; truncation is reported in diagnostics.
- **AI Request Payload**: Max 4 card snippets, max 25KB total DOM characters, max 100KB request body.
- **AI Proxy Rate Limit**: 30 requests per minute per IP address.
- **AI Log Retention**: Bounded to the last 50 entries in `chrome.storage.local`.
- **User Corrections**: Bounded to the last 100 entries.
- **Regression Fixtures**: Bounded to 20 fixtures (max 25KB per fixture).
- **Rule Version History**: Bounded to 10 versions per rule; active and last known-good versions are never purged.

---

## Privacy & Security Guarantees

- **No Remote Scripts**: Operates strictly within Manifest V3 security boundaries with bundled local code.
- **Safe Protocols**: URLs are checked against `http:` and `https:`. Unsafe schemes such as `javascript:`, `vbscript:`, `data:`, and `file:` are rejected.
- **Untrusted DOM**: Extracted page text and attributes are treated as untrusted strings and never evaluated or rendered as raw HTML.
- **No Telemetry**: No third-party trackers, analytics, or external calls outside the configured local proxy.
- **Minimum Permissions**: Uses only `activeTab` (scoped access to the currently active tab upon user click) and `storage` (local rule and preference persistence).

---

## Troubleshooting

- **"Could not detect an active browser tab"**: Reload the active tab or click on the webpage before opening the popup.
- **"Browser system pages cannot be extracted"**: Chrome extensions cannot run on internal system pages (`chrome://`, `edge://`, `about:blank`). Navigate to an HTTP or HTTPS shopping website.
- **"AI learning failed. Is the AI proxy server running?"**: Ensure `npm run server` is running in your terminal and `GEMINI_API_KEY` is set. Check `http://localhost:3001/health`.
- **"Cannot overwrite an existing validated rule"**: An unvalidated proposal cannot overwrite an active validated rule. Ensure validation passes before saving.
- **"Rule failed regression checks"**: A newly proposed rule caused field extractions to regress on saved snapshot fixtures. Inspect the failed fields before updating.

---

## Manual Smoke-Test Checklist

Follow this checklist to manually verify all workflows in Chrome:

1. **Deterministic Heuristic Extraction**:
   - Navigate to an e-commerce search results page.
   - Open popup, click **Extract Products**.
   - Verify products populate with titles, prices, and links.
   - Badge displays `Heuristics (0 AI calls)`.
2. **AI Layout Learning & Rule Persistence**:
   - On any supported product listing page without an active saved rule, **Learn with AI** is available alongside Extract Products.
   - If heuristics extracted products cleanly, an informative banner notes that AI learning is optional and creates a reusable rule.
   - Click **Learn with AI**; observe the button enter the "Learning..." state while DOM cards are sampled.
   - Review the **AI Layout Rule Proposal**: inspect proposed card/field selectors, validation status badge (`Validated` vs `Unreliable`), matched cards, and match rate %.
   - If a candidate fails validation, inspect the listed validation errors explaining why saving is blocked, with safe **Retry Learning** or **Cancel** options.
   - When valid, click **Save & Apply Rule**.
   - Confirm the proposal closes, the rule is saved and listed in the **Rules** tab, and the page is automatically re-extracted displaying `Rule (0 AI calls)`.
3. **Zero-AI Rule Reuse**:
   - Navigate to another query on the same website.
   - Click **Extract Products** (or **Re-extract**).
   - Confirm `Rule (0 AI calls)` is displayed immediately and active saved rule ID/version is shown in the target card.
   - Check **AI Logs** tab to verify zero new AI requests were initiated during rule reuse.
4. **Rules Tab Entry Point**:
   - Switch to **Rules** tab.
   - Click **Learn with AI** in the tab header (or **Learn Current Page Layout** in the empty state).
   - Observe automatic navigation to the Extract tab and immediate initiation of layout learning for the current supported page.
5. **Field Preferences**:
   - Switch to **Prefs** tab.
   - Disable **MRP** under Global Defaults or disable **Image URL** under Site scope.
   - Return to **Extract** tab; verify disabled fields are hidden from view.
   - Click **JSON** download; inspect exported file to confirm disabled fields are omitted while canonical metadata is preserved.
6. **User Corrections**:
   - Click **Correct** on any product card in the list.
   - Modify a field (e.g. adjust price) and click **Save Correction**.
   - Confirm the list item immediately updates. If an improved selector was deduced and passed regression, verify the rule increments to a new version.
7. **Rule History & Rollback**:
   - Go to **Rules** tab.
   - Click **History** on a saved rule with multiple versions.
   - Click **Rollback to v1**.
   - Verify a new active version (e.g. `v3`) is created referencing the restored version.
8. **Failure & Boundary States**:
   - Open popup on `chrome://extensions/`; confirm clear warning message and disabled action buttons.
   - If proxy server is stopped, click **Learn with AI**; observe actionable error banner explaining proxy connection failure with a **Retry** button.
   - Open popup on an empty non-product page; confirm friendly empty state message.
