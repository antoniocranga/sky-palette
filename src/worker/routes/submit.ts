/**
 * Community photo submission.
 *
 * Everything in this route is authoritative: Turnstile, the hourly quota, the
 * real image type and dimensions, metadata stripping, palette computation,
 * the R2 write and the D1 record. Nothing the browser says about the file is
 * trusted beyond the bytes themselves.
 */

import { computePalette } from "../../shared/palette";
import { getSolarPosition } from "../../shared/solar";
import type { SubmissionResponse } from "../../shared/types";
import { clientIpHash, type RouteHandler } from "../env";
import { generateHandle, photoKey, thumbKey } from "../lib/handle";
import { HttpError, jsonResponse, logEvent, type RequestContext } from "../lib/http";
import { enforceEdgeRateLimit, consumeQuota, pruneQuotas, quotaExceeded } from "../lib/rate-limit";
import {
  assertMaximumDimensions,
  assertMinimumDimensions,
  ImageError,
  inspectImage,
  stripMetadata,
  type ImageInfo,
} from "../lib/image";
import { verifyTurnstile } from "../lib/turnstile";
import { checkHandle, isHandleAvailable } from "./handles";
import { fetchWeatherAt } from "../lib/weather";

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const SIZE_LABEL = "30 MB";
/** Multipart framing overhead allowed on top of the photo itself. */
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 512 * 1024;
export const HOURLY_SUBMISSION_LIMIT = 5;
/** Storage guard: across all clients, per UTC day. */
export const DAILY_SUBMISSION_LIMIT = 2_000;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
const CITY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `FormData.get()` result in the Workers runtime. */
type FormDataValue = string | File;

export const handleSubmit: RouteHandler = async (request, env, ctx, context) => {
  // Kill switch: set the `UPLOADS_ENABLED` secret to "false" to pause uploads
  // without a deploy. Reads and the gallery stay up.
  if (env.UPLOADS_ENABLED === "false") {
    throw new HttpError(503, "Photo submissions are temporarily paused. Please try again later.", {
      "Retry-After": "3600",
    });
  }

  // Reject oversized bodies before buffering them, then stream with a hard cap
  // for chunked uploads that omit Content-Length.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, `Photo must be ${SIZE_LABEL} or smaller`);
  }

  const ipHash = await clientIpHash(request, env);
  await enforceEdgeRateLimit(env.SUBMIT_LIMITER, request, env, context, "submit");

  const form = await parseForm(request);

  const token = form.get("turnstileToken");
  await verifyTurnstile(typeof token === "string" ? token : "", request, env, context);

  const lat = formNumber(form.get("lat"), -90, 90, "lat");
  const lon = formNumber(form.get("lon"), -180, 180, "lon");
  const capturedAt = formInstant(form.get("capturedAt"));
  const citySlug = formCitySlug(form.get("citySlug"));
  const handle = await resolveHandle(env.DB, form.get("handle"), citySlug);

  // Explicit CC0/publication consent is required, and enforced server-side so a
  // script cannot skip the checkbox.
  if (form.get("consent") !== "true") {
    throw new HttpError(422, "Please confirm you own the photo and agree to publish it under CC0.");
  }

  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    throw new HttpError(400, "Missing photo");
  }
  if (photo.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `Photo must be ${SIZE_LABEL} or smaller`);
  }

  const original = new Uint8Array(await photo.arrayBuffer());
  if (original.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `Photo must be ${SIZE_LABEL} or smaller`);
  }

  // Only a request that passed Turnstile, field validation and the consent gate
  // may consume the hourly/global quota.
  await enforceHourlyQuota(env.DB, ipHash, context);

  const info = readImage(original);
  const cleaned = stripMetadata(original, info.format);

  const [weatherResult, solar] = await Promise.all([
    fetchWeatherAt(lat, lon, capturedAt, (promise) => ctx.waitUntil(promise)),
    Promise.resolve(getSolarPosition(lat, lon, capturedAt)),
  ]);

  const palette = computePalette({
    elevation: solar.elevation,
    cloudCoverLow: weatherResult.weather.cloudCoverLow,
    cloudCoverMid: weatherResult.weather.cloudCoverMid,
    cloudCoverHigh: weatherResult.weather.cloudCoverHigh,
    visibility: weatherResult.weather.visibility,
  });

  const key = photoKey(capturedAt, info.extension);
  const stored = await storePhoto(env, key, cleaned, info);

  // Optional 400 px grid variant. A failed or invalid thumb must never fail the
  // submission; the gallery falls back to the full image.
  const thumb = await readThumb(form.get("thumb"));
  let storedThumbKey: string | null = null;
  if (thumb) {
    const candidate = thumbKey(capturedAt, thumb.info.extension);
    try {
      await storePhoto(env, candidate, thumb.bytes, thumb.info);
      storedThumbKey = candidate;
    } catch (error) {
      logEvent("warn", "submit.thumb_failed", {
        requestId: context.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO submissions (
         id, city_slug, handle, r2_key, thumb_key, content_type, bytes, width, height,
         captured_at, lat, lon, palette_json, status, ip_hash, created_at, consent_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(
        id,
        citySlug,
        handle,
        key,
        storedThumbKey,
        info.contentType,
        cleaned.length,
        info.width,
        info.height,
        capturedAt.toISOString(),
        lat,
        lon,
        JSON.stringify(palette),
        ipHash,
        createdAt,
        createdAt,
      )
      .run();
  } catch (error) {
    logEvent("error", "submit.persist_failed", {
      requestId: context.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    if (stored && env.PHOTOS) {
      try {
        await env.PHOTOS.delete(key);
        if (storedThumbKey) await env.PHOTOS.delete(storedThumbKey);
      } catch {
        // Best effort: an orphaned object is harmless, a broken submission is not.
      }
    }
    throw new HttpError(500, "Could not record the submission. Please try again.");
  }

  const body: SubmissionResponse = {
    success: true,
    submissionId: id,
    handle,
    status: "pending",
    url: stored ? `/api/photos/${key}` : null,
  };

  logEvent("info", "submit.accepted", {
    requestId: context.requestId,
    submissionId: id,
    citySlug,
    width: info.width,
    height: info.height,
    bytes: cleaned.length,
    format: info.format,
    strippedBytes: original.length - cleaned.length,
    degraded: weatherResult.degraded,
    durationMs: Date.now() - context.startedAt,
  });

  // Housekeeping off the critical path: drop counters no window can reference.
  ctx.waitUntil(pruneQuotas(env.DB));

  return jsonResponse(body, 201, { "Cache-Control": "no-store" });
};

/**
 * Two authoritative quotas, both atomic in D1:
 * - five uploads per hour per hashed client;
 * - a global daily ceiling so distributed abuse cannot fill the bucket.
 */
async function enforceHourlyQuota(db: D1Database, ipHash: string, context: RequestContext): Promise<void> {
  const perClient = await consumeQuota(db, {
    key: `submit:${ipHash}`,
    limit: HOURLY_SUBMISSION_LIMIT,
    windowSeconds: HOUR_SECONDS,
  });
  if (!perClient.allowed) {
    quotaExceeded(perClient, "Upload limit reached. You can submit again in an hour.", context, "submit.client");
  }

  const global = await consumeQuota(db, {
    key: "submit:global",
    limit: DAILY_SUBMISSION_LIMIT,
    windowSeconds: DAY_SECONDS,
  });
  if (!global.allowed) {
    quotaExceeded(
      global,
      "Submissions are paused for today to protect storage. Please try again tomorrow.",
      context,
      "submit.global",
    );
  }
}

async function parseForm(request: Request): Promise<FormData> {
  if (!request.body) throw new HttpError(400, "Expected multipart/form-data");

  // Read with a cap so a chunked upload cannot exhaust the isolate's memory.
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, `Photo must be ${SIZE_LABEL} or smaller`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Expected multipart/form-data");
  }

  const contentType = request.headers.get("content-type") ?? "";
  try {
    const body = new Blob(chunks);
    // Drop our references so the isolate is not holding two copies while the
    // multipart parser and the image pipeline allocate their own.
    chunks.length = 0;
    const rebuilt = new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    return await rebuilt.formData();
  } catch {
    throw new HttpError(400, "Expected multipart/form-data");
  }
}

function formNumber(value: FormDataValue | null, min: number, max: number, name: string): number {
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = Number(text);
  if (text === "" || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return parsed;
}

function formInstant(value: FormDataValue | null): Date {
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = new Date(text);
  if (text === "" || Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, "Invalid capturedAt");
  }
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) {
    throw new HttpError(400, "capturedAt outside the supported range");
  }
  return parsed;
}

/**
 * A user-chosen tag wins if it is valid and unused; otherwise a generated
 * handle is retried until it is free, so shared links stay unambiguous.
 */
async function resolveHandle(db: D1Database, value: FormDataValue | null, citySlug: string | null): Promise<string> {
  const requested = typeof value === "string" ? value.trim() : "";
  if (requested) {
    const checked = await checkHandle(db, requested);
    if (!checked.ok) {
      throw new HttpError(checked.reason === "taken" ? 409 : 422, "That tag is not available. Try another one.");
    }
    return checked.handle;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateHandle(citySlug);
    if (await isHandleAvailable(db, candidate)) return candidate;
  }
  // Extremely unlikely; timestamp suffix keeps the insert valid.
  return `${generateHandle(citySlug)}-${Date.now().toString(36).slice(-3)}`.slice(0, 24);
}

function formCitySlug(value: FormDataValue | null): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  if (slug === "") return null;
  if (slug.length > 80 || !CITY_SLUG_PATTERN.test(slug)) {
    throw new HttpError(400, "Invalid citySlug");
  }
  return slug;
}

async function readThumb(value: FormDataValue | null): Promise<{ bytes: Uint8Array; info: ImageInfo } | null> {
  if (!(value instanceof File) || value.size === 0) return null;
  if (value.size > 2 * 1024 * 1024) return null;
  try {
    const bytes = new Uint8Array(await value.arrayBuffer());
    const info = inspectImage(bytes);
    if (info.shortSide < 200) return null;
    assertMaximumDimensions(info);
    return { bytes: stripMetadata(bytes, info.format), info };
  } catch {
    return null;
  }
}

function readImage(bytes: Uint8Array): ImageInfo {
  try {
    const info = inspectImage(bytes);
    assertMinimumDimensions(info);
    assertMaximumDimensions(info);
    return info;
  } catch (error) {
    if (error instanceof ImageError) {
      if (error.code === "unsupported") throw new HttpError(415, "Unsupported image format. Use JPEG, PNG or WebP.");
      if (error.code === "too_small" || error.code === "too_large") throw new HttpError(422, error.message);
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

async function storePhoto(env: { PHOTOS?: R2Bucket }, key: string, bytes: Uint8Array, info: ImageInfo): Promise<boolean> {
  if (!env.PHOTOS) {
    logEvent("warn", "submit.storage_unbound", { key });
    return false;
  }

  try {
    await env.PHOTOS.put(key, bytes, {
      httpMetadata: {
        contentType: info.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    return true;
  } catch (error) {
    logEvent("error", "submit.storage_failed", {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(503, "Photo storage is temporarily unavailable. Please try again.");
  }
}
