# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's **Report a vulnerability** button under the Security tab (private vulnerability reporting), or email the maintainer listed in the repository profile. Include the affected endpoint, reproduction steps, and impact. You can expect an acknowledgement within 72 hours.

## Scope

In scope: the Worker API under `/api/*`, the static client, the D1 schema, R2 object access, and the build/release pipeline.

Out of scope: volumetric attacks, missing DNS records, and issues that require a compromised Cloudflare account.

## Design guarantees

- **No secrets in the repository.** Local values live in `.dev.vars`; production values are Worker secrets. CI uses a scoped API token stored in the `production` GitHub Environment.
- **No raw IPs.** Client IPs are hashed with a secret salt before they are used or stored.
- **Uploads are validated twice.** Client-side downscale is a UX nicety; the Worker re-checks magic bytes, dimensions, size and (when configured) the Turnstile token, then strips metadata before writing to R2.
- **Safe errors.** Clients only receive short, human-readable messages plus a request id. Stack traces stay in Workers Logs.
- **Least privilege.** R2 is private and streamed through `/api/photos/*`; the bucket has no public hostname.

## Supported versions

The `main` branch is the only supported line. Fixes are released by deploying `main`.
