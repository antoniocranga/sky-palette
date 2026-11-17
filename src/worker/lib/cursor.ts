/**
 * Opaque gallery pagination cursors.
 *
 * A cursor is `timestamp|id` — the sort column value and the row id of the
 * last photo on the previous page — encoded as unpadded base64url so it stays
 * a single URL-safe token. Carrying the id makes the cursor a total order:
 * rows that share a timestamp can never be skipped or repeated between pages.
 *
 * The client must treat the string as opaque; the format may change.
 */

export interface GalleryCursor {
  /** The value of the chosen sort column, as stored (an ISO 8601 instant). */
  timestamp: string;
  /** The row id, the tiebreaker in the tuple comparison. */
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 256;

export function encodeCursor(timestamp: string, id: string): string {
  return base64UrlEncode(`${timestamp}|${id}`);
}

/** Returns null for anything that is not a well-formed cursor this Worker issued. */
export function decodeCursor(raw: string): GalleryCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  if (!BASE64URL_PATTERN.test(raw)) return null;

  const decoded = base64UrlDecode(raw);
  if (decoded === null) return null;

  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;

  const timestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!UUID_PATTERN.test(id)) return null;
  if (Number.isNaN(Date.parse(timestamp))) return null;

  return { timestamp, id };
}

function base64UrlEncode(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  // A base64 body can never leave a single leftover character.
  if (value.length % 4 === 1) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    return null;
  }
}
