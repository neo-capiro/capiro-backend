# Frozen 83 qualification with documented storage recovery

**Frozen source `83f54f5ac0107822833adbbfef2b453e0240bc56` completed its offline qualification: 297 Modules/Meri/Onboard cases passed, and all 1,139 unique Portfolio cases have successful coverage after one separately recorded infrastructure rerun. The original Portfolio shard 2 remains failed.** There was also one zero-test selector attempt. No test, product code or assertion changed during recovery.

This packet was prepared outside the worktree for `docs/unified-20261013/qualification-83f54f5a`. Preparation does not commit or publish it. Root tree: `760b05a7a7feacee16815da2767cb83dbb600d95`; application tree: `67f821a13c8470ceeb5222eb89d43cea58b1a8c8`; source tree: `72751dc5027d4b4a09356676a206ee5addfb56a9`. Lock SHA256: `294ba8ab0cd31f804a0d595c9f10a8edb39fdefcab60b84ef422e34cbc68fe38`.

## Qualification

| Evidence on unchanged frozen source | Result |
| --- | --- |
| Clean installation | 852 packages; source and lock unchanged |
| Canonical check | 94 root, 21 transport, 1,631 web, 288 Capiro and 385 Newsletter controls pass; declaration/type/format checks pass; lint 0 errors / 76 warnings |
| Architecture | 475 signals: 452 reviewed, 23 inherited, 0 blocking/errors |
| Elements | 15 offline controls and bounded SSR qualification pass |
| Public Newsletter Chromium | 116 renderer characterizations and 130 receiving cases pass |
| Production | One canonical Next production build passes; actual unconfigured standalone gates pass |
| Modules/Meri/Onboard browser | 297/297 pass; 2 workers, configured retries 0 |
| Original Portfolio shards | 285 pass; 297 pass + 1 ENOSPC failure; 273 pass; 283 pass |
| Explicit recovery | First selector attempt executes 0 tests and exits 1; corrected selector executes the original affected case once and passes |
| Unique Portfolio coverage | 1,139 discovered IDs successfully covered; 1,140 actual case executions including the original infrastructure failure; no missing original IDs, automatic retries, skips or flaky results |

The [completion receipt](direct/capiro-unified-final-83f54f5a-20261013/ALL-GATES-COMPLETE.json), [recovered ID aggregate](direct/capiro-unified-final-83f54f5a-20261013/portfolio-recovered-aggregate.json) and [aggregation source](direct/capiro-unified-final-83f54f5a-20261013/aggregate-recovered.py) preserve the exact distinction between initial results and recovery. Full original reporter JSON remains byte-exact. Each gate receipt records its command, timestamps, exit status and before/after source binding. Browser suites use the existing 30-second default and inherited per-test exceptions; recovery changes neither.

The [sealed independent completion review](late-additions/capiro-unified-83f54f5a-final-gate-independent-review-20261013/REPORT.md) independently reconstructs all1,139 original Portfolio IDs and the same failed/rerun ID, verifies all297 Modules IDs and all16 source receipts, and accepts only this bounded offline qualification with documented recovery. Its complete original manifest, case ledgers,69 raw-input bindings and three corrected audit-harness assumption failures are retained directly. Manifest SHA256: `bb7351a3dffe50db1fdfb4b9fd1dcb7d56e99d0f293c22173dffbd7a2d80e597`.

The actual standalone is credential-free and unconfigured. Its evidence includes 11 HTTP/header checks, four desktop/phone light/dark renders, bounded desktop mode/history and mobile entry/return checks, and preview-root behavior. The supplemental probe covers 23 requests, six served Onboard assets and 1440/375 setup/navigation states. The served Newsletter asset gate verifies all 179 assets. These observations do not establish authenticated service execution. Actual-server figures are in the direct frozen evidence; all raw outputs are in the archive.

## Preserve the failure and both recovery attempts

The original `mail-rich-compose.spec.ts:267` case, “keyboard formatting and mobile toolbar remain reachable,” fails at line 290 while creating its screenshot output directory. ENOSPC occurs after its preceding UI checks; the final unexpected-request assertion is not reached. The original failure is therefore not converted into a pass. Its [reporter JSON](direct/capiro-unified-final-83f54f5a-20261013/portfolio-shard-2-results.json), [exit receipt](direct/capiro-unified-final-83f54f5a-20261013/portfolio-shard-2-exit.json), log and original 411,258-byte trace are preserved. Trace SHA256: `e6f0aef8d152d6532bdc93b4257f1fd6595471f99c04d377173a50711d89853e`.

The [independent failure audit](direct/capiro-unified-83f54f5a-enospc-independent-review-20261013/REPORT.md) records the observed failure, unrun assertion and bounded recovery conditions. Its original pending status is retained. It does not prove that every possible product failure was excluded merely because the observed exception is storage-related.

After storage recovery, the first explicit selector used a start anchor that did not match Playwright's complete title. It produced “No tests found,” exit 1, with zero case executions. Both its [receipt](direct/capiro-unified-final-83f54f5a-20261013/portfolio-enospc-case-rerun-exit.json) and raw log/JSON remain. The separate [v2 receipt](direct/capiro-unified-final-83f54f5a-20261013/portfolio-enospc-case-rerun-v2-exit.json) records the corrected selector, one worker, unchanged original test and successful complete execution. The four original shards did not all pass, and this was not an uninterrupted first pass.

Storage actions retain their complete inventories and verification/retirement receipts. Four large historical generated runtime/Elements archives remain local and are listed in `OMITTED-HISTORICAL-ARCHIVES.json`; this packet independently rehashes their archive files without claiming to reconstruct their retired expanded originals. Browser evidence is preserved separately. No source or browser gate was rerun to create this publication.

## Reviewed corrections and visual/accessibility limits

The [source-preservation review](direct/capiro-unified-83f54f5a-source-preservation-independent-review-20261013/REPORT.md) binds the exact seven production-file changes, additive tests and unchanged original assertions/package boundaries. It also records the built static-client/manifest scans and installed public-package byte checks, with their limits. The [bounded integration review](direct/capiro-unified-a11y-integration-review-20261013/REPORT.md) preserves the pre-freeze review and its then-pending full qualification status.

The canonical-root current-page predicate and the six unfiltered default-axe regressions now have successful frozen-source coverage. Their original failing93 baselines remain in the separate [frozen93 packet](../qualification-93b3617f/README.md), including its original setup failures and Figma references. Those historical results are not added to83 execution counts.

Manual rendering review found a remaining selected-count contrast issue inside axe's incomplete results. The [original render review](direct/capiro-unified-a11y-render-review-20261013/review.md) remains unchanged. The [active-count addendum](direct/capiro-unified-a11y-render-review-20261013-active-count-addendum/review.md) records its bounded correction: inherit the selected button's white foreground. Direct independent light-theme All-count measurements at1440/390 show 12.45:1 hovered contrast and15.52–19.80:1 resting-gradient contrast. Its initial two failed fixture-routing attempts and corrected two-pass run remain intact. Owner evidence also retains the earlier four precondition failures, meaningful two-light-fail/two-dark-pass baseline and final six-pass contrast/axe run. No failure is replaced by a summary.

Empty axe violations do not resolve every incomplete result or establish WCAG conformity. Real assistive technology, every route/state, 400% zoom and full Figma parity remain unqualified. The preserved original3.1 Portfolio/Meri/Modules references and structural differences remain in the93 packet; no new visual baseline or accepted design is invented here. Screenshots using synthetic fixtures establish only those labelled compositions.

All **337 native Portfolio acceptance rows remain unaccepted**. Native identity/RLS, admitted Meri service composition, provider/task/payment effects, complete workspace behavior, the missing public Meri document receiving contract, target musl/image/ABI, deployed hosts and deployment remain outside this offline evidence. Host glibc and system Chromium154 are not image or AWS qualification.

## Distribution and byte verification

`SOURCES.json` enumerates 17 primary evidence roots. `SOURCE-FILES.json` maps every included original path to its logical restoration path, byte length and SHA256. `evidence-objects.tar.gz` stores identical bytes once as `objects/<sha256>`; all775 paths/129,051,529 raw bytes are represented by688 objects/83,428,058 unique bytes. The archive is35,175,556 bytes, SHA256 `8443a693ce2334fd776cfe472b6914bb717b3ce8989a2cbf879f882a7603a018`. Every member was reopened and its length/hash checked at creation and in a separate verification pass. This is publication-author verification, distinct from the independent reviews.

`DIRECT-FILES.json` binds selected unchanged reports, logs, receipts, Portfolio JSON and figures under `direct/`. Large Modules reporter JSON and generated bundles remain fully present in the archive rather than duplicated directly. Original report links may point to archived siblings; restore the logical tree to inspect all original relationships. Historical absolute local paths are provenance, not remote publication links.

`OMITTED-LOCAL-GRAPH.json` inventories excluded tool/bytecode files and borrowed symlinks without following them. Qualification metadata, generated SSR fixtures, license notices, raw traces, screenshots and failed attempts remain included. No original evidence was deleted. The query-credential URL scan reports its scoped heuristic and results; it is not exhaustive secret detection. The packet is evidence, not a runnable installed dependency graph.

Verify all archived bytes without source roots or dependencies:

```sh
python3 archive-evidence.py verify .
```

Restore regular evidence into an absent or empty directory when at least130MB of additional storage is available:

```sh
python3 archive-evidence.py restore . --destination /path/to/new-empty-evidence
```

The helper rejects unexpected members, symlinks/hardlinks and path traversal. Full filesystem restoration was not run in this constrained workspace; every archived object was read and hash-verified. The final independent completion packet and late remote-head receipt are included directly under `late-additions/`, with exact original source-path/hash bindings in `LATE-ADDITIONS.json`, without rewriting the primary archive. Their files are already expanded and are not part of the archive restore command. `PUBLICATION-MANIFEST.json` is the final inventory of the entire prepared packet. `verify-publication.py .` verifies that full inventory; `--originals` additionally rehashes the retained local evidence when those original paths remain available.
