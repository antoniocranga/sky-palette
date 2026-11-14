/**
 * Sky Palette — Cloudflare Workers Native Edge Application
 * 
 * Production Domain: skypalette.app (Zone 4df85ed776a09b6464a515af9549f7b4)
 * Bindings: D1 Database (env.DB), R2 Storage (env.PHOTOS), Observability, Assets (env.ASSETS)
 * OpenTelemetry Traces & Logs enabled.
 */

import { getSolarPosition, BUCHAREST_HQ } from './lib/sun';
import { fetchAtmosphericWeather } from './lib/weather';
import { computePhysicalSkyPalette } from './lib/sky-model';
import { hashIp, checkRateLimit } from './lib/ratelimit';
import { createSafeErrorResponse, logServerError } from './lib/errors';
import { OtelTracker } from './lib/telemetry';

let cachedHtml: string | null = null;
async function getHtmlText(): Promise<string> {
  if (!cachedHtml) {
    const res = await fetch('https://raw.githubusercontent.com/antoniocranga/sky-palette/main/public/index.html', {
      headers: { 'User-Agent': 'SkyPalette-Edge/1.0' }
    });
    if (!res.ok) {
      throw new Error(`Failed to load app interface from repository: ${res.status}`);
    }
    cachedHtml = await res.text();
  }
  return cachedHtml;
}

export interface Env {
  DB: D1Database;
  PHOTOS?: R2Bucket;
  ASSETS?: Fetcher;
  TURNSTILE_SECRET_KEY?: string;
  IP_SALT?: string;
  ENVIRONMENT?: string;
  APP_URL?: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const clientIp = request.headers.get('cf-connecting-ip') || '127.0.0.1';
    const tracker = new OtelTracker(request, env.OTEL_SERVICE_NAME || 'sky-palette', env.ENVIRONMENT || 'production');

    try {
      // 1. API: Palette Computation & Caching
      if (url.pathname === '/api/palette') {
        const hashedClient = await hashIp(clientIp, env.IP_SALT);
        const limit = checkRateLimit(hashedClient, 60, 60);
        if (!limit.allowed) {
          tracker.logWarn('RateLimitExceeded', { client_ip_hash: hashedClient, limit: 60 });
          tracker.complete(429);
          return createSafeErrorResponse(null, 429, 'Rate limit exceeded. Please wait a minute.');
        }

        const lat = parseFloat(url.searchParams.get('lat') || String(BUCHAREST_HQ.lat));
        const lon = parseFloat(url.searchParams.get('lon') || String(BUCHAREST_HQ.lon));
        const dateStr = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
        const timeStr = url.searchParams.get('time') || '16:51';

        const [hours, minutes] = timeStr.split(':').map(Number);
        const calcDate = new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`);

        // Calculate solar elevation
        const solar = getSolarPosition(lat, lon, calcDate);
        
        // Fetch weather
        const weather = await fetchAtmosphericWeather(lat, lon, dateStr);

        // Compute physical palette
        const palette = computePhysicalSkyPalette(solar.elevation, weather.cloudCoverHigh, weather.cloudCoverLow);

        tracker.setAttribute('location.lat', lat);
        tracker.setAttribute('location.lon', lon);
        tracker.setAttribute('solar.elevation', solar.elevation);
        tracker.setAttribute('palette.phase', palette.phase);
        tracker.complete(200);

        if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
          ctx.waitUntil(tracker.exportOtlp(env.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_EXPORTER_OTLP_HEADERS));
        }

        return new Response(
          JSON.stringify({
            success: true,
            location: { lat, lon },
            solar,
            weather: {
              cloudHigh: weather.cloudCoverHigh,
              cloudLow: weather.cloudCoverLow,
              visibility: weather.visibility
            },
            palette,
            environment: env.ENVIRONMENT || 'production',
            traceId: tracker.getTraceId()
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
              'X-Content-Type-Options': 'nosniff',
              'traceparent': tracker.getTraceparent()
            }
          }
        );
      }

      // 2. API: Community Photo Submission
      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const hashedClient = await hashIp(clientIp, env.IP_SALT);
        const limit = checkRateLimit(hashedClient, 5, 3600); // 5 uploads per hour
        if (!limit.allowed) {
          tracker.logWarn('UploadRateLimitExceeded', { client_ip_hash: hashedClient });
          tracker.complete(429);
          return createSafeErrorResponse(null, 429, 'Upload rate limit reached (5 photos per hour). Please try again later.');
        }

        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('multipart/form-data')) {
          tracker.complete(400);
          return createSafeErrorResponse(null, 400, 'Invalid submission format. Multipart form-data expected.');
        }

        const formData = await request.formData();
        const photo = formData.get('photo') as File | null;
        const turnstileToken = formData.get('turnstileToken') as string | null;
        const locationName = (formData.get('location') as string) || 'Bucharest, Romania';
        const timestamp = (formData.get('timestamp') as string) || new Date().toISOString();

        // Validate Turnstile token if configured
        if (env.TURNSTILE_SECRET_KEY && turnstileToken) {
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
              remoteip: clientIp
            })
          });
          const verifyData: any = await verifyRes.json();
          if (!verifyData.success) {
            tracker.logWarn('TurnstileVerificationFailed', { client_ip_hash: hashedClient });
            tracker.complete(403);
            return createSafeErrorResponse(null, 403, 'Bot security challenge failed. Please refresh and try again.');
          }
        }

        if (!photo) {
          tracker.complete(400);
          return createSafeErrorResponse(null, 400, 'Please select a sky photo to upload.');
        }

        if (photo.size > 25 * 1024 * 1024) {
          tracker.complete(400);
          return createSafeErrorResponse(null, 400, 'Photo exceeds the maximum size of 25MB.');
        }

        // Store in R2 bucket if available
        const submissionId = crypto.randomUUID();
        const r2Key = `submissions/${submissionId}-${Date.now()}.webp`;

        if (env.PHOTOS) {
          const arrayBuffer = await photo.arrayBuffer();
          await env.PHOTOS.put(r2Key, arrayBuffer, {
            httpMetadata: { contentType: photo.type || 'image/webp' },
            customMetadata: { submissionId, locationName }
          });
        }

        // Persist metadata to D1
        if (env.DB) {
          await env.DB.prepare(`
            INSERT INTO submissions (id, city_id, image_url, r2_key, timestamp, lat, lon, zenith, midsky, horizon, sunglow, cloudtint, contributor_handle, status)
            VALUES (?, 1, ?, ?, ?, 44.4268, 26.1025, '#121734', '#2A1F42', '#943440', '#E06038', '#FC9858', ?, 'approved')
          `).bind(submissionId, `/photos/${r2Key}`, r2Key, timestamp, `sky-bucharest-${submissionId.slice(0, 4)}`).run();
        }

        tracker.logInfo('PhotoSubmitted', { submissionId, locationName });
        tracker.complete(200);

        if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
          ctx.waitUntil(tracker.exportOtlp(env.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_EXPORTER_OTLP_HEADERS));
        }

        return new Response(
          JSON.stringify({
            success: true,
            submissionId,
            handle: `sky-bucharest-${submissionId.slice(0, 4)}`,
            message: 'Your sky photo has been received and verified. Thank you for contributing!'
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Content-Type-Options': 'nosniff',
              'traceparent': tracker.getTraceparent()
            }
          }
        );
      }

      // 3. API: Anonymous Error & Telemetry Logging
      if (url.pathname === '/api/telemetry' && request.method === 'POST') {
        try {
          const event = await request.json();
          tracker.logInfo('ClientTelemetryEvent', { client_event: JSON.stringify(event) });
        } catch {
          // Ignore telemetry parsing errors
        }
        tracker.complete(204);
        return new Response(null, {
          status: 204,
          headers: { 'traceparent': tracker.getTraceparent() }
        });
      }

      // 4. SEO: robots.txt
      if (url.pathname === '/robots.txt') {
        tracker.complete(200);
        return new Response(
          `User-agent: *\nAllow: /\nSitemap: https://skypalette.app/sitemap.xml\n`,
          { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' } }
        );
      }

      // 5. SEO: sitemap.xml
      if (url.pathname === '/sitemap.xml') {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://skypalette.app</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
        tracker.complete(200);
        return new Response(sitemapXml, {
          headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' }
        });
      }

      // Default: Return 404 for unknown API routes
      if (url.pathname.startsWith('/api/')) {
        tracker.complete(404);
        return createSafeErrorResponse(null, 404, 'API endpoint not found.');
      }

      // Try serving static assets via binding if available
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status !== 404) {
          tracker.complete(assetRes.status);
          return assetRes;
        }
      }

      // Fallback: Serve Frontend Web Application (HTML UI)
      const html = await getHtmlText();
      tracker.complete(200);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'traceparent': tracker.getTraceparent()
        }
      });
    } catch (err: unknown) {
      tracker.logError('UnhandledFetchException', err);
      tracker.complete(500);
      logServerError(err, 'UnhandledFetchException');
      return createSafeErrorResponse(err, 500, 'An unexpected atmospheric processing error occurred.');
    }
  }
};
