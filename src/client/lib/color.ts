/**
 * Thin client re-export of the shared colour engine.
 *
 * The client deliberately does not reimplement colour maths: the same
 * functions run inside the Worker, so a swatch copied from the browser is the
 * swatch the API computes.
 */

export {
  hexToRgb,
  rgbToHex,
  mix,
  clamp,
  clamp01,
  relativeLuminance,
  contrastRatio,
  readableTextColor,
  type Rgb,
} from "../../shared/color";
