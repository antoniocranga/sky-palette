# Sky Palette — Pre-Launch Checklist & Quality Gate

> **MANDATORY QUALITY GATE FOR ALL RELEASES.**  
> Every agent, developer, and release pipeline must verify every item in this checklist before deploying to `staging.skypalette.app` or `skypalette.app`.  
> Powered by the **Front-End Checklist** standard ([frontendchecklist.io](https://frontendchecklist.io/)) via MCP endpoint `https://mcp.frontendchecklist.io/`.

---

## 📋 Front-End Checklist MCP Reference

Sky Palette integrates the official **Front-End Checklist MCP** for automated and manual release audits:
- **Public MCP Endpoint:** `https://mcp.frontendchecklist.io/`
- **Specification & Documentation:** [frontendchecklist.io/mcp](https://frontendchecklist.io/mcp)
- **Upstream Repository:** [github.com/thedaviddias/Front-End-Checklist](https://github.com/thedaviddias/Front-End-Checklist)

---

## 1. HTML & Document Structure

| Rule Slug | Requirement | Verification Method | Status |
|---|---|---|---|
| `doctype` | Clean HTML5 doctype (`<!DOCTYPE html>`) on all rendered pages | Automated audit | [ ] |
| `charset` | UTF-8 encoding declared in `<head>` (`<meta charset="utf-8">`) | Automated audit | [ ] |
| `viewport` | Responsive viewport tag: `<meta name="viewport" content="width=device-width, initial-scale=1">` without disabling zoom (`maximum-scale=1` or `user-scalable=no` prohibited) | Automated audit | [ ] |
| `lang-attribute` | Declared language tag on `<html>` root (`<html lang="en">`) | Automated audit | [ ] |
| `favicons` | Complete device favicon set: `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, and `manifest.json` | Visual & link check | [ ] |
| `404-page` | Custom, graceful 404 page styled with Sky Palette design system and home link | Manual URL test | [ ] |
| `html5-semantics`| Proper HTML5 landmarks (`<header>`, `<main>`, `<nav>`, `<footer>`) | Screen reader & DOM audit | [ ] |

---

## 2. Accessibility (WCAG 2.2 Level AA)

| Rule Slug | Requirement | Verification Method | Status |
|---|---|---|---|
| `keyboard-navigation` | All interactive components (search bar, jog-dial slider, buttons, modals, dropdowns) navigable via `Tab`, `Shift+Tab`, `Enter`, `Space`, `Escape`, and `Arrow` keys | Manual keyboard test | [ ] |
| `skip-link` | Accessible "Skip to main content" link as first focusable element | Keyboard test | [ ] |
| `focus-visible` | High-contrast focus rings on all interactive elements (`focus-visible:ring-2`) | Visual inspection | [ ] |
| `contrast-ratio` | Minimum 4.5:1 contrast for normal text and 3:1 for large text/icons across both daytime (light) and nighttime (dark) sky gradients | Automated contrast check | [ ] |
| `aria-attributes` | Accurate `aria-label`, `aria-expanded`, `role="dialog"`, and `aria-modal="true"` on popovers and modals | DOM inspection | [ ] |
| `alt-text` | All image elements have descriptive `alt` text or `alt=""` for decorative assets | Automated audit | [ ] |

---

## 3. SEO & Structured Metadata

| Rule Slug | Requirement | Verification Method | Status |
|---|---|---|---|
| `meta-title` | Descriptive, unique page titles under 60 characters | Source audit | [ ] |
| `meta-description`| Compelling meta description (120–160 characters) summarizing real-time physical sky palettes | Source audit | [ ] |
| `canonical-url` | Self-referencing canonical URL (`<link rel="canonical" href="https://skypalette.app">`) | Source audit | [ ] |
| `robots-txt` | `robots.txt` published at root, indexing allowed, referencing sitemap | `curl /robots.txt` | [ ] |
| `sitemap` | Valid `sitemap.xml` listing core canonical URLs | XML validation | [ ] |
| `og-tags` | Open Graph tags: `og:title`, `og:description`, `og:image` (1200×630px), `og:url`, `og:type="website"` | Social preview audit | [ ] |
| `twitter-cards` | Twitter Card tags: `twitter:card="summary_large_image"`, `twitter:image` | Social preview audit | [ ] |
| `structured-data` | Schema.org JSON-LD structured data (`WebApplication` schema) | Rich Results Test | [ ] |

---

## 4. Security & Cloudflare Edge Safeguards

| Rule Slug | Requirement | Verification Method | Status |
|---|---|---|---|
| `https` | Strictly HTTPS with HSTS header (`max-age=63072000; includeSubDomains; preload`) | Header check | [ ] |
| `http-to-https` | Automatic 301 permanent redirect from HTTP to HTTPS | Cloudflare Edge rule | [ ] |
| `security-headers`| `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` | Response header audit | [ ] |
| `zero-secrets` | ZERO API tokens, Cloudflare Account IDs, Turnstile secrets, or private keys committed in git (`git diff --cached`) | Automated git hook | [ ] |
| `bot-protection`| Cloudflare Turnstile challenge enforced on photo submissions (`/api/submit`) | Penetration test | [ ] |
| `rate-limiting` | Server-side IP-hash rate limiting: 5 uploads/hour/hash, 60 requests/min on `/api/palette` | Load simulation | [ ] |
| `sql-injection` | All database queries on D1 executed via prepared parameterized statements (`env.DB.prepare(...)`) | Code review | [ ] |
| `exif-scrubbing` | Stripping all EXIF tags, GPS metadata, and device serials server-side before R2 persistence | Image verification | [ ] |

---

## 5. Performance & Core Web Vitals (CWV)

| Metric / Rule | Requirement | Target | Status |
|---|---|---|---|
| **LCP** | Largest Contentful Paint | < 1.2s on 4G mobile | [ ] |
| **INP** | Interaction to Next Paint | < 100ms | [ ] |
| **CLS** | Cumulative Layout Shift | < 0.05 | [ ] |
| **Jog-Dial Scrubber**| Smooth real-time canvas gradient rendering | 60–120fps with zero network calls | [ ] |
| **Bundle Size** | First load JavaScript bundle size | < 150KB gzipped | [ ] |
| **Compression** | Brotli and Gzip compression enabled at edge | Response headers | [ ] |
| **Caching** | Palette API cached for 24h; static assets cached for 30d | `Cache-Control` audit | [ ] |

---

## 6. Privacy & Data Ethics (Zero-Tracking Mandate)

| Requirement | Implementation | Status |
|---|---|---|
| **100% Cookie-Free** | Zero session cookies, zero tracking cookies, zero cookie consent popups | [ ] |
| **Zero Fingerprinting** | No canvas hashes, audio signatures, or hardware profiling | [ ] |
| **Zero Accounts** | Anonymous exploration and crowdsourcing with auto-generated animal handles | [ ] |
| **Privacy-Preserving Telemetry** | Cloudflare Web Analytics (aggregate RUM, zero IP logging) | [ ] |

---

## 7. Multi-Environment Staging & Deployment Protocol

1. **Local Build Cleanliness:**
   - Run `npm run build` locally. Zero TypeScript errors, zero lint warnings.
2. **Automated Front-End Checklist Audit:**
   - Execute `node scripts/verify-frontend-checklist.js` against built assets.
3. **Deploy to Staging:**
   - Deploy to `staging.skypalette.app` using `sky-palette-db-staging` and `sky-photos-staging`.
   - Perform end-to-end smoke tests on mobile and desktop viewports.
4. **User Review Gate:**
   - Present staging deployment URL to user for visual and functional sign-off.
5. **Deploy to Production:**
   - Promote to `skypalette.app` using production D1 (`sky-palette-db`) and R2 (`sky-photos`).
   - Run live post-launch audit and publish GitHub Release notes.
