# Newsletter receiving and saved-document qualification

All required local gates below passed on the same published runtime source, `c8aa693e884de86001d2fc04fbb60d48db09341c`. Root tree: `9d11bfbd7121887bc06f5cb793e8a4c4e6e682b4`. Application tree: `79ae91f7a119e98b7ba612ceed2a4ca661944888`. Lock SHA256: `5deb9fbd2767fcc116235953a2d0ca762702908186edc098a791cd400ab52cd4`. Every gate records before/after source identity and an empty runtime diff. This publication adds evidence only; it does not change the qualified runtime.

Draft [PR16](https://github.com/neo-capiro/capiro-frontend/pull/16) deliberately incorporates separately qualified PR17 runtime `d4be41e60516e576c74afa304b50ed67da15cb93` through merge `977cf7b3b6bb4924c85d1cc5be5b31d93d94e026`. PR17 and its evidence head `6dacdaca3507bf75a472f5860ac72fc483377248` remain unchanged. Historical targeted passes are not substituted for the complete runs reported here.

## Scope

This source preserves the three integrated product lanes, shared routing/auth/session/client owners, the distinct Portfolio Core/Intel transports, fixed Modules gateway and existing Meri public stream contract. Newsletter additions use the immutable `@capiro/shared` receiving package from source `38fec5c83585850ed75a7d3693b3b90d517e70af` and publication `9ffab390ef444d7ea0bf4eb0d68224f810245e25`; tar SHA256 is `3e435f280fac8fd301eb753e9fc7ead93691cf979fc1641792fedd88e1bfd6d5`.

Eight fixed newsletter operations cover list/create/detail/save/preview/stage and Core stage/record reads. Incoming shapes are governed by the public receiver. Adapter controls bind captured requests, document/client/version and stage receipts. Scoped attempt metadata retains pending, conflict and unknown outcomes across closing/reopening, while identity/client replacement clears private editors and caches. No automatic write retry is introduced. The inert preview browsing context is replaced when its document changes so native Back/Forward reaches the parent route and disposes its editor correctly.

The source preserves all116 original rendering fixtures/goldens,130 receiving cases,8 declaration cases,179 source assets and43 prior browser/harness files. Earlier source correction evidence and the genuine two failing native-history cases are retained under `docs/newsletter-receiving-20261013` and related newsletter evidence directories. The final12 new saved-document browser cases run inside the full234-case Modules suite.

## Exact-source gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Clean install | PASS,849 packages | `qualification/final-clean-install-v2-exit.json`; own clean installed graph, no borrowed dependency symlink |
| Public artifacts, workspace types, root controls | PASS;62 root cases | `qualification/final-check.log` |
| Architecture | PASS;439 signals,415 reviewed,24 inherited unreviewed,0 blocking/errors | Same canonical check log; inherited unresolved responsibilities remain reported |
| Transport | PASS,21 cases | Same canonical check log |
| Lint / format | PASS,0 lint errors,76 retained warnings; full configured format check passed | Same canonical check log |
| Portfolio units | PASS,1282 cases /90 files | Same canonical check log |
| Capiro units | PASS,220 cases /26 files | Same canonical check log |
| Newsletter units/declarations | PASS,385 Node cases +8 strict declaration cases | Same canonical check log |
| Adopted Elements closure/SSR/negative controls | PASS,15 cases | `qualification/final-elements.log` and retained receipts |
| Public newsletter browser receiver/renderer | PASS,116 original +130 receiving cases across six packed modules | `qualification/final-public-newsletter-browser.log`; no requests/page errors |
| Complete Portfolio browser suite | PASS,1122/1122,0 skipped/flaky/retries | `qualification/final-portfolio-browser-results.json`;04:03:41–04:40:14 UTC,3 workers |
| Complete Modules browser suite | PASS,234/234,0 skipped/flaky/retries | `qualification/final-modules-browser-results.json`;04:40:35–04:45:40 UTC,1 worker |
| Production build | PASS | `qualification/final-build-exit.json`;04:46:14–04:47:10 UTC |
| Actual Next standalone | PASS;11 HTTP/header checks,4 desktop/phone light/dark views,2 desktop cross-mode native Back/Forward checks and Portfolio-root smoke | `qualification/final-production/production-smoke.json`; no page errors |
| Actual served asset bytes | PASS;179 HTTP200 responses,486014 bytes, every SHA256 matches canonical source | `qualification/actual-served-assets/asset-results.json` |
| Mobile visual followup | PASS,1/1 corrected diagnostic | `qualification/mobile-visual-diagnostic-v2/results.json`; editable controls, scrolled structure/plain/HTML previews, width/error/no-write checks |

Both full browser configurations retain their full spec globs, no shard/grep selection, repeat1 and retries0. Portfolio uses the original30s timeout except the four inherited90s slow cases; Modules uses30s. Browser session replacement, client replacement, interrupted writes, header routing and native history are exercised with synthetic intercepted owners. Actual standalone checks run without credentials or service interception and therefore exercise honest unconfigured states, not native sign-in or backend authorization.

## Failed attempts and visual disposition

The first clean install failed with exit254 at03:56 UTC because the default npm cache could not create its directory. Its raw failure remains `final-clean-install.log`. The successful second clean install uses the task-owned writable cache; no package or lockfile was changed to obtain that pass.

The full-suite rich-editor mobile full-page screenshot has an incomplete painted band after a desktop-to-phone viewport change. Root and the independent reviewer inspected separate scrolled390×844 viewport captures: fields, structure, plain text and HTML preview paint and operate correctly without the band. This supports a full-page capture limitation, not a reproduced mobile layout defect. The supplemental diagnostic's first attempt failed because its author used a nonexistent `Rich preview` button name; the actual toggle is `Plain text`. Both diagnostic scripts, outputs and the failed trace are preserved. The corrected diagnostic passed without any product/source change. The original incomplete screenshot is retained, not relabelled as visual acceptance.

Only regenerable download/compile caches were retired for storage. Two relocations of an existing dependency archive preserve its exact bytes and original references through verified symlinks. Receipts are included. No source, installed dependency graph, prior evidence or build was deleted for these gates; no new archive was created.

## Limits and remaining work

The host is Node24.19.0/npm11.9.0 on Linux x86_64/glibc2.41. Playwright1.61.1 ran system Chromium154.0.8037.57 because the earlier public download probe for pinned Chromium149/revision1228 returned403. The earlier raw probe and installed-runtime metadata are preserved separately. No pinned-browser equivalence is claimed.

All337 Portfolio rows remain unaccepted until their native criteria are met. Exact Figma evidence remains unavailable; desktop/mobile and keyboard checks here do not establish full Figma or accessibility acceptance. The43-facet newsletter accounting and its eight exclusions remain open as documented. Collaboration, uploads, additional editor blocks, generation, account review, preparation, test and delivery are not completed by this saved-document slice. Existing unavailable actions stay unavailable. No native backend/session/provider call or paid model workload was used.

No target-musl producer output, exhaustive approved runtime manifest or build provenance is supplied by this glibc qualification. The [producer handoff](PRODUCER-HANDOFF.md) pins the required Node24.21.0/Alpine3.23 target and records the backend assembly profile's7c-only admission blocker at `capirov2@9db4e1cd5589a05e08fb88caa38a4ac44937def5`. A reviewed successor profile and a real target build are still needed. Docker-context execution, image assembly/build, target ABI, edge/routing and shipping qualification remain unrun. No main merge, resource/security/database change, deployment or AWS action occurred.

`EVIDENCE-MANIFEST.json` distinguishes all430 files retained in the saved environment from the87-file9.18MB published subset. Generated fixture workspaces and unrelated older-product screenshots remain locally retained with byte hashes; this document does not imply those generated files are committed. Independent review and its visual addendum are under `reviews/`.
