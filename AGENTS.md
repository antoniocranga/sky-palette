# Sky Palette — Agent Instructions & Engineering Rules

> **MANDATORY RULES FOR ALL AI AGENTS WORKING ON SKY PALETTE.**  
> These instructions are active across all turns and prompts. Every agent must strictly adhere to the security, architectural, and server-side execution boundaries outlined below.

---

## 1. Security & Open-Source Zero Secrets Policy (CRITICAL)

This repository is **public and open-source** on GitHub (`https://github.com/antoniocranga/sky-palette`).

### 1.1 Strict Prohibition on Leaking Secrets & PII
- **NEVER hardcode, print, commit, or push any of the following:**
  - Cloudflare API tokens, Global API keys, or OAuth credentials.
  - Cloudflare Account IDs (use runtime bindings or environment variables).
  - Cloudflare Turnstile secret keys (`TURNSTILE_SECRET_KEY`).
  - Private salts, encryption keys, or passwords.
  - Personal identifiable information (real names, personal email addresses, private URLs).
  - Absolute local machine paths (e.g., `/Users/...` or host system directories).
  - Local environment files (`.env`, `.env.local`, `.dev.vars`, `.dev.vars.*`).
  - Cloudflare/Wrangler local runtime state (`.wrangler/`, `.cloudflare/`).
- **Secret Management:**
  - Local development secrets belong strictly in `.dev.vars` (which is excluded by `.gitignore`).
  - Production secrets must be provisioned via `wrangler secret put <KEY>` or Cloudflare Dashboard environment variables.
  - Only template files (`.env.example`, `.dev.vars.example`) containing mock placeholders may be committed.

### 1.2 Mandatory Pre-Commit Checklist
Before executing any `git commit` or `git push`:
1. Run `git status` to verify that only intended project files are staged.
2. Verify that no `.env`, `.dev.vars`, `.wrangler/`, credentials, or personal files are present in the index.
3. Check `git diff --cached` for any accidental secrets or hardcoded tokens.

---

## 2. Server-Side vs. Client-Side Execution Boundary

All authoritative operations, persistent storage, security checks, and machine learning moderation **MUST be computed server-side on Cloudflare infrastructure**.

### 2.1 Server-Side Responsibilities (Cloudflare Workers & Edge Infrastructure)
The following tasks **MUST NOT** be trusted to the client and must run inside Cloudflare Workers (`src/index.ts` / `api/*`):
1. **Photo Moderation & Safety (Cloudflare Workers AI):**
   - NSFW classification using `@cf/microsoft/resnet-50` or `@cf/meta/llama-guard-3-8b`.
   - Authoritative sky-likeness verification (color histogram analysis) to prevent fake sky uploads.
2. **EXIF Scrubbing & Image Transformation:**
   - Stripping all camera metadata, device serials, and full GPS coordinates server-side before persisting photos.
   - Resizing photos to maximum 1200px width and generating 300px square thumbnails.
3. **Object Storage Uploads (Cloudflare R2):**
   - Writing verified photos and thumbnails directly to Cloudflare R2 bucket `sky-photos` via the `PHOTOS` binding (`env.PHOTOS`).
   - Serving community photos with zero egress bandwidth charges.
4. **Turnstile Bot Verification:**
   - Validating challenge tokens with Cloudflare Siteverify (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) using `TURNSTILE_SECRET_KEY`.
5. **Rate Limiting & Privacy-Preserving Abuse Prevention:**
   - Hashing client IP addresses using SHA-256 combined with a secret server salt (`IP_SALT`). Raw IP addresses are **never** stored or logged.
   - Enforcing 5 submissions per hour per hashed identifier.
6. **Canonical Palette Computation & Database Persistence (Cloudflare D1):**
   - Ingesting Open-Meteo weather parameters (low/mid/high cloud layers, visibility).
   - Computing authoritative golden-hour palettes and storing them in D1 (`daily_palettes` table).
   - Executing all database queries against D1 (`sky-palette-db`, UUID `5e1c6b54-4020-4e9b-a5d5-0cea27498741`) via prepared statements (`env.DB.prepare(...)`).
7. **Dynamic Open Graph (OG) Images:**
   - Generating server-side social share previews at edge (`/api/og`).

### 2.2 Client-Side Responsibilities (Browser UI / WebGL / Canvas)
The client browser is strictly responsible for zero-latency, fluid user interactions:
1. **Interactive Jog-Dial Scrubber (60-120fps):**
   - Real-time solar position computation via client-side `SunCalc`.
   - WebGL / Canvas Hosek-Wilkie / Preetham gradient rendering with zero network latency during scrubbing.
   - Contrast engine adapting scrubber text and needles smoothly between white and black based on sky luminance.
2. **Pre-Submission Heuristics:**
   - Instant client-side validation of file type, dimensions, and basic color palette to provide instantaneous UX feedback before initiating upload.
3. **Local UI State & Navigation:**
   - Search autocomplete filtering via Fuse.js.
   - Zero-cookie state management (in-memory only).

---

## 3. Cloudflare Infrastructure Reference

| Service | Identifier / Binding | Purpose |
|---|---|---|
| **Production Domain** | `skypalette.app` | Cloudflare Zone `4df85ed776a09b6464a515af9549f7b4` |
| **D1 Database** | `sky-palette-db`<br>`5e1c6b54-4020-4e9b-a5d5-0cea27498741` | Serverless SQLite in `EEUR` (OTP colo), bound as `env.DB` |
| **R2 Storage** | `sky-photos` | Community sky photo storage ($0 egress), bound as `env.PHOTOS` |
| **Workers AI** | `@cf/microsoft/resnet-50` | Server-side image moderation & NSFW filter |
| **Turnstile** | `skypalette.app` widget | Zero-friction bot protection on submission endpoint |
| **Web Analytics** | Cloudflare Web Analytics | 100% cookie-free Core Web Vitals telemetry |

---

## 4. Multi-Model Engineering Division

- **DeepSeek v4.1:**  
  Owns all mathematics, physics, astronomy algorithms (SunCalc, Hosek-Wilkie, Preetham scattering equations), Cloudflare Workers backend APIs, D1 SQL queries, and server-side image processing.
- **Gemini 3.8 Flash:**  
  Owns all frontend UI, Tailwind CSS styling, responsive layout, component ergonomics, unslop aesthetic design, and DOM animations.

---

## 5. Privacy & Data Ethics (Zero-Tracking Mandate)

- **100% Cookie-Free:** No session cookies, no tracking cookies, no cookie consent banners.
- **Zero Fingerprinting:** Never generate device hashes, canvas fingerprints, or audio signatures.
- **No User Accounts:** Completely anonymous exploration and photo submission with auto-generated animal/nature handles (`sky-bucharest-48b`).
- **GDPR & ePrivacy Native Compliance:** By collecting zero PII and using cookie-free Cloudflare Web Analytics, the application is compliant by design without requiring cookie popups.

---

## 6. Pre-Launch & Release Verification Checklist

> Referenced from **The Front-End Checklist** (`https://mcp.frontendchecklist.io/` & `https://github.com/thedaviddias/front-end-checklist`).  
> **Mandatory check on every code release and deployment.**

### 6.1 Head & Metadata Architecture
- [ ] `<!DOCTYPE html>` declared at root of document.
- [ ] `<html lang="en">` declared with valid language tag.
- [ ] `<meta charset="UTF-8">` placed in the first 1024 bytes of `<head>`.
- [ ] Responsive viewport meta tag `<meta name="viewport" content="width=device-width, initial-scale=1.0">`.
- [ ] Unique, descriptive `<title>` (under 65 characters) and `<meta name="description">` (120–160 characters).
- [ ] Self-referencing canonical URL `<link rel="canonical" href="https://skypalette.app">`.
- [ ] Open Graph protocol (`og:title`, `og:description`, `og:image`, `og:url`, `og:type`) and Twitter Cards (`summary_large_image`).
- [ ] Schema.org structured data (`application/ld+json`) for `WebApplication`.
- [ ] Favicon SVG and Apple Touch Icon declared without broken links.

### 6.2 HTML & Accessibility (WCAG 2.2 AA)
- [ ] Semantic HTML5 elements (`<header>`, `<main>`, `<footer>`, `<dialog>`, `<nav>`) properly nested.
- [ ] All interactive buttons and inputs have accessible labels (`aria-label` or linked `<label for="">`).
- [ ] Touch targets adhere to minimum 44×44px interactive bounding boxes.
- [ ] Contrast engine maintains WCAG 2.2 AA compliance across all solar elevation angles using $C^1$ continuous Hermite interpolation.
- [ ] Keyboard navigation supported with visible focus rings and Escape key dialog dismissals.

### 6.3 Performance & Web Vitals
- [ ] Web fonts optimized with `preconnect` and `font-display: swap`.
- [ ] Modern CSS architecture (`calc()`, dynamic gradients, hardware-accelerated transforms).
- [ ] Sub-second time-to-first-byte (TTFB) and instant interactive feedback on scrubber drag.
- [ ] Zero layout shifts (CLS = 0) with predefined dimensions.

### 6.4 Security, Edge & Privacy
- [ ] Strict adherence to Section 1 Zero Secrets Policy (`git diff --cached` verified).
- [ ] Local environment files (`.env`, `.dev.vars`, `*.local`) excluded in `.gitignore`.
- [ ] Server-side execution boundaries strictly maintained (Workers, D1, R2).
- [ ] Salted SHA-256 IP hashing for abuse rate limiting; zero raw IP addresses logged or stored.
- [ ] Safe error responses (no stack traces, no internal database errors exposed to client).
- [ ] OpenTelemetry traces and structured JSON logging active for production observability.
- [ ] Automated tests pass 100% locally and in GitHub Actions CI/CD (`npm test`).
