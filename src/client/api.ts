/**
 * Typed API client. Same-origin requests only: no third-party calls.
 *
 * Every call is abortable and bounded by a timeout. Non-2xx responses, network
 * failures and `{success:false}` bodies are normalised into `ApiError`, so the
 * UI can show a retry state instead of a blank screen.
 */

import type {
  CitiesResponse,
  City,
  ConfigResponse,
  GalleryPhoto,
  GalleryResponse,
  HistoryResponse,
  PaletteResponse,
  SubmissionResponse,
} from "../shared/types";
import { reportNetworkFailure, reportNetworkSuccess } from "./lib/network";
import type { GalleryOrder, GallerySortKey } from "./lib/gallery-sort";

export type ApiErrorCode = "http" | "network" | "timeout" | "aborted" | "invalid";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string | null;

  constructor(message: string, status = 0, code: ApiErrorCode = "network", requestId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type AppConfig = Omit<ConfigResponse, "success">;

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Re-runs the action behind this request when the user taps Retry. */
  retry?: () => void;
}

export interface LocationMatch {
  city: City;
  distanceKm: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

async function requestJson<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  // Failures are tracked per endpoint, so a success elsewhere (config, a cached
  // palette) cannot hide the fact that this request is still unreachable.
  const networkKey = path.split("?")[0] ?? path;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let callerAborted = false;

  const onCallerAbort = (): void => {
    callerAborted = true;
    controller.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      throw new ApiError("Aborted", 0, "aborted");
    }
    options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const record = isRecord(payload) ? payload : null;
    const failureMessage = record && typeof record.error === "string" ? record.error : null;
    const requestId = record && typeof record.requestId === "string" ? record.requestId : null;

    if (!response.ok) {
      throw new ApiError(
        failureMessage ?? httpMessage(response.status),
        response.status,
        "http",
        requestId,
      );
    }

    if (!record) {
      throw new ApiError("The sky service returned an empty response.", 502, "invalid");
    }

    if (record.success === false) {
      throw new ApiError(failureMessage ?? "The sky service rejected the request.", response.status, "invalid", requestId);
    }

    reportNetworkSuccess(networkKey);
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (callerAborted || options.signal?.aborted) {
      throw new ApiError("Aborted", 0, "aborted");
    }

    if (controller.signal.aborted) {
      throw new ApiError("The sky service took too long to answer.", 0, "timeout");
    }

    reportNetworkFailure(networkKey, options.retry ?? null);
    throw new ApiError("No network connection to the sky service.", 0, "network");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function httpMessage(status: number): string {
  switch (status) {
    case 400:
      return "That request was not valid.";
    case 403:
      return "Verification failed.";
    case 404:
      return "That sky endpoint is not available yet.";
    case 413:
      return "That photo is too large.";
    case 429:
      return "Too many requests. Please wait a moment.";
    default:
      return "The sky service could not answer.";
  }
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export async function getConfig(options: RequestOptions = {}): Promise<AppConfig> {
  const payload = await requestJson<ConfigResponse>("/api/config", {}, { ...options, timeoutMs: 6000 });
  return {
    turnstileSiteKey: payload.turnstileSiteKey,
    appUrl: payload.appUrl,
    version: payload.version,
  };
}

export interface PaletteQuery {
  lat: number;
  lon: number;
  at: Date | string;
  timeZone: string;
}

export async function getPalette(queryParams: PaletteQuery, options: RequestOptions = {}): Promise<PaletteResponse> {
  const at = queryParams.at instanceof Date ? queryParams.at.toISOString() : queryParams.at;
  const search = query({
    lat: queryParams.lat.toFixed(4),
    lon: queryParams.lon.toFixed(4),
    at,
    tz: queryParams.timeZone,
  });
  return requestJson<PaletteResponse>(`/api/palette?${search}`, {}, options);
}

export interface HistoryQuery {
  lat: number;
  lon: number;
  days: number;
  timeZone: string;
}

export async function getHistory(queryParams: HistoryQuery, options: RequestOptions = {}): Promise<HistoryResponse> {
  const search = query({
    lat: queryParams.lat.toFixed(4),
    lon: queryParams.lon.toFixed(4),
    days: queryParams.days,
    tz: queryParams.timeZone,
  });
  return requestJson<HistoryResponse>(`/api/history?${search}`, {}, options);
}

export async function searchCities(searchQuery: string, options: RequestOptions = {}): Promise<City[]> {
  const search = query({ q: searchQuery.trim() });
  const payload = await requestJson<CitiesResponse>(`/api/cities?${search}`, {}, { ...options, timeoutMs: 8000 });
  return payload.results;
}

export interface HandleCheck {
  handle: string;
  valid: boolean;
  available?: boolean;
  reason?: string;
}

export async function checkHandle(handle: string, options: RequestOptions = {}): Promise<HandleCheck> {
  const search = query({ handle: handle.trim() });
  return requestJson<HandleCheck>(`/api/handles/check?${search}`, {}, { ...options, timeoutMs: 6000 });
}

/** Exact D1 slug lookup, with no geocoder call. */
export async function getCityBySlug(slug: string, options: RequestOptions = {}): Promise<City | null> {
  const search = query({ slug: slug.trim() });
  const payload = await requestJson<CitiesResponse>(`/api/cities?${search}`, {}, { ...options, timeoutMs: 8000 });
  return payload.results[0] ?? null;
}

export async function getLocation(lat: number, lon: number, options: RequestOptions = {}): Promise<LocationMatch | null> {
  const search = query({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
  const payload = await requestJson<{ success: true; match: LocationMatch | null }>(
    `/api/location?${search}`,
    {},
    { ...options, timeoutMs: 8000 },
  );
  return payload.match;
}

export interface GalleryQueryOptions extends RequestOptions {
  sort?: GallerySortKey;
  order?: GalleryOrder;
}

export async function getGalleryPage(
  lat: number,
  lon: number,
  cursor: string | null = null,
  limit = 6,
  options: GalleryQueryOptions = {},
): Promise<GalleryResponse> {
  const search = query({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    limit: String(limit),
    ...(cursor ? { cursor } : {}),
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.order ? { order: options.order } : {}),
  });
  return requestJson<GalleryResponse>(`/api/gallery?${search}`, {}, options);
}

export async function getGallery(lat: number, lon: number, options: RequestOptions = {}): Promise<GalleryPhoto[]> {
  const payload = await getGalleryPage(lat, lon, null, 12, options);
  return payload.photos;
}

async function getPhotoFromSearch(search: string, options: RequestOptions): Promise<GalleryPhoto | null> {
  try {
    const payload = await requestJson<{ success: true; photo: GalleryPhoto }>(`/api/photo?${search}`, {}, options);
    return payload.photo;
  } catch {
    return null;
  }
}

/** Legacy deep links: `?photo=<id>`. */
export async function getPhoto(id: string, options: RequestOptions = {}): Promise<GalleryPhoto | null> {
  return getPhotoFromSearch(query({ id }), options);
}

/** Share links address a photo by its contributor handle. */
export async function getPhotoByHandle(handle: string, options: RequestOptions = {}): Promise<GalleryPhoto | null> {
  return getPhotoFromSearch(query({ handle }), options);
}

export async function submitPhoto(formData: FormData, options: RequestOptions = {}): Promise<SubmissionResponse> {
  return requestJson<SubmissionResponse>(
    "/api/submit",
    {
      method: "POST",
      body: formData,
    },
    { ...options, timeoutMs: 45_000 },
  );
}
