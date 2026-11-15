/** Anonymous contributor handles and R2 object keys. */

const HANDLE_ALPHABET = "0123456789abcdef";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** `bytes` random bytes as lowercase hex (2 characters per byte). */
function randomHex(byteLength: number): string {
  return [...randomBytes(byteLength)]
    .map((byte) => `${HANDLE_ALPHABET[(byte >> 4) & 0x0f] ?? "0"}${HANDLE_ALPHABET[byte & 0x0f] ?? "0"}`)
    .join("");
}

/**
 * Turns a city slug into the short noun used in handles:
 * "cluj-napoca-romania" -> "cluj".
 */
export function cityToken(citySlug: string | null): string {
  if (!citySlug) return "earth";
  const first = citySlug.split("-")[0] ?? "";
  const token = first.replace(/[^a-z0-9]/g, "").slice(0, 24);
  return token.length >= 3 ? token : "earth";
}

/** `sky-bucharest-48bf` — anonymous, stable for the record, not a user id. */
export function generateHandle(citySlug: string | null): string {
  return `sky-${cityToken(citySlug)}-${randomHex(2)}`;
}

/** `photos/2026/11/<uuid>.jpg`. */
export function photoKey(capturedAt: Date, extension: string): string {
  const year = capturedAt.getUTCFullYear();
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  return `photos/${year}/${month}/${crypto.randomUUID()}.${extension}`;
}

/** `photos/2026/11/thumb-<uuid>.webp` — the grid variant. */
export function thumbKey(capturedAt: Date, extension: string): string {
  const year = capturedAt.getUTCFullYear();
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  return `photos/${year}/${month}/thumb-${crypto.randomUUID()}.${extension}`;
}
