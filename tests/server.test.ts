import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSolarPosition, BUCHAREST_HQ } from '../src/lib/sun.ts';
import { computePhysicalSkyPalette } from '../src/lib/sky-model.ts';
import { hashIp, checkRateLimit } from '../src/lib/ratelimit.ts';
import { createSafeErrorResponse } from '../src/lib/errors.ts';
import { OtelTracker } from '../src/lib/telemetry.ts';

describe('Server-Side Astronomy & Physical Sky Palette Engine', () => {
  it('calculates correct solar position for Bucharest HQ', () => {
    // Summer noon in Bucharest (high sun elevation)
    const summerNoon = new Date('2026-06-21T10:00:00Z');
    const pos = getSolarPosition(BUCHAREST_HQ.lat, BUCHAREST_HQ.lon, summerNoon);

    assert.ok(pos.elevation > 50, `Expected summer noon elevation > 50°, got ${pos.elevation}°`);
    assert.ok(pos.azimuth >= 0 && pos.azimuth <= 360, `Azimuth out of range: ${pos.azimuth}°`);
    assert.strictEqual(
      parseFloat((pos.elevation + pos.zenith).toFixed(2)),
      90,
      'Elevation + Zenith must equal 90°'
    );
  });

  it('calculates negative solar elevation at midnight', () => {
    const winterMidnight = new Date('2026-12-21T22:00:00Z');
    const pos = getSolarPosition(BUCHAREST_HQ.lat, BUCHAREST_HQ.lon, winterMidnight);

    assert.ok(pos.elevation < -30, `Expected midnight elevation < -30°, got ${pos.elevation}°`);
    assert.ok(pos.zenith > 120, `Expected midnight zenith > 120°, got ${pos.zenith}°`);
  });

  it('computes 5 valid hexadecimal color swatches across all sky phases', () => {
    const hexPattern = /^#[0-9a-fA-F]{6}$/;

    // Test Solar Day (> 20°)
    const dayPalette = computePhysicalSkyPalette(35, 10, 5);
    assert.strictEqual(dayPalette.phase, 'Solar Day');
    assert.match(dayPalette.zenith, hexPattern);
    assert.match(dayPalette.midsky, hexPattern);
    assert.match(dayPalette.horizon, hexPattern);
    assert.match(dayPalette.sunglow, hexPattern);
    assert.match(dayPalette.cloudtint, hexPattern);
    assert.ok(dayPalette.gradientCss.includes('linear-gradient'));

    // Test Golden Hour (-1° to 5°)
    const goldenPalette = computePhysicalSkyPalette(2, 20, 10);
    assert.strictEqual(goldenPalette.phase, 'Golden Hour');
    assert.match(goldenPalette.sunglow, hexPattern);

    // Test Sunset (-6° to -1°)
    const sunsetPalette = computePhysicalSkyPalette(-3, 30, 20);
    assert.strictEqual(sunsetPalette.phase, 'Sunset');

    // Test Dusk (-12° to -6°)
    const duskPalette = computePhysicalSkyPalette(-9, 10, 10);
    assert.strictEqual(duskPalette.phase, 'Dusk');

    // Test Night (<= -12°)
    const nightPalette = computePhysicalSkyPalette(-25, 0, 0);
    assert.strictEqual(nightPalette.phase, 'Night');
  });

  it('adjusts cloud tint based on high and low cloud cover', () => {
    const clearSunset = computePhysicalSkyPalette(0, 0, 0);
    const cloudySunset = computePhysicalSkyPalette(0, 80, 50);

    // Cloud tint should differ between clear and overcast skies
    assert.notStrictEqual(clearSunset.cloudtint, cloudySunset.cloudtint);
  });
});

describe('Privacy-Preserving Salted Rate Limiting', () => {
  it('produces a fixed-length SHA-256 hash without exposing the raw IP', async () => {
    const ip = '198.51.100.42';
    const salt = 'test-secret-salt-xyz';
    const hash1 = await hashIp(ip, salt);
    const hash2 = await hashIp(ip, salt);

    assert.strictEqual(hash1, hash2, 'Hash must be deterministic for identical inputs');
    assert.strictEqual(hash1.length, 32, 'Expected 32-character truncated hex hash');
    assert.ok(!hash1.includes(ip), 'Hash must never contain raw IP substring');
  });

  it('enforces request limits within the time window', () => {
    const clientKey = 'client-test-rate-limit-' + Date.now();
    const limit = 3;
    const windowSec = 60;

    // Requests 1, 2, 3 should be allowed
    const r1 = checkRateLimit(clientKey, limit, windowSec);
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 2);

    const r2 = checkRateLimit(clientKey, limit, windowSec);
    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);

    const r3 = checkRateLimit(clientKey, limit, windowSec);
    assert.strictEqual(r3.allowed, true);
    assert.strictEqual(r3.remaining, 0);

    // Request 4 must be blocked
    const r4 = checkRateLimit(clientKey, limit, windowSec);
    assert.strictEqual(r4.allowed, false);
    assert.strictEqual(r4.remaining, 0);
  });
});

describe('Error Sanitization & Safe Responses', () => {
  it('formats clean JSON error responses without leaking stack traces or internal errors', async () => {
    const internalError = new Error('FATAL: SQLite disk I/O error or constraint violation at line 42');
    const res = createSafeErrorResponse(internalError, 500);

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
    assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');

    const body = await res.json() as any;
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.statusCode, 500);
    assert.strictEqual(body.error, 'Atmospheric processing failed. Please try again later.');
    assert.strictEqual(body.stack, undefined, 'Stack trace must not be leaked');
    assert.ok(body.timestamp, 'Timestamp should be included');
  });

  it('handles client errors with safe user guidance', async () => {
    const res429 = createSafeErrorResponse(null, 429);
    const body429 = await res429.json() as any;
    assert.strictEqual(res429.status, 429);
    assert.strictEqual(body429.error, 'Too many requests. Please wait a moment before trying again.');

    const res403 = createSafeErrorResponse(null, 403);
    const body403 = await res403.json() as any;
    assert.strictEqual(res403.status, 403);
    assert.strictEqual(body403.error, 'Verification failed. Please complete the security check.');
  });
});

describe('OpenTelemetry Tracing & Observability', () => {
  it('generates valid W3C traceparent headers', () => {
    const req = new Request('https://skypalette.app/api/palette');
    const tracker = new OtelTracker(req, 'sky-palette', 'production');

    const traceparent = tracker.getTraceparent();
    assert.match(traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/, 'Must match W3C traceparent regex');
  });

  it('inherits existing traceId from incoming W3C traceparent', () => {
    const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const incomingParent = `00-${incomingTraceId}-00f067aa0ba902b7-01`;
    const req = new Request('https://skypalette.app/api/palette', {
      headers: { 'traceparent': incomingParent }
    });

    const tracker = new OtelTracker(req);
    assert.strictEqual(tracker.getTraceId(), incomingTraceId, 'Must propagate incoming traceId');
  });
});
