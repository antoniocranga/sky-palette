/**
 * Deep-link grammar for one shared community photo.
 *
 * A photo is addressed by its contributor handle (`?tag=sky-bucharest-48b`),
 * which is stable and readable, instead of its opaque row id. Legacy
 * `?photo=<id>` links keep working: the modal resolves either parameter.
 */

export const PHOTO_TAG_PARAM = "tag";
export const PHOTO_ID_PARAM = "photo";

export interface PhotoDeepLink {
  /** Contributor handle from `?tag=`, without a leading @. */
  handle: string | null;
  /** Legacy `?photo=<id>` value. */
  id: string | null;
}

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;

/** `@Sky-Bucharest-48B` -> `sky-bucharest-48b`; null when unusable. */
export function normalizeHandle(value: string | null | undefined): string | null {
  if (!value) return null;
  const handle = value.trim().replace(/^@+/, "").toLowerCase();
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

export function parsePhotoDeepLink(search: string): PhotoDeepLink {
  const params = new URLSearchParams(search);
  const rawId = params.get(PHOTO_ID_PARAM)?.trim() ?? "";
  return {
    handle: normalizeHandle(params.get(PHOTO_TAG_PARAM)),
    id: ID_PATTERN.test(rawId) ? rawId : null,
  };
}

/** `https://example.com/?tag=sky-bucharest-48b`; never includes the @. */
export function photoTagUrl(origin: string, handle: string): string {
  const normalized = normalizeHandle(handle) ?? handle.trim().replace(/^@+/, "").toLowerCase();
  return `${origin.replace(/\/+$/, "")}/?${PHOTO_TAG_PARAM}=${encodeURIComponent(normalized)}`;
}
