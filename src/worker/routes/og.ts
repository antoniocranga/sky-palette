/**
 * Dynamic Open Graph card (1200x630 PNG).
 *
 * Query values are untrusted, so every string is escaped and truncated, and
 * colours only pass when they match a hex pattern. Missing colours are filled
 * from the deterministic palette engine rather than failing the request.
 */

import { ImageResponse } from "workers-og";
import { computePalette } from "../../shared/palette";
import { BUCHAREST, getSolarPosition } from "../../shared/solar";
import { clockInZone, isoDayInZone, isValidTimeZone, zonedTimeToUtc } from "../../shared/time";
import type { HexColor, Palette } from "../../shared/types";
import { readableTextColor } from "../../shared/color";
import type { RouteHandler } from "../env";
import { localSunset } from "../lib/daily-palettes";
import { freeText, numberParam } from "../lib/http";
import { enforceEdgeRateLimit } from "../lib/rate-limit";
import { OG_FONTS } from "../lib/og-font";

const WIDTH = 1200;
const HEIGHT = 630;

const HEX_6 = /^#[0-9a-f]{6}$/i;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SWATCHES = [
  ["zenith", "Zenith"],
  ["midsky", "Midsky"],
  ["horizon", "Horizon"],
  ["sunglow", "Sunglow"],
  ["cloudtint", "Cloud tint"],
] as const;

export const handleOg: RouteHandler = async (request, env, _ctx, context) => {
  await enforceEdgeRateLimit(env.OG_LIMITER, request, env, context, "og");

  const params = new URL(request.url).searchParams;

  const city = freeText(params.get("city"), 60, "Sky Palette");
  const requestedDate = params.get("date") ?? "";
  const date = isIsoDay(requestedDate) ? requestedDate : null;
  const requestedPhase = freeText(params.get("phase"), 24, "");

  const lat = numberParam(params.get("lat"), BUCHAREST.lat, -90, 90);
  const lon = numberParam(params.get("lon"), BUCHAREST.lon, -180, 180);
  const requestedZone = params.get("tz") ?? "";
  const timezone = requestedZone && requestedZone.length <= 64 && isValidTimeZone(requestedZone)
    ? requestedZone
    : "UTC";

  const colours = readColours(params);
  const needsFallback = SWATCHES.some(([key]) => !colours[key]);

  let palette: Palette | null = null;
  let day = date ?? isoDayInZone(new Date(), timezone);
  if (needsFallback) {
    const sunset = localSunset(lat, lon, day, timezone) ?? zonedTimeToUtc(day, "12:00", timezone);
    palette = computePalette({ elevation: getSolarPosition(lat, lon, sunset).elevation });
    day = date ?? isoDayInZone(sunset, timezone);
  }

  const resolved = {
    zenith: colours.zenith ?? (palette?.zenith as HexColor) ?? "#0F4FA8",
    midsky: colours.midsky ?? (palette?.midsky as HexColor) ?? "#4F92D8",
    horizon: colours.horizon ?? (palette?.horizon as HexColor) ?? "#A6CDF0",
    sunglow: colours.sunglow ?? (palette?.sunglow as HexColor) ?? "#FFFFFF",
    cloudtint: colours.cloudtint ?? (palette?.cloudtint as HexColor) ?? "#F7FCFF",
  };

  const phase = requestedPhase || palette?.phase || "Sky";
  const sunsetLabel = localSunset(lat, lon, day, timezone);

  const html = buildCard({
    city,
    date: day,
    phase,
    sunset: sunsetLabel ? clockInZone(sunsetLabel, timezone) : null,
    palette: resolved,
  });

  return new ImageResponse(html, {
    width: WIDTH,
    height: HEIGHT,
    fonts: OG_FONTS,
    headers: {
      "Cache-Control": "public, max-age=86400",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};

type SwatchKey = (typeof SWATCHES)[number][0];

function readColours(params: URLSearchParams): Partial<Record<SwatchKey, HexColor>> {
  const out: Partial<Record<SwatchKey, HexColor>> = {};
  for (const [key] of SWATCHES) {
    const colour = normaliseHex(params.get(key));
    if (colour) out[key] = colour;
  }
  return out;
}

function normaliseHex(value: string | null): HexColor | null {
  if (!value) return null;
  const raw = value.trim();
  const prefixed = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-f]{3}$/i.test(prefixed)) {
    const body = prefixed.slice(1);
    const expanded = `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
    return HEX_6.test(expanded) ? (expanded.toUpperCase() as HexColor) : null;
  }
  return HEX_6.test(prefixed) ? (prefixed.toUpperCase() as HexColor) : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * True only for a real calendar day: the pattern alone would accept
 * 2026-99-99, which then feeds sunset maths and the rendered subtitle.
 */
function isIsoDay(value: string): boolean {
  const match = ISO_DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

interface CardInput {
  city: string;
  date: string;
  phase: string;
  sunset: string | null;
  palette: Record<SwatchKey, HexColor>;
}

function buildCard(input: CardInput): string {
  const { palette } = input;
  const foreground = readableTextColor(palette.midsky, "#0B0D12", "#FFFFFF");
  // Every dynamic field is either pattern-validated (date, colours) or escaped,
  // and the composed subtitle is escaped once at interpolation to avoid double escaping.
  const subtitle = input.sunset ? `${input.date} · ${input.phase} · sunset ${input.sunset}` : `${input.date} · ${input.phase}`;

  const bars = SWATCHES.map(([key, label], index) => {
    const colour = palette[key];
    return `<div style="display:flex; flex-direction:column; width:196px;${index === 0 ? "" : " margin-left:18px;"}">
      <div style="display:flex; width:196px; height:168px; border-radius:18px; background-color:${colour};"></div>
      <div style="display:flex; font-size:19px; margin-top:14px; color:${foreground}; opacity:0.78;">${escapeHtml(label)}</div>
      <div style="display:flex; font-size:18px; margin-top:4px; color:${foreground}; opacity:0.62;">${colour}</div>
    </div>`;
  }).join("");

  return `<div style="display:flex; flex-direction:column; width:${WIDTH}px; height:${HEIGHT}px; padding:72px; box-sizing:border-box; font-family:'JetBrains Mono'; background:linear-gradient(180deg, ${palette.zenith} 0%, ${palette.midsky} 55%, ${palette.horizon} 100%);">
    <div style="display:flex; flex-direction:column; width:100%;">
      <div style="display:flex; font-size:20px; letter-spacing:5px; text-transform:uppercase; color:${foreground}; opacity:0.72;">Sky Palette</div>
      <div style="display:flex; font-family:'Playfair Display'; font-size:76px; line-height:1.05; margin-top:18px; color:${foreground};">${escapeHtml(input.city)}</div>
      <div style="display:flex; font-size:28px; margin-top:16px; color:${foreground}; opacity:0.82;">${escapeHtml(subtitle)}</div>
    </div>
    <div style="display:flex; width:100%; margin-top:auto;">${bars}</div>
  </div>`;
}

export { normaliseHex, escapeHtml, isIsoDay };
