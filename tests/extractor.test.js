import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import {
  normalizeText,
  resolveAbsoluteUrl,
  parseCurrencyAndPrice,
  distinguishPrices,
  parseRating,
  parseCounts,
  extractProductId
} from '../src/modules/extractor/utils.js';
import { createExtractionEngine } from '../src/modules/extractor/index.js';
import { formatExtractionPayload, serializeToJson } from '../src/modules/export/index.js';

function loadFixture(filename, baseUrl = 'https://example.com') {
  const filePath = path.resolve(__dirname, 'fixtures', filename);
  const html = fs.readFileSync(filePath, 'utf-8');
  return new JSDOM(html, { url: baseUrl });
}

describe('Deterministic Extraction Utilities', () => {
  it('normalizes text and collapses whitespace', () => {
    expect(normalizeText('  Wireless \n\t Headphones   ')).toBe('Wireless Headphones');
    expect(normalizeText(null)).toBe('');
    expect(normalizeText('Item\u00a0Price')).toBe('Item Price');
  });

  it('resolves absolute URLs safely', () => {
    expect(resolveAbsoluteUrl('/item/123', 'https://example.com/search')).toBe('https://example.com/item/123');
    expect(resolveAbsoluteUrl('https://other.com/p/456', 'https://example.com')).toBe('https://other.com/p/456');
    expect(resolveAbsoluteUrl('javascript:void(0)', 'https://example.com')).toBe(null);
    expect(resolveAbsoluteUrl('#', 'https://example.com')).toBe(null);
  });

  it('parses various currencies and price formats', () => {
    expect(parseCurrencyAndPrice('$ 199.99')).toEqual({ currency: '$', price: 199.99 });
    expect(parseCurrencyAndPrice('149,99 €')).toEqual({ currency: '€', price: 149.99 });
    expect(parseCurrencyAndPrice('£ 45.00')).toEqual({ currency: '£', price: 45.0 });
    expect(parseCurrencyAndPrice('₹1,499')).toEqual({ currency: '₹', price: 1499.0 });
    expect(parseCurrencyAndPrice('2500 JPY')).toEqual({ currency: 'JPY', price: 2500.0 });
    expect(parseCurrencyAndPrice('No price available')).toEqual({ currency: null, price: null });
  });

  it('distinguishes selling price from strike-through MRP', () => {
    const dom = new JSDOM(`
      <div>
        <span class="price">$79.99</span>
        <del class="old-price">$99.99</del>
      </div>
    `);
    const result = distinguishPrices(dom.window.document.body.firstElementChild);
    expect(result.selling_price).toBe(79.99);
    expect(result.mrp).toBe(99.99);
    expect(result.currency).toBe('$');
  });

  it('handles single price without inventing MRP', () => {
    const dom = new JSDOM(`
      <div>
        <span class="price">$49.00</span>
      </div>
    `);
    const result = distinguishPrices(dom.window.document.body.firstElementChild);
    expect(result.selling_price).toBe(49.0);
    expect(result.mrp).toBe(null);
    expect(result.currency).toBe('$');
  });

  it('parses ratings and ratings/reviews counts distinctly', () => {
    const dom = new JSDOM(`
      <div>
        <div aria-label="4.6 out of 5 stars"></div>
        <span>1,420 ratings and 380 reviews</span>
      </div>
    `);
    const card = dom.window.document.body.firstElementChild;
    expect(parseRating(card)).toBe(4.6);
    expect(parseCounts(card)).toEqual({ rating_count: 1420, review_count: 380 });
  });

  it('extracts product IDs from genuine attributes and URL patterns', () => {
    const domAttr = new JSDOM('<div data-product-id="SKU-8899"><a href="/p/item">Title</a></div>');
    expect(extractProductId(domAttr.window.document.body.firstElementChild, 'https://example.com/p/item')).toBe('SKU-8899');

    const domUrl = new JSDOM('<div><a href="/dp/B08XYZ1234">Title</a></div>');
    expect(extractProductId(domUrl.window.document.body.firstElementChild, 'https://example.com/dp/B08XYZ1234')).toBe('B08XYZ1234');

    const domNone = new JSDOM('<div><a href="/catalog/view">Generic Item</a></div>');
    expect(extractProductId(domNone.window.document.body.firstElementChild, 'https://example.com/catalog/view')).toBe(null);
  });
});

describe('Generic Product Extraction Engine on Layout Fixtures', () => {
  const engine = createExtractionEngine();

  it('extracts products correctly from Layout 1 (Grid layout with lazy images and MRP)', async () => {
    const dom = loadFixture('layout-grid.html');
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://example.com/search?q=electronics',
      title: 'Electronics Search Results'
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(3);

    const [prod1, prod2, prod3] = result.items;

    expect(prod1.title).toBe('Wireless Noise Cancelling Over-Ear Headphones');
    expect(prod1.product_url).toBe('https://example.com/products/headphones-pro?ref=search');
    expect(prod1.product_id).toBe('PROD-1001');
    expect(prod1.image_url).toBe('https://example.com/images/headphones.jpg');
    expect(prod1.selling_price).toBe(199.99);
    expect(prod1.mrp).toBe(249.99);
    expect(prod1.currency).toBe('$');
    expect(prod1.rating).toBe(4.6);
    expect(prod1.rating_count).toBe(1420);
    expect(prod1.review_count).toBe(380);
    expect(prod1.extra.badge).toBe('Best Seller');
    expect(prod1.extra.discount).toBe('20% off');

    expect(prod2.title).toBe('Ergonomic Mechanical Keyboard RGB');
    expect(prod2.image_url).toBe('https://example.com/images/keyboard.jpg');
    expect(prod2.selling_price).toBe(89.5);
    expect(prod2.mrp).toBe(119.0);
    expect(prod2.rating).toBe(4.2);
    expect(prod2.rating_count).toBe(95);
    expect(prod2.review_count).toBe(null);
    expect(prod2.extra.shipping).toBe('Free Delivery');

    expect(prod3.title).toBe('Ultra HD 4K Action Camera Waterproof');
    expect(prod3.product_id).toBe('B08XYZ1234');
    expect(prod3.selling_price).toBe(299.0);
    expect(prod3.mrp).toBe(null);
    expect(prod3.rating_count).toBe(540);
    expect(prod3.review_count).toBe(null);

    expect(result.diagnostics.candidateCount).toBe(3);
    expect(result.diagnostics.acceptedCount).toBe(3);
    expect(result.diagnostics.rejectedCount).toBe(0);
    expect(result.diagnostics.fieldDiagnostics.title.status).toBe('EXTRACTED');
    expect(result.diagnostics.fieldDiagnostics.selling_price.status).toBe('EXTRACTED');
  });

  it('extracts products correctly from Layout 2 (List layout with European pricing and missing optional fields)', async () => {
    const dom = loadFixture('layout-list.html', 'https://store.fr');
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://store.fr/catalogue/maison',
      title: 'Catalogue Produits Maison'
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.items.length).toBe(2);

    const [item1, item2] = result.items;

    expect(item1.title).toBe('Cafetière Espresso Automatique 15 Bars');
    expect(item1.product_id).toBe('CF-770');
    expect(item1.image_url).toBe('https://store.fr/media/coffee.webp');
    expect(item1.selling_price).toBe(149.99);
    expect(item1.mrp).toBe(189.99);
    expect(item1.currency).toBe('€');
    expect(item1.rating).toBe(4.8);
    expect(item1.review_count).toBe(210);
    expect(item1.rating_count).toBe(null);

    expect(item2.title).toBe('Manteau Hiver Imperméable Unisexe');
    expect(item2.selling_price).toBe(89.0);
    expect(item2.currency).toBe('€');
    expect(item2.mrp).toBe(null);
    expect(item2.rating).toBe(null);
    expect(item2.rating_count).toBe(null);
    expect(item2.review_count).toBe(null);

    expect(result.diagnostics.fieldDiagnostics.mrp.status).toBe('PARTIALLY_AVAILABLE');
    expect(result.diagnostics.fieldDiagnostics.rating.status).toBe('PARTIALLY_AVAILABLE');
  });

  it('rejects navigation/aside elements and deduplicates in Layout 3 (Complex layout)', async () => {
    const dom = loadFixture('layout-complex.html', 'https://store.example.com');
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://store.example.com/search?category=gaming',
      title: 'Gaming Accessories Deals'
    });

    expect(result.items.length).toBe(2);
    expect(result.diagnostics.rejectedCount).toBeGreaterThanOrEqual(1);

    const titles = result.items.map((i) => i.title);
    expect(titles).toContain('Pro Gaming Mouse 16000 DPI');
    expect(titles).toContain('Speed Surface Gaming Mousepad XL');

    const mouse = result.items.find((i) => i.title === 'Pro Gaming Mouse 16000 DPI');
    expect(mouse.currency).toBe('£');
    expect(mouse.selling_price).toBe(45.0);
    expect(mouse.mrp).toBe(60.0);
    expect(mouse.extra.is_sponsored).toBe(true);
  });

  it('gracefully handles non-product pages in Layout 4 (Empty layout)', async () => {
    const dom = loadFixture('layout-empty.html', 'https://blog.example.com');
    const result = await engine.execute({
      document: dom.window.document,
      url: 'https://blog.example.com/post-1',
      title: 'Blog Post'
    });

    expect(result.status).toBe('EMPTY');
    expect(result.items.length).toBe(0);
    expect(result.diagnostics.candidateCount).toBe(0);
    expect(result.diagnostics.acceptedCount).toBe(0);
    expect(result.message).toBe('No product cards identified on this page.');
  });

  it('formats payload and exports valid JSON with page metadata', () => {
    const items = [
      {
        title: 'Sample Product',
        product_url: 'https://example.com/p/1',
        product_id: 'ID1',
        image_url: 'https://example.com/img.jpg',
        selling_price: 29.99,
        mrp: null,
        currency: '$',
        rating: 4.5,
        rating_count: 10,
        review_count: null,
        extra: {}
      }
    ];

    const payload = formatExtractionPayload(
      { url: 'https://example.com/search', title: 'Search Page' },
      items
    );

    expect(payload.extractor).toBe('PIRATES ALERT');
    expect(payload.page.url).toBe('https://example.com/search');
    expect(payload.totalItems).toBe(1);
    expect(payload.items[0].title).toBe('Sample Product');

    const json = serializeToJson(payload);
    const parsed = JSON.parse(json);
    expect(parsed.items.length).toBe(1);
    expect(parsed.page.title).toBe('Search Page');
  });
});
