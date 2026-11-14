## Summary

<!-- What changed, why, and which issue it closes. -->

Closes #

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / performance
- [ ] Docs / tooling

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e`
- [ ] Checked at 393×852 (iPhone 15 Pro) and desktop; no horizontal scroll, dock fully visible
- [ ] No new third-party runtime requests
- [ ] API data is inserted with `textContent`/escaped templates, never raw `innerHTML`

## Security and repo hygiene

- [ ] `git diff --cached` contains no secrets, tokens, account ids, local paths, `.dev.vars`, `.wrangler/`, or `dist/`
- [ ] New server input is validated; errors stay generic with a request id
- [ ] New D1 changes are additive migrations
- [ ] Photos/uploads still strip metadata and stay private in R2

## Screenshots

<!-- Before/after for UI changes. Mobile and desktop. -->
