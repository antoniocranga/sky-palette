import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SEO, Metadata & Open Graph Architecture', () => {
  const htmlPath = path.resolve('public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');

  it('declares self-referencing canonical URL and indexing directives', () => {
    assert.match(html, /<link rel="canonical" href="https:\/\/skypalette\.app">/i, 'Must have canonical URL tag');
    assert.match(html, /<meta name="robots" content="index, follow">/i, 'Must allow search engine indexing');
  });

  it('provides comprehensive and unique meta title and description', () => {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    assert.ok(titleMatch, 'Title tag must exist');
    assert.match(titleMatch[1], /Sky Palette/i);

    const descMatch = html.match(/<meta name="description" content="([^"]+)">/i);
    assert.ok(descMatch, 'Meta description must exist');
    const desc = descMatch[1];
    assert.ok(desc.length >= 80 && desc.length <= 200, `Meta description length (${desc.length}) should be between 80-200 chars`);
  });

  it('implements Open Graph protocol for social platform link previews', () => {
    assert.match(html, /<meta property="og:type" content="website">/i);
    assert.match(html, /<meta property="og:url" content="https:\/\/skypalette\.app">/i);
    assert.match(html, /<meta property="og:title" content="[^"]+">/i);
    assert.match(html, /<meta property="og:description" content="[^"]+">/i);
    assert.match(html, /<meta property="og:image" content="[^"]+">/i);
  });

  it('implements Twitter Cards for rich timeline expansion', () => {
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/i);
    assert.match(html, /<meta name="twitter:url" content="https:\/\/skypalette\.app">/i);
    assert.match(html, /<meta name="twitter:title" content="[^"]+">/i);
    assert.match(html, /<meta name="twitter:description" content="[^"]+">/i);
    assert.match(html, /<meta name="twitter:image" content="[^"]+">/i);
  });

  it('provides valid Schema.org WebApplication structured data (JSON-LD)', () => {
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    assert.ok(jsonLdMatch, 'Must include application/ld+json script block');

    const json = JSON.parse(jsonLdMatch[1].trim());
    assert.strictEqual(json['@context'], 'https://schema.org');
    assert.strictEqual(json['@type'], 'WebApplication');
    assert.strictEqual(json.name, 'Sky Palette');
    assert.strictEqual(json.url, 'https://skypalette.app');
  });

  it('declares favicons and touch icons without broken references', () => {
    assert.match(html, /<link rel="icon"/i, 'Must declare favicon');
    assert.match(html, /<link rel="apple-touch-icon"/i, 'Must declare apple touch icon');
  });
});
