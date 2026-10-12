# Pinned-Linux visual capture / compare / regression runner (round 60)

Single source of truth for the image, both local capture and CI compare:

    mcr.microsoft.com/playwright@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7

amd64 · Ubuntu 24.04 · Node 24.20.0 · Playwright 1.63.0 (image browser). Actual
launched default headless shell
`/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`
(`browser.version()` 153.0.8010.12, sha256 `ded93a9c…bf39e`); 48 fontconfig files.
External package `/external/node_modules/@playwright/test/cli.js` (1.63.0) is
mounted READ-ONLY — never installed into the image, the repo or any manifest.

## Files

- `run-linux-capture.sh` — host orchestration. Modes:
  - `capture <archiveDir> <outDir>` — setup (bridge) + network-none whole-suite
    capture + atomic publish + coverage guard + 3 same-source repeats.
  - `compare <archiveDir> <goldenBaselinesDir> <outDir>` — strict same-source
    repeat proof (`repeat-zero-diff.mjs`) against an IMMUTABLE golden baselines
    tree (bind-mounted read-only).
  - `regression <archiveDir> <goldenBaselinesDir> <outDir>` — the NORMAL CI
    comparison: CURRENT source vs an IMMUTABLE baseline captured on a HISTORICAL
    source commit. Runs the REAL complete Playwright comparison suite PLUS the
    SEPARATE onboarding smoke (`scripts/regression.mjs`), read-only, and never
    captures/updates/promotes golden bytes. This is the lane the CleanUp1 GATE
    owns (the gate builds the fresh archive and invokes it via the shell-safe
    positional argv bridge).
  In-container scripts are mounted READ-ONLY from `/bootstrap` (this script's own
  directory, the trusted harness) — never read from the archive or the empty
  `/work` volume. Archive validation (single named tarball, checksum, entry
  type/containment) happens on the host BEFORE extraction. Containers are created
  with `docker create --cidfile` (id captured and tracked BEFORE start) then
  started under `timeout`; removal is by exact id + label check; the `/work`
  volume MUST be empty (a non-empty volume is refused, never wiped); cidfiles and
  diagnostics are RETAINED.
- `container-setup.sh` — in-container: extract the exact archive INTO the
  volume-mounted `/work` and `pnpm install --frozen-lockfile` there (pinned pnpm),
  so the COMPLETE workspace `node_modules` topology persists on the owned volume;
  then BUILD the workspace packages the renderers import — `@capiro/shared` (web +
  onboard) and `@capiro/strategy-verifier` (web) — because Vite resolves them
  through their `exports` to built `dist/*` entries that a fresh frozen install
  does not produce (`dist` is gitignored/never archived). Each stage is bounded
  and its raw exit status is retained (no build-skip fallback).
- `container-capture.sh` — in-container: canonical provenance check, then the real
  `capture-baselines.mjs` + `guard-route-coverage.mjs` + `repeat-zero-diff.mjs`,
  then the SEPARATE `apps/onboard-web` two-case smoke (own config/dev server on
  :4192) as its own stage. Route-capture/guard/repeat statuses are preserved and
  the onboard stage (registration-frontend + fallback) runs independently, so a
  capture failure never erases it and an onboard failure is never masked.
- `container-compare.sh` — in-container compare-only repeat proof.
- `container-regression.sh` — in-container regression entry: canonical provenance,
  then `apps/e2e/scripts/regression.mjs` (complete comparison + separate onboarding
  smoke) with raw stage statuses preserved; copies reports to `/out`. It never
  captures/updates/promotes goldens.
- Shared kernels: `apps/e2e/lib/render-context.mjs` (the ACTUAL render-context
  contract — the three resolved project viewports plus colour scheme, media
  type, locale, timezone, device scale factor, reduced motion and fixed clock —
  and the recorder that observes those values from REAL browser contexts),
  `apps/e2e/lib/renderer-contract.mjs` (the complete renderer / context contract
  used by the regression driver, the strict repeat proof AND the gate validator —
  one kernel, no divergence) and `apps/e2e/lib/playwright-report.mjs` (identity
  multiset + actual-execution status summary, reusing the canonical
  `scripts/test-proof/lib/adapters.mjs` parser). The contract is INCOMPLETE (and
  therefore refused) without the colour scheme, media type and the three actual
  project viewports, and `fonts.files` must be a non-empty list of real
  `path`+64-hex `sha256` members (an empty/malformed list can no longer hash to a
  plausible digest). `apps/e2e/lib/source-identity.mjs` measures and requires
  both kernels, so archive provenance byte-binds them.
- `verify-provenance.mjs` — canonical `verifyManifest` against the extracted bytes.
- `validate-archive.mjs` — HOST-side real validation invoked by the runner before
  any extraction: uses the ONE shared validator (`../lib/tar-validate.mjs`) on the
  real header typeflag bytes + PAX/GNU effective paths (rejects links/devices/FIFO,
  unsafe paths, malformed/incomplete PAX, bad octal sizes, hidden trailing
  entries), binds the manifest to the receipt AND to the archive by ACTUAL PAYLOAD
  sha256+size, requires every canonical REQUIRED_INPUT as a regular file, and
  byte-binds every `/bootstrap` harness file to the measured archive.
- `lifecycle.sh` — shared container classification/cleanup (sourced by the runner
  and by `tests/lifecycle-controls.sh`). `present|absent|unknown`; absent requires
  a no-such-object diagnostic bound to the EXACT id; removal confirmed only on
  successful exact rm + definite absence; id/label mismatches retained.
- `tests/lifecycle-controls.sh` — fake-native decision-table proof (no daemon, no
  images): present-owned, absent, daemon-error, label-mismatch, id-mismatch,
  rm-fails, create-with-CID, create-without-CID.

## Guarantees

- One bounded setup; dependencies on Linux-native NAMED VOLUME storage (never a
  Windows bind → no 239/1422 timeout); capture/compare run `--network none`.
- The renderer workspace deps (`@capiro/shared`, `@capiro/strategy-verifier`) are
  built on the owned volume during setup, so the fresh install has resolvable
  package entries before any browser starts. `dist` is a generated output (excluded
  from the measured source scope), so the build never perturbs the source
  fingerprint or provenance.
- Exact created container IDs (`--cidfile`), label-verified removal, name/volume
  collision refusal, bounded memory/cpus/timeout, artifacts + volume retained.
- Source provenance: exact archive filename + tar checksum from
  `archive-receipt.json`; canonical fingerprinted manifest (schema/head/tree);
  symlink/traversal entries rejected. No synthetic commit; no raw SHA trust.
- Publisher writes + verifies the manifest INSIDE staging, publishes via two
  verified renames with rollback, and refuses dirty/missing-identity source.
- The CleanUp1 gate passes a FRESH, task-owned output directory as the
  `regression` mode `outDir`, so the evidence and the raw `--list`/run reports
  under it can only belong to THAT run — a stale same-commit report from a
  previous partial run is never reused. The gate re-reads the ACTUAL baseline
  manifest (bytes + runtime + historical `capturingSha`/`sourceFingerprint`) and
  every PNG byte, before AND after, and refuses any drift.

## Provenance / source archive

`apps/e2e/scripts/make-source-archive.mjs <outDir>` refuses a dirty measured tree,
writes `source-<head>.tar` (containment-checked) + `source-manifest.json`
(complete measured inputs incl. `apps/web/public` assets) + `archive-receipt.json`
(tar sha256, head/tree).

`apps/e2e/lib/source-identity.mjs` is the canonical walker: complete rendered
inputs (web + public + shared + strategy + root config/lock), fail-closed on
missing required/unreadable inputs and symlink escapes, Git dirty-status with the
same exclusions as the byte walker.
