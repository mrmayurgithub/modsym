# Releasing modsym

Checklist for cutting a release. Never publish from a dirty tree:
`git status --short` must be clean before and after versioning.

1. Start clean: fresh checkout, then `npm ci`.
2. Full test suite: `npm test`.
3. Compatibility evidence: compat workflow green on the release commit.
4. Pinned corpus run: `npm run test:real`.
5. Pack dry run: `npm pack --dry-run`; confirm only intended files
   (`bin/`, `src/`, `scripts/`, `test/`, `docs/`, `README.md`, `LICENSE`) are included.
6. Packed-artifact consumer verification: install the tarball in a temp
   dir, run the packed tests there, and smoke the fixture CLI
   (see the consumer-verification steps in
   `.github/workflows/publish.yml`).
7. Version and lockfile consistency: bump with `npm version`
   (patch/minor/major) so `package.json` and `package-lock.json` land
   in the same commit.
8. Changelog: write GitHub release notes on the tag describing what
   changed and any abstention-behavior changes.
9. Trusted publishing: push the `v*` tag; the publish workflow builds,
   tests, verifies the packed consumer, and publishes via OIDC. Never
   run `npm publish` by hand from a working tree.
10. Post-publish smoke: `npx modsym zod@4.5.4 string` resolves.

## Deprecation and rollback

- Bad release, fix forward: publish a patch release.
- Discourage a specific version: `npm deprecate modsym@<version>
  "<reason>"`.
- Never `npm unpublish` without explicit owner approval.
