# Stage 0 citation integrity

## Pipeline

MeriV3 extracts candidate sources from governed context and tool results, assigns markers in the range `[1]` through `[999]`, injects only numbered sources into the model prompt, and validates generated markers against that registry before release. In evidence-accuracy enforce mode, id-less sources use a deterministic SHA-1-derived `stableId`; overflow candidates are retained in the numbering result but are not prompt-visible. Shadow preserves legacy numbering and separately computes the enforce result for observability.

## Exposure points

The reply is validated in `finalizeReply`. Artifact `bodyText` is validated before each artifact event, and page-write bodies are validated before their event. Enforce strips orphan markers; shadow preserves text while reporting orphan incidence; off preserves the legacy path. Retrieval coverage disclosures are marker-free, and enforce validates again after appending them. Research reports are validated before persistence in enforce mode; Stage 0 does not alter their live delta stream.

## Observability

Orphan markers produce `meri.citation_integrity` structured warnings with:

- `conversationId` and `turnId` (nullable when no turn identifier exists)
- `surface`: `reply`, `artifact`, `page_write`, `research_report`, or `numbering`
- `dropped`: unresolved marker numbers
- `registered`: registered citation count
- `mode`: `shadow` or `enforce`

Warnings use the structured logger shape `logger.warn('meri.citation_integrity', fields)`. Numbering warnings are shadow-only and replace `dropped`/`registered` with `collisions` (distinct id-less rows legacy numbering collapsed) and `overflow` (stable candidates beyond `[999]`). They are omitted when both counts are zero.

## Web contract (T7)

When chat evidence accuracy is enforced, the API always emits a citations frame, including when its citation list is empty. That frame contains `evidenceAccuracy: "enforce"`. The same field is persisted in assistant-message metadata for reload. It is absent in off and shadow modes, preserving legacy rendering and frame behavior.

The web treats that field as the complete rendering gate:

| Surface | `evidenceAccuracy: "enforce"` | Signal absent (legacy/off/shadow) |
| --- | --- | --- |
| Answer prose | Registered markers become source chips; unresolved markers are removed even when the citation list is empty, with adjacent spacing normalized. | Registered markers become chips and unresolved markers remain literal. |
| Evidence inspector | Displays only each source's explicit `citationNumber`; unnumbered sources have no bracketed number. | Keeps the positional fallback for older payloads. |
| Artifact canvas | Registered markers become source chips and unresolved markers are removed in plain-text and structured Word/PDF previews. | Artifact text is unchanged. |
| Long links | Displayed URL text is shortened to host plus a truncated path while the full `href` and `title` are retained; answer/artifact text can wrap anywhere. | Existing link text and wrapping remain unchanged. |

The browser does not read rollout environment variables. Live turns obtain the signal from the citations frame; history reload obtains it from assistant-message metadata.
