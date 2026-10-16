# Independent Engagement orphan removal review

Source-only review on 2026-10-16 against sealed PR32 `0483963adc5382202408e8398d8b1601f53d8525`. Reviewed the actual Engagement working diff, the sealed initial-slice map/source manifest/name-pass evidence, `engagement-orphan-removal.json`, retained tests, governed factory and canonical gateway sources. Ordinary finite source/Git reads and in-memory source-byte comparison only; no Node, native test, parser, compiler, application, database, provider or helper-script execution. Only this review file was written.

**No concrete source blocker found for the admitted three-block removal.** The actual diff is zero additions and exactly 225 deletions from `apps/api/src/engagement/engagement.service.ts`; no import, constructor, public method, registry, DTO, provider, module or guard change accompanies it.

| Removed block in original 048 source | Original inclusive lines | Bytes | SHA256 of removed bytes |
| --- | ---: | ---: | --- |
| `outreachContext` | 9595–9644 | 2,131 | `91b8f149d26aa693527a72802c8d0184bfa0dc4f260eeded89266b50e42be07e` |
| `outreachVoiceFewShots`, including its own comment | 10281–10342 | 2,687 | `47011d25aa89c51eb331c4b0ac5a5acf5630034c34f8a275baa0effc912978c6` |
| `batchRecipientCorrespondence`, including its own comment | 10416–10528 | 4,756 | `6047cad8bed4362852cf4741e4a7ec5dabb963e8bd3a1719e87a8674c4cfccac` |

The initial map distinguishes 195 method lines from 225 complete block lines; the implemented removal is the latter, 220 nonblank lines and 9,574 bytes. Although the proposal allowed additional separator removal, the actual source comparison confirms that all bytes outside those exact three blocks, including separators, remain unchanged.

Independent in-memory comparison read the original Git-pinned source and current checkout bytes. Original length/hash are 506,538 / `78770fac56ac51c3af48674d07ea6b735490785dd73684265e54e861958cd3f9`; current length/hash are 496,964 / `0cf586f1034839239a40a135aa384b99846815d6fb52f5db16611f5bf6b9ad8a`. Removing exactly the recorded original byte ranges reproduces every current byte. Reinserting the original ranges at the receipt's after-file insertion offsets reconstructs every original byte and its original hash. Each removed-block hash independently matches the receipt. No original body copy was persisted by this review.

## Source reference closure and active gateway

The captured `engagement-orphan-exact-name-pass-048` receipt pins the source commit, search operands and finite tracked `apps packages scripts tests infra` scope. Within word-boundary matches for the three exact identifiers, its results contain only three private declarations, two explanatory comments, and four fixture assignments. There is no production invocation, alias assignment, method registration or callback capture using those exact names. Similar identifiers such as `outreachContextLibrary` are separate symbols.

The four `batchRecipientCorrespondence` references in batch specs assign an async fixture property; they do not invoke the removed implementation. The owner-isolation comment describes the legacy loader while its setup stubs the current gateway handoff. The governed factory's explicit method interface/runtime map does not register any removed method.

The actual service still unconditionally returns `generateBatchEmailsViaGateway` at the batch-generation seam and calls `this.gateway.generate` in that path. The gateway still resolves the governed Context Plane and uses the structured author style profile rather than raw sent-email examples. Empty diffs against 048 confirm the canonical gateway, Context Plane, style profile, governed factory, Engagement module, and Phase20 gateway source contract remain byte-identical. This establishes unchanged source ownership; it does not assert old/new enrichment-output parity or production adoption.

## Retained meaningful contracts

Empty diffs against 048 confirm these native files are unchanged, including their case identities and assertions:

- Seven directly invoking `engagement-intel-context.spec.ts` cases at 113, 127, 142, 154, 168, 185 and 212. `enrichOutreachContextItems` and its patched descendants remain under their existing test-contract hold. The exact source inverse also preserves `recentClientMeetingsForOutreach`, people/target-office helpers, `peTruthBlock`, `outreachTargetRecommendations` and public `billTruthBlock`.
- Eleven batch cases: group at 136/150/176, error-status at 105/124, sticky-provider at 116/130/146, revision at 139/155/174. All four harmless historical setup assignments remain unchanged.
- Two exported scrubber cases in `outreach-channels.spec.ts` at 61/72; exported `scrubPiiForVoice` remains unchanged. Other shared/global helper bodies also remain outside the removed ranges.

## Limits

The non-invocation finding is bounded to the admitted exact-identifier source proof. It does not prove absence of external runtime reflection or names synthesized from string fragments, nor does it authorize broader private-subtree, service, worker or runtime retirement. Both Core and standalone Engagement runtime profiles remain supported source owners. Native assertions are preserved, not newly executed or qualified by this review. Source-size reduction and exact-byte preservation do not establish build, runtime, provider, image, platform, security-policy or deployment acceptance.
