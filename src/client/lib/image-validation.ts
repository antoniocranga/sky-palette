/**
 * Pure client-side upload validation, mirroring the Worker's image contract.
 *
 * The format is read from the file's magic bytes, not its extension or MIME
 * type, so renamed GIF/HEIC files are rejected before any decode.
 */

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MIN_SHORT_SIDE = 400;
export const MAX_DIMENSION = 12_000;

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageValidationInput {
  size: number;
  /** First bytes of the file, at least 12. */
  header: Uint8Array;
  width: number;
  height: number;
}

export type ImageValidation =
  | { ok: true; format: ImageFormat }
  | { ok: false; code: "format" | "size" | "dimensions"; message: string };

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/** Decoded container type from magic bytes only. */
export function detectImageFormat(header: Uint8Array): ImageFormat | null {
  if (startsWith(header, JPEG_SIGNATURE)) return "jpeg";
  if (startsWith(header, PNG_SIGNATURE)) return "png";
  if (startsWith(header, RIFF_SIGNATURE) && startsWith(header, WEBP_SIGNATURE, 8)) return "webp";
  return null;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validation order is part of the contract: format, then size, then decoded
 * dimensions. Callers decode dimensions only after the first two checks pass.
 */
export function validateImage(input: ImageValidationInput): ImageValidation {
  const format = detectImageFormat(input.header);
  if (!format) {
    return {
      ok: false,
      code: "format",
      message: "That file is not a supported image — choose a JPEG, PNG or WebP.",
    };
  }

  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, code: "size", message: "That file is empty — choose a photo." };
  }

  if (input.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "size",
      message: `That photo is ${formatMegabytes(input.size)} — the limit is 30 MB.`,
    };
  }

  if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width < 1 || input.height < 1) {
    return {
      ok: false,
      code: "dimensions",
      message: "That image has no readable dimensions — try another photo.",
    };
  }

  const shortSide = Math.min(input.width, input.height);
  if (shortSide < MIN_SHORT_SIDE) {
    return {
      ok: false,
      code: "dimensions",
      message: `That image is ${input.width}×${input.height} px — it needs at least 400 px on the short side.`,
    };
  }

  if (input.width > MAX_DIMENSION || input.height > MAX_DIMENSION) {
    return {
      ok: false,
      code: "dimensions",
      message: `That image is ${input.width}×${input.height} px — the maximum is 12000 px on either side.`,
    };
  }

  return { ok: true, format };
}
