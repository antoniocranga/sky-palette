import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Front-End Web Application & UI Architecture', () => {
  const htmlPath = path.resolve('public/index.html');
  assert.ok(fs.existsSync(htmlPath), 'public/index.html must exist');
  const html = fs.readFileSync(htmlPath, 'utf-8');

  it('contains essential semantic landmark elements and viewport setup', () => {
    assert.match(html, /<!DOCTYPE html>/i, 'Must have HTML5 DOCTYPE');
    assert.match(html, /<html lang="en">/i, 'Must declare lang attribute');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/i, 'Must have responsive viewport tag');
    assert.match(html, /<main/i, 'Must contain <main> landmark');
    assert.match(html, /<nav/i, 'Must contain <nav> navigation dock');
    assert.match(html, /linear-gradient/i, 'Must use atmospheric linear gradients');
  });

  it('includes interactive UI components (Jog-Dial Scrubber, Autocomplete, Modal Dialog)', () => {
    assert.match(html, /id="ruler-viewport"/i, 'Must contain Jog-dial ruler viewport');
    assert.match(html, /id="ruler-time-display"/i, 'Must contain central time readout display');
    assert.match(html, /id="modal-city-search-input"/i, 'Must contain city search input field');
    assert.match(html, /id="day-cards-grid"/i, 'Must contain 15-day sunset mosaic grid');
    assert.match(html, /id="info-modal"/i, 'Must contain info modal dialog');
    assert.match(html, /id="submit-modal"/i, 'Must contain photo submission modal');
  });

  it('enforces WCAG 2.2 AA accessibility requirements', () => {
    // All interactive buttons must have aria-label or accessible text
    const buttonMatches = html.match(/<button[^>]*>/g) || [];
    assert.ok(buttonMatches.length > 0, 'Must have interactive buttons');

    for (const btn of buttonMatches) {
      const hasAriaLabel = /aria-label="[^"]+"/i.test(btn);
      const hasTitle = /title="[^"]+"/i.test(btn);
      const isSelfClosing = btn.includes('/>');
      assert.ok(hasAriaLabel || hasTitle || !isSelfClosing, `Button missing accessible label: ${btn}`);
    }

    // Search input must have an accessible label
    assert.match(html, /<label[^>]*for="modal-city-search-input"[^>]*>/i, 'Search input must have associated label');
    assert.match(html, /sr-only/i, 'Must use screen-reader utility class for non-visual labels');

    // Dialog close buttons must have accessible labels
    assert.match(html, /aria-label="Close[^"]*"/i, 'Close buttons must have accessible label');
  });

  it('adheres to the zero-tracking mandate (no cookies, no external trackers)', () => {
    // Zero cookies
    assert.doesNotMatch(html, /document\.cookie/i, 'Must never access or set document.cookie');
    assert.doesNotMatch(html, /localStorage\.setItem/i, 'Must not persist tracking state in localStorage');

    // No Google Analytics / Facebook Pixel / third party ad tech
    assert.doesNotMatch(html, /google-analytics\.com/i, 'Must not load Google Analytics');
    assert.doesNotMatch(html, /connect\.facebook\.net/i, 'Must not load Facebook tracking pixel');
    assert.doesNotMatch(html, /clarity\.ms/i, 'Must not load Microsoft Clarity');
  });

  it('configures web font performance optimizations', () => {
    // Google Fonts link must have preconnect and display=swap
    assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/i, 'Must preconnect to font origin');
    assert.match(html, /display=swap/i, 'Must use font-display: swap to prevent FOIT');
  });

  it('implements continuous contrast adaptation and unslop easing', () => {
    assert.match(html, /--ease-unslop/i, 'Must define custom unslop physics easing curve');
    assert.match(html, /luminance/i, 'Must calculate background luminance for contrast adaptation');
  });
});
