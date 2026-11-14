/**
 * Fonts for the Open Graph card.
 *
 * Satori (behind workers-og) supports TTF/OTF/WOFF, not WOFF2, so the two
 * latin WOFF subsets are bundled as assets and inlined by Vite. Embedding them
 * keeps OG generation free of third-party runtime requests and deterministic.
 *
 * Licences: Playfair Display and JetBrains Mono are both SIL Open Font License
 * 1.1; the files come from the `@fontsource` packages this project already uses.
 */

import playfairInline from "../assets/og-playfair-600.woff?inline";
import monoInline from "../assets/og-jetbrains-mono-500.woff?inline";

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 500 | 600;
  style: "normal";
}

function decodeDataUri(uri: string): ArrayBuffer {
  const marker = ";base64,";
  const index = uri.indexOf(marker);
  const base64 = index >= 0 ? uri.slice(index + marker.length) : uri;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export const OG_FONTS: OgFont[] = [
  { name: "Playfair Display", data: decodeDataUri(playfairInline), weight: 600, style: "normal" },
  { name: "JetBrains Mono", data: decodeDataUri(monoInline), weight: 500, style: "normal" },
];
