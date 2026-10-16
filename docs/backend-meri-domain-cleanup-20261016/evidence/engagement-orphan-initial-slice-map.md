# Engagement initial orphan-method slice

Read-only map at `0483963adc5382202408e8398d8b1601f53d8525` (sealed PR32). Proposed application write scope: **only three private method blocks in `apps/api/src/engagement/engagement.service.ts`**. No implementation or tests were run for this map.

Source: mode `100644`, Git blob `6eb8259f7eb77f64c6ab41d403480ac1ea3f1e82`, 506,538 bytes, 12,528 physical lines. The machine-readable bounds/counts are in `engagement-orphan-initial-slice-source-manifest.json`; exact retained source/test blobs are in `engagement-initial-slice-source-manifest-048.txt`.

| Method | Method body, inclusive | Physical / nonblank | Proposed block including its own comment | Physical / nonblank |
| --- | --- | --- | --- | --- |
| `outreachContext` | 9595–9644 | 50 / 49 | 9595–9644 | 50 / 49 |
| `outreachVoiceFewShots` | 10288–10342 | 55 / 55 | 10281–10342 | 62 / 62 |
| `batchRecipientCorrespondence` | 10439–10528 | 90 / 86 | 10416–10528 | 113 / 109 |
| Total | | **195 / 190** | | **225 / 220** |

Line counts describe the exact original inclusive blocks. An eventual diff may additionally remove blank separators. This is a bounded, behavior-preserving orphan removal proposal, not retirement of the Engagement class/process or its other enrichment helpers.

## Entry and call graph

- Core `apps/api/src/main.ts:19` creates `AppModule`; `app.module.ts:104` registers `EngagementModule`.
- `apps/api/src/engagement-main.ts:17` creates `EngagementApiAppModule`; `engagement-api.app.module.ts:41` registers the **same** `EngagementModule`. `apps/engagement-api/Dockerfile:11` documents the same compiled API source and line 110 copies that API output. Its serve-only `scripts/entrypoint.sh:48` executes `dist/engagement-main.js`. This is a second runtime profile, not a duplicate source implementation eligible for deletion.
- `engagement.module.ts:187` registers raw `EngagementService`; lines 188–199 expose its governed factory. `governed-engagement.factory.ts:20` names the patched methods, lines 33–56 name runtime-guarded methods, and lines 159–175 bind through a proxy. None of the three proposed names is patched or registered. The constructor's sole reader registration is `setAttachmentReader(...readAttachmentBytes...)` at service line 1116; it does not capture these methods.
- `generateBatchEmails:3739` performs ownership/versioning and budget checks, then **unconditionally** returns `generateBatchEmailsViaGateway` at 3797. The helper calls `this.gateway.generate` at 3976. No candidate is an entrypoint/lifecycle method, registered callback, public controller method, or runtime-policy method.
- All three names have **no invocation** in the finite tracked `apps packages scripts tests infra` exact-name pass. Its word-boundary matches are only the three declarations, two explanatory comments, and four test-arrange assignments listed below. `outreachContextLibrary` and schema names containing the substring `outreachContext` are different identifiers.

## Candidate dependencies and active replacements

| Candidate | Its outgoing dependencies | Current production path retained |
| --- | --- | --- |
| `outreachContext` | `listMeetingNotes`, `listMeetingDebriefs`, `clientContext`, `recentClientMeetingsForOutreach`, directory email lookup, `renderClientRelationshipSnapshot`, `pruneForAi`, metadata merge | Gateway `generation-gateway.service.ts:340` resolves the governed Context Plane. `outreach-context-plane.service.ts:125` derives server-owned tenant/actor authorization; its domains at 29–57 include mail/meetings and relationship-history domains. Its current tests at 147, 169, 206, 274, 366, 383, 408 remain. No exact legacy-output parity is asserted by this map. |
| `outreachVoiceFewShots` | Client/tenant/author-scoped sent-record query, exported `scrubPiiForVoice` | Gateway lines 445–453 use `AuthorStyleProfileService.getProfile` with projected governed voice. `author-style-profile.service.ts:4–22` identifies structured style as the replacement for raw examples; lines 222–250 require consent and same-client scope. Its ten current cases remain. |
| `batchRecipientCorrespondence` | Scoped meeting query, `ownMeetingWhere`, `listMailThreads`, `threadParticipantEmails` | Governed relationship-history retrieval is selected at `outreach-context-plane.service.ts:297–305`; current gateway per-recipient enrichment remains in service lines 4112–4253, including prior outreach at 4242. This map does not claim the old two-query output is interchangeable with a governed packet. |

Keep all imports, constructor dependencies, shared/global helpers, public methods and the gateway-enrichment subset. In particular, preserve `scrubPiiForVoice:12318` and its two native tests (`outreach-channels.spec.ts:61,72`), `pruneForAi` (many active callers), `threadParticipantEmails:11805` (outside the exact three-block claim), and public `billTruthBlock:9836`. No API, DTO, gateway, provider, feature flag, authorization, schema or migration change is required.

## Native tests: assignments and concrete hold

The only `batchRecipientCorrespondence` references outside its declaration are assignments to `Record<string, unknown>` fixture objects, never calls:

| File under `apps/api/src/engagement` | Assignment | Existing cases retained, by starting line |
| --- | --- | --- |
| `engagement-batch-group.spec.ts` | 117–120 | 136 individual enrichment; 150 group suppression; 176 shared personalized note |
| `engagement-batch-error-status.spec.ts` | 95–98 | 105 error status; 124 explicit status on every result |
| `engagement-batch-sticky-provider.spec.ts` | 100–103 | 116 identity resolved once; 130 caller pin wins; 146 first failure stays pinned |
| `engagement-batch-revise.spec.ts` | 91–94 | 139 single revision; 155 multi-recipient ordinary generation; 174 no existing body |

These **11 case identities and the harmless historical assignments can remain byte-for-byte**. `engagement-owner-isolation.spec.ts:403` only explains why the old loader is no longer used; line 404 stubs the actual gateway handoff instead.

**Do not classify the remaining private subtree as retired.** `engagement-intel-context.spec.ts` reflectively invokes `enrichOutreachContextItems` and owns seven concrete cases:

- 113: fetched intel packet forwards client/auth/alert identifiers.
- 127: unverifiable intel becomes an honest gap, never `undefined`.
- 142: null client does not call packet service.
- 154: other kinds remain unaffected.
- 168: profile off preserves packet and missing relationship fields.
- 185: profile on fills people/offices/recent meetings and drops exactly those unknowns.
- 212: no relationship fetch when no item is intel-kind.

Keep that method, `recentClientMeetingsForOutreach`, `peTruthBlock`, people/target-office helpers and `outreachTargetRecommendations` under this explicit test-contract hold. Their broader retirement would require a separate reviewed migration of meaningful assertions; canonical packet existence alone is insufficient proof.

## Whole-file readers and qualification implications

Finite source-reader search found these meaningful contracts; none requires the three private bodies:

- `generation/phase-20-outreach-context-plane.contract.spec.ts:45–60` reads the service and requires `this.gateway.generate`; keep it unchanged.
- `runtime/engagement-runtime-boundary-map-coverage.spec.ts:120–149,168–175` parses public methods and explicitly excludes private/protected/static members. All mapped public methods stay unchanged.
- `memory/memory-private-fail-closed.spec.ts:95–110` checks the fail-closed `loadUserVoiceBlock` body; keep it unchanged.
- `engagement-dependency-manifest.spec.ts:62–74,103–145` generates import edges and preserves historical baseline integrity. No import is being changed.
- `apps/api/scripts/verify-mail-thread-covering-index.cjs:177–185` imports the actual service and records its whole-file hash in a fresh receipt. That is provenance for a real DB verifier, not a fixed old-hash acceptance assertion. Do not run it in this source-only slice or rewrite old receipts.
- `scripts/outreach-v3-p1-change-scope.spec.mjs:86–104,208–215` correctly classifies service changes as product changes; retain that attribution rather than exempting this cleanup.
- UI inventory and infra hits are explanatory evidence/comment pointers (including an unaffected earlier method at line 2515). The measured source list in `apps/e2e/lib/source-identity.mjs:54–98` contains rendered frontend/shared inputs, not `apps/api/src`; historical frontend replay remains separately owned.

No fixed whole-file hash assertion was found in the bounded exact source/import/helper reader pass. Historical published-source pins and prior receipts must remain historical; any new source receipt must identify the new commit honestly. No native/framework qualification has been performed here.

## Evidence and next action

- `engagement-orphan-exact-name-pass-048.{stdout,stderr,receipt.json}`: exact-name pass, Git exit **0**, source pinned to 048; stdout SHA256 `00a627a1f3292756bb3da06f16a0542f1d9ebdf7bf32a65c5aa6c03ca65bbfa9`.
- `engagement-initial-slice-gate-refs-048.{stdout,stderr,receipt.json}`: exact literals in scripts/tests/infra/E2E, Git exit **0**.
- `engagement-initial-slice-source-readers-048.{stdout,stderr,receipt.json}`: finite service-import/helper literals across tracked source scopes, Git exit **0**.
- `engagement-successor-methods-048.txt`, `engagement-successor-consumers-048.txt`, `engagement-worker-ownership-048.txt`: bounded method/production caller/timer ownership reads. Active workers and feature-gated V3 exceptions remain live source; disabled default dispatch is not retirement proof.

Root may seal this map, then allocate exactly the three blocks above. All seven enrichment tests and all eleven batch cases remain; no test deletion or test-ID rename is proposed. Quick removal/reference/diff checks and any native regression execution remain for the root's coordinated queue. No deployment, process/image retirement, live-data action, permission change or source modification was executed by this analysis.
