/**
 * Sky Palette — Error Tracking & Graceful Handling
 * 
 * Sanitizes and handles errors without leaking raw stack traces, database schema,
 * or server environment details to clients.
 */

export interface ErrorReport {
  message: string;
  source?: string;
  timestamp: string;
  environment: string;
}

/**
 * Cleanly format error responses for the browser without technical jargon or stack traces
 */
export function createSafeErrorResponse(
  error: unknown,
  status: number = 500,
  userFriendlyMessage?: string
): Response {
  const isDev = false;
  let clientMessage = userFriendlyMessage || 'Atmospheric processing failed. Please try again later.';
  
  if (status === 429) {
    clientMessage = 'Too many requests. Please wait a moment before trying again.';
  } else if (status === 400) {
    clientMessage = userFriendlyMessage || 'Invalid request parameters.';
  } else if (status === 403) {
    clientMessage = 'Verification failed. Please complete the security check.';
  } else if (status === 404) {
    clientMessage = userFriendlyMessage || 'The requested sky palette could not be found.';
  }

  // Safe JSON error response
  return new Response(
    JSON.stringify({
      success: false,
      error: clientMessage,
      statusCode: status,
      timestamp: new Date().toISOString()
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      }
    }
  );
}

/**
 * Log an error to Cloudflare Observability / Worker logs without personal data
 */
export function logServerError(error: unknown, context: string): void {
  const timestamp = new Date().toISOString();
  if (error instanceof Error) {
    console.error(`[${timestamp}] [SkyPalette:${context}] ${error.name}: ${error.message}`);
  } else {
    console.error(`[${timestamp}] [SkyPalette:${context}] Unknown error:`, error);
  }
}
