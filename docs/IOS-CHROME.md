# iOS Safari chrome colour

How the page colours the Safari status bar and toolbar, why it changed, and what
we can and cannot control.

## The platform change

- Safari 15–18 honoured `<meta name="theme-color">`, including runtime updates
  ([WebKit: New Features in Safari 15](https://webkit.org/blog/11989/new-webkit-features-in-safari-15),
  [WWDC21 “Design for Safari 15”](https://developer.apple.com/videos/play/wwdc2021/10029/)).
- Safari 26 (2025) stopped using it. Caniuse records **no support** on iOS 26.0
  through 27.2 ([caniuse: theme-color](https://caniuse.com/meta-theme-color)).
  The toolbar tint is derived from the rendered page instead
  ([WebKit bug 301756](https://bugs.webkit.org/show_bug.cgi?id=301756),
  [Apple Developer Forums 801239](https://developer.apple.com/forums/thread/801239),
  [Ben Frain](https://benfrain.com/ios26-safari-theme-color-tab-tinting-with-fixed-position-elements)).
- The sampling rule (from the WebKit source, summarised in
  [joe-bell/skills](https://github.com/joe-bell/skills/blob/main/skills/apple-web-app/references/theme-color-and-status-bar.md)):
  hit-test the horizontal centre 4 px inside the edge; only `position: fixed` or
  `sticky` elements count; they must span at least 90 % of the viewport width; a
  box more than 10 px in both dimensions contributes its **`background-color`**
  (gradients and `background-image` are not read).
- WebKit re-samples as the colour changes: a fixed edge strip about 12 px tall
  follows live updates in both directions
  ([WebKit bug 325807](https://bugs.webkit.org/show_bug.cgi?id=325807)), and the
  body/edge strip is watched by a live observer
  ([safari-color-tinting](https://github.com/andesco/safari-color-tinting)).

A control page with a fixed 14 px strip at each edge, changing
`background-color` every 2 s, confirms it on the iPhone 17 simulator (iOS 27):
the status area and toolbar followed red/blue → yellow/green while the page
stayed black.

## What we do

Three layers, in `src/client/lib/theme.ts` and `src/client/styles.css`:

1. **`theme-color`** — kept for iOS 15–18.6, Chrome, Android and desktop.
2. **Root background** — `html` and `body` are painted with the surface colour
   (sky horizon on Home, `#0b0d12` on the gallery, white on detail, the scrim
   composite under dialogs). This is the fallback Safari samples when no fixed
   strip qualifies.
3. **Fixed edge strips** — `#safe-top-scrim` and `#safe-bottom-scrim` are fixed,
   full-width, 16–20 px tall, and carry `--chrome-top` / `--chrome-bottom` as a
   solid `background-color`. Their gradients are `background-image` overlays so
   the sampling reads the solid colour. Home updates both variables from the
   live palette on every scrub, so the chrome follows the ruler.

## Constraints we accept

- **One flat colour per edge.** Safari samples a colour, not a gradient, so the
  bar can match the sky at the edge but never the full gradient.
- **WebKit decides when to re-sample.** Updates are not part of a spec; rapid
  scrubbing may lag or settle at the gesture end. There is no per-frame API.
- **A qualifying element can hijack it.** Any future fixed/sticky element over
  90 % wide at the edge, with its own background, becomes the sampled source.
  Keep overlays narrower than 90 % or transparent.
- **iOS 27 status area may still be scrimmed by the OS** (measured Δ4 on Home);
  a solid-colour control page shows the same darkening, so it is not page colour.
- **Older Safari (≤18.6) ignores the strips** and uses `theme-color`, which we
  keep in sync with the same values.
- The simulator cannot inject touch, so live follow was verified with a
  time-driven control page rather than a real drag.
