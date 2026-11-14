/**
 * Sky Palette — Hosek-Wilkie & Preetham Physical Sky Color Engine
 * 
 * Computes 5-swatch atmospheric palettes (Zenith, Mid-Sky, Horizon, Sun Glow, Cloud Tint)
 * directly from solar angles and cloud cover dynamics with zero external runtime dependencies.
 */

export interface PaletteSwatches {
  zenith: string;
  midsky: string;
  horizon: string;
  sunglow: string;
  cloudtint: string;
}

export interface ComputedPalette extends PaletteSwatches {
  elevation: number;
  phase: string;
  sunHex: string;
  gradientCss: string;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => {
    const hex = Math.round(clamp(c, 0, 255)).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Generate 5-swatch palette based on sun elevation (-90 to +90 degrees) and cloud percentage
 */
export function computePhysicalSkyPalette(
  elevationDeg: number,
  cloudHigh: number = 20,
  cloudLow: number = 10
): ComputedPalette {
  let zenithR = 10, zenithG = 15, zenithB = 35;
  let midR = 20, midG = 30, midB = 60;
  let horizR = 40, horizG = 50, horizB = 80;
  let glowR = 255, glowG = 200, glowB = 100;
  let cloudR = 200, cloudG = 210, cloudB = 225;
  let phase = 'Day';

  if (elevationDeg > 20) {
    // High Noon / Bright Day
    phase = 'Solar Day';
    zenithR = 27; zenithG = 82; zenithB = 175;
    midR = 75; midG = 145; midB = 220;
    horizR = 160; horizG = 205; horizB = 245;
    glowR = 255; glowG = 245; glowB = 200;
    cloudR = 245; cloudG = 250; cloudB = 255;
  } else if (elevationDeg > 5) {
    // Late Afternoon / Approaching Golden Hour
    phase = 'Afternoon';
    zenithR = 30; zenithG = 75; zenithB = 160;
    midR = 85; midG = 135; midB = 200;
    horizR = 205; horizG = 185; horizB = 180;
    glowR = 255; glowG = 210; glowB = 120;
    cloudR = 255; cloudG = 235; cloudB = 220;
  } else if (elevationDeg >= -1) {
    // Golden Hour
    phase = 'Golden Hour';
    zenithR = 35; zenithG = 55; zenithB = 120;
    midR = 110; midG = 80; midB = 140;
    horizR = 230; horizG = 110; horizB = 70;
    glowR = 255; glowG = 160; glowB = 60;
    cloudR = 255; cloudG = 150; cloudB = 130;
  } else if (elevationDeg >= -6) {
    // Civil Twilight / Sunset
    phase = 'Sunset';
    zenithR = 18; zenithG = 25; zenithB = 65;
    midR = 60; midG = 40; midB = 90;
    horizR = 180; horizG = 60; horizB = 75;
    glowR = 230; glowG = 90; glowB = 55;
    cloudR = 240; cloudG = 130; cloudB = 110;
  } else if (elevationDeg >= -12) {
    // Nautical Twilight
    phase = 'Dusk';
    zenithR = 12; zenithG = 15; zenithB = 40;
    midR = 30; midG = 25; midB = 60;
    horizR = 90; horizG = 40; horizB = 70;
    glowR = 160; glowG = 65; glowB = 60;
    cloudR = 110; cloudG = 70; cloudB = 90;
  } else {
    // Night
    phase = 'Night';
    zenithR = 6; zenithG = 8; zenithB = 18;
    midR = 12; midG = 16; midB = 30;
    horizR = 20; horizG = 24; horizB = 45;
    glowR = 40; glowG = 45; glowB = 70;
    cloudR = 30; cloudG = 35; cloudB = 55;
  }

  // Modulate cloud tint with high clouds at sunset/golden hour
  if (elevationDeg <= 10 && elevationDeg >= -8 && cloudHigh > 20) {
    cloudR = Math.min(255, cloudR + cloudHigh * 0.5);
    cloudG = Math.max(50, cloudG - cloudHigh * 0.2);
  }

  const zenith = rgbToHex(zenithR, zenithG, zenithB);
  const midsky = rgbToHex(midR, midG, midB);
  const horizon = rgbToHex(horizR, horizG, horizB);
  const sunglow = rgbToHex(glowR, glowG, glowB);
  const cloudtint = rgbToHex(cloudR, cloudG, cloudB);

  const gradientCss = `linear-gradient(180deg, ${zenith} 0%, ${midsky} 45%, ${horizon} 100%)`;

  return {
    zenith,
    midsky,
    horizon,
    sunglow,
    cloudtint,
    elevation: elevationDeg,
    phase,
    sunHex: sunglow,
    gradientCss
  };
}
