# Client document retrieval and task completion

## Problem

A client transcript could be present and readable while chat selected the research-session evidence tool, which requires a different kind of session. After the user clarified the file location, the next turn could lose the original meeting/contact request and stop after the first few transcript pages. Normal model termination was reported as completion despite unread text.

## Changes

- Preserve the original document request across adjacent file-location corrections. API history lookup follows the existing tenant/user conversation authorization and reads at most four user messages.
- Start client document requests by listing the selected client's files. Keep `get_research_evidence` available only for an authenticated active research run, and bind its session ID on the server.
- Follow canonical cursors for documents selected by the model. Every page uses the existing authorization, cancellation, deadline, evidence projection and citation pipeline. Automatic reads are limited to 24 per turn and preserve synthesis time.
- Require contiguous text from every section of the same document version before declaring a complete document review. An isolated final page, truncated projection or search snippet does not prove a full read. Preserve the existing separation between client-document coverage and other retrieval domains, including any initial retrieval gaps.
- Allow two continuation requests when the model stops with outstanding document or requested contact-research work. If the work remains incomplete, report the specific gaps and set partial-result telemetry. If no document text was read, suppress unsupported model prose about its contents or an alleged upload failure.

## Validation

The fixtures use synthetic client names, transcript text and provider responses. They cover a three-turn location correction, meeting targets after character 35,000, premature synthesis, contact lookup, invalid research-session selection, authenticated session binding, access revocation, cancellation, read limits, repeated cursors, multiple documents, missing search matches, projection truncation and source coverage.

- 86 tests passed across six orchestrator suites: document completion, assistant, turn coverage, clean assistant, retrieval assistant and authenticated context.
- 118 tests passed across three API suites: context plane, document read helpers and MeriV3 proxy.
- Shared package build and orchestrator TypeScript check passed.
- The full API TypeScript check could not pass with the locally available generated Prisma client. It lacks schema models/fields such as `AdminBroadcast` and `CommitteeHearing.legislativeSession`. No diagnostics named the changed context-plane files. The affected API test suites passed.
- `git diff --check` passed.

## Scope and release

Implemented on `codex/meri-document-completion`. Deploy API and orchestrator with the updated shared package and record the exact merge SHA and image digests in the release evidence. This change requires no database migration or tenant model-setting change.

Document selection remains model-driven. The coordinator proves coverage of selected documents and that requested contact research was attempted; it does not prove that every relevant file was selected or every person's identity was verified. The response instructions require unresolved identities and contact details to remain explicit. Live provider behavior still needs verification during rollout.
