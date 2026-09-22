# Stage 0 citation integrity

## Pipeline

MeriV3 extracts candidate sources from governed context and tool results, assigns markers in the range `[1]` through `[999]`, injects only numbered sources into the model prompt, and validates generated markers against that registry before release. In evidence-accuracy shadow/enforce mode, id-less sources use a deterministic SHA-1-derived `stableId`; overflow candidates are retained in the numbering result but are not prompt-visible.

## Exposure points

The reply is validated in `finalizeReply`. Artifact `bodyText` is validated before each artifact event, and page-write bodies are validated before their event. Enforce strips orphan markers; shadow preserves text while reporting orphan incidence; off preserves the legacy path. Retrieval coverage disclosures are marker-free, and enforce validates again after appending them. Research reports are validated before persistence in enforce mode; Stage 0 does not alter their live delta stream.

## Observability

Orphan markers produce `meri.citation_integrity` structured warnings with:

- `conversationId` and `turnId` (nullable when no turn identifier exists)
- `surface`: `reply`, `artifact`, `page_write`, or `research_report`
- `dropped`: unresolved marker numbers
- `registered`: registered citation count
- `mode`: `shadow` or `enforce`

## Web contract (T7)

When chat evidence accuracy is enforced, the API always emits a citations frame, including when its citation list is empty. That frame contains `evidenceAccuracy: "enforce"`. The same field is persisted in assistant-message metadata for reload. It is absent in off and shadow modes, preserving legacy rendering and frame behavior.
