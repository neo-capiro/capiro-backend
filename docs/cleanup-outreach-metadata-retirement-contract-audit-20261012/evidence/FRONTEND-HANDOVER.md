# Newsletter frontend preservation and port

This separate branch preserves the original 179 newsletter public assets at their existing `/newsletter/*` paths. All 486,014 decoded bytes match the original C/W Git blobs, byte lengths and pinned SHA-256 inventory. The 172 PNGs, five SVGs and two attribution/license files are unchanged. This is the first bounded slice of the rich newsletter port; it does not establish rich editor, delivery, native backend or deployed-origin acceptance.

The branch starts at frontend `adbc84b2251fe6b06cb7f75030026fba5b4ff498`. PR15 qualification and its later corrections remain on `integration/capiro-remaining-20261012`. No source under `apps/web/src`, shared shell/session/client/operation boundary, root manifest or lockfile changes in this slice. The current generic newsletter builder and exact saved-version OutreachV3 flow retain their original source.

## Source and evidence

- Backend handoff: [PR2424 at 5470c6df](https://github.com/neo-capiro/capirov2/blob/5470c6df029c9553dd49e531229c3c91b26275ef/docs/cleanup-newsletter-two-contract-reviewed-source-20261012/HANDOFF.md), frozen application source `a247f7a02a9b94d95e9ee5a516b396202aea994b`.
- Original C: `1e99f0921b207318c6d2abf03927b5c4daa5768b`; W: `193703e34f2bedbb69d87d6a8ee303f65ab8dbda`.
- [Scope audit](scope-audit/README.md) maps all 43 original runtime paths, 179 assets and 37 original test histories to current owners and missing behavior. The two different editor-test histories are retained.
- [Original-byte verification](asset-preservation/ASSET-BYTE-VERIFICATION.json) binds all asset bytes. Extraction used authorized GitHub base64 source reads at exact C, then checked every decoded Git blob, SHA-256 and length against the independently compared C/W manifest.
- [Static URL coverage](scope-audit/asset-url-coverage.json) covers all 168 social platform/style combinations, four fixed PNG paths, legacy SVG references and the template preview. This verifies source paths; old email origins and deployed serving remain unverified.

The source snapshots under `scope-audit/backend-source` are immutable reference evidence, not application imports or an additional backend implementation. No original generator was run and no asset was re-encoded.

Five copied directory receipts contained temporary GitHub download URL credentials. The publishable copies remove only those URL query strings, retaining source paths, refs, blobs, sizes and token-free origin/path URLs. [Publication redactions](PUBLICATION-REDACTIONS.json) binds original and sanitized hashes. The original audit index describes the sealed local receipts; the publication manifest records the sanitized committed bytes. Asset bytes are unchanged.

## Coordinated next slices

Follow the [implementation outline](scope-audit/OUTLINE.md). The backend already owns public `@capiro/shared/newsletter` and `@capiro/shared/newsletter-render` exports in `@capiro/shared@0.0.0`, over five pure modules. The inspected handoff does not supply a packed artifact with entry provenance and consumer qualification. The backend package owner must supply or identify that immutable distribution; the frontend integration owner will verify packed imports, declarations, browser-safe closure and render behavior before making vendor, manifest and lock changes. No replacement DTO, renderer, version or private-checkout import is proposed.

Modules Workspace will own the rich document/revision editor, assets and review; Modules Engagement will own the rich stage/legacy record destination. Thin compatibility routes use the existing shared application shell. The current Outreach record validator strips `metadata.newsletterStageId`; the port must preserve the canonical rich-record distinction before dispatching records to the proper editor. Its presence is not evidence of a live data-loss event.

Rich `WsNewsletterStage` UUIDs and saved `WsDocVersion` UUIDs remain separate. There is no conversion, bridge, alias or automatic migration into OutreachV3. Preserve the current version/hash/session acknowledgement and replay controls unchanged. Original meaningful tests are mapped as characterization requirements, not claimed as executed frontend tests.

Review GET and account-status GET may have effects; they are excluded from native probing. Future tests use refusing or intercepted collaborators. Real send/upload/provider/model, database/security, deployment and AWS actions remain outside this work. Full rich UI, native authorization/persistence, backend parser/full Workspace typing, deployed asset origin and desktop/mobile visual/accessibility acceptance remain open.

