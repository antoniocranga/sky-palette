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
