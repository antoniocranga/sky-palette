/** HTTP plumbing shared by every route: JSON, errors, headers, request ids. */

export interface RequestContext {
  requestId: string;
  startedAt: number;
}

export function createRequestContext(request: Request): RequestContext {
  const incoming = request.headers.get("cf-ray");
  return {
    requestId: incoming ?? crypto.randomUUID(),
    startedAt: Date.now(),
  };
}

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Robots-Tag": "noindex, nofollow",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function errorResponse(
  status: number,
  message: string,
  context: RequestContext,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(
    {
      success: false,
      error: message,
      statusCode: status,
      requestId: context.requestId,
    },
    status,
    { "Cache-Control": "no-store", ...extraHeaders },
  );
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function numberParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `Parameter out of range: expected ${min}..${max}`);
  }
  return parsed;
}

export function stringParam(value: string | null, fallback: string, maxLength = 64): string {
  if (value === null) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (trimmed.length > maxLength) throw new HttpError(400, "Parameter too long");
  return trimmed;
}

/** Integer parameter with an inclusive range and a default. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `Parameter out of range: expected ${min}..${max}`);
  }
  return parsed;
}

/** Required latitude/longitude pair, both range-checked. */
export function coordinatesParam(latValue: string | null, lonValue: string | null): { lat: number; lon: number } {
  if (latValue === null || lonValue === null || latValue.trim() === "" || lonValue.trim() === "") {
    throw new HttpError(400, "Missing location: lat and lon are required");
  }
  return {
    lat: numberParam(latValue, 0, -90, 90),
    lon: numberParam(lonValue, 0, -180, 180),
  };
}

/**
 * Free text from an untrusted source: control characters removed, collapsed
 * whitespace, hard length cap. Never used as Markdown or HTML.
 */
export function freeText(value: string | null, maxLength: number, fallback = ""): string {
  if (value === null) return fallback;
  // eslint-disable-next-line no-control-regex -- deliberate: strip control chars
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, maxLength);
}

export function isoInstant(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, "Invalid ISO timestamp");
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) throw new HttpError(400, "Timestamp outside the supported range");
  return parsed;
}

/** Cache a successful response at the edge for `seconds`. */
export function withEdgeCache(response: Response, seconds: number): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=300`);
  return new Response(response.body, { status: response.status, headers });
}

export function logEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}


/**
 * Branded HTML error page for non-API routes. Deliberately dependency-free and
 * inline-styled so it renders even if the asset bundle is unavailable.
 */
export function htmlErrorResponse(status: number, context: RequestContext): Response {
  const title = status === 404 ? "Page not found" : "Something went wrong";
  const message =
    status === 404
      ? "That page drifted away. Head back to the live palette."
      : "The sky service hit an unexpected error. Please try again in a moment.";
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex"><title>${title} — Sky Palette</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:grid;place-items:center;padding:2rem;background:radial-gradient(ellipse 90% 50% at 50% 110%,#943440 0%,transparent 60%),#090b10;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}main{max-width:26rem}.code{font-family:ui-monospace,Menlo,monospace;font-size:.75rem;letter-spacing:.2em;color:#fca5a5;margin:0 0 1rem}h1{font-size:1.6rem;line-height:1.2;margin:0 0 .75rem}p{margin:0 0 1.5rem;color:#cbd5e1}a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 1.5rem;border-radius:9999px;background:#f8fafc;color:#090b10;font-weight:600;text-decoration:none}</style>
</head><body><main><p class="code">${status} · SKY PALETTE</p><h1>${title}</h1><p>${message}</p><a href="/">Back to the sky</a><p style="margin-top:1.25rem;font-size:.7rem;color:#64748b">Request ${context.requestId.slice(0, 12)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}
