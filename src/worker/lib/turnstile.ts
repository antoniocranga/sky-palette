/**
 * Turnstile verification.
 *
 * The secret never leaves the Worker. When it is not provisioned (local dev,
 * preview) the check is skipped with a warning rather than blocking the app.
 */

import { clientIp, type Env } from "../env";
import { HttpError, logEvent, type RequestContext } from "./http";

const SITEVERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

export async function verifyTurnstile(
  token: string,
  request: Request,
  env: Env,
  context: RequestContext,
): Promise<void> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    logEvent("warn", "turnstile.secret_missing", { requestId: context.requestId });
    return;
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  const ip = clientIp(request);
  if (ip) form.set("remoteip", ip);

  let payload: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_ENDPOINT, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Siteverify ${response.status}`);
    payload = (await response.json()) as SiteverifyResponse;
  } catch (error) {
    logEvent("error", "turnstile.verify_unavailable", {
      requestId: context.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(503, "Verification is temporarily unavailable. Please try again.");
  }

  if (payload.success !== true) {
    logEvent("warn", "turnstile.rejected", {
      requestId: context.requestId,
      codes: payload["error-codes"] ?? [],
    });
    throw new HttpError(403, "Bot verification failed");
  }
}
