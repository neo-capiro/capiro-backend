/*
 * Context Steward (Stage E) — pure prompt/tool/sanitize logic (no network, no
 * DI), mirroring strategy-prompt.ts. The Steward reads ONE context document and
 * extracts atomic facts anchored to a CLOSED SET of source refs (api-strategy's
 * markdown-locate anchors — 'heading:<text>' / 'row:<heading>:<n>'), pairing
 * conflicts against the caller-supplied existing-fact digest. THE STEWARD NEVER
 * MUTATES STRATEGY NODES — extraction + conflict detection only; api-strategy
 * persists into sp_context_* and re-validates authoritatively (this sanitize is
 * a first pass).
 */

// ---- request/response shapes (wire contract 1 — api-strategy ⇄ orchestrator) ----

/** One locate anchor from the document (the ONLY legal sourceRef values). */
export interface StewardRef {
  ref: string;
  kind: 'heading' | 'row';
  preview: string;
}

/** One already-persisted fact, for conflict pairing (ids are SpContextFact ids). */
export interface StewardExistingFact {
  id: string;
  fact: string;
  documentTitle: string;
  authority: string | null;
  asOf: string | null;
}

/** POST /meri-api/steward-extract request body. */
export interface StewardExtractInput {
  clientId: string;
  documentId: string;
  templateKey: string;
  authority: string | null;
  asOf: string | null;
  content: string;
  refs: StewardRef[];
  existingFacts: StewardExistingFact[];
}

/** One extracted fact (sanitized; null authority/asOf = inherit the document's). */
export interface ExtractedFact {
  fact: string;
  sourceRef: string;
  authority: string | null;
  asOf: string | null;
  confidence: number;
  citation: string;
}

/** One new-vs-existing conflict pair (newFactIndex indexes the facts array). */
export interface ExtractedConflict {
  newFactIndex: number;
  existingFactId: string;
  material: boolean;
  rationale: string;
}

/** POST /meri-api/steward-extract response body. */
export interface StewardExtractResult {
  facts: ExtractedFact[];
  conflicts: ExtractedConflict[];
  summary: string;
}

// ---- terminal tool ----

const MAX_FACTS = 80;
const MAX_CONFLICTS = 20;
const MAX_FACT_CHARS = 2000;
const MAX_CITATION_CHARS = 1000;
/** Prompt guards: a runaway document/preview never blows the context window. */
const MAX_CONTENT_CHARS = 60_000;
const MAX_PREVIEW_CHARS = 200;

export const EMIT_EXTRACTED_FACTS_TOOL = {
  name: 'emit_extracted_facts',
  description:
    'Report every atomic fact extracted from the document, each anchored to EXACTLY one sourceRef from the closed-set anchor inventory, plus any conflicts against the existing facts. Extraction is your ONLY job — never draft strategy or propose plan changes. Omit authority/asOf on a fact to inherit the document frontmatter values.',
  // A7 idiom (see PROPOSE_STRATEGY_DRAFT_TOOL): constrained decoding on models
  // that support it — stripped otherwise by request-scoped-llm.client's
  // modelSupportsStrict gate; sanitizers below remain the invariant.
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description: 'A 1-2 sentence summary of what was extracted (counts, notable gaps/conflicts).',
      },
      facts: {
        type: 'array',
        maxItems: MAX_FACTS,
        description: 'The extracted atomic facts, in document order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fact: {
              type: 'string',
              description:
                'ONE atomic, self-contained factual statement (a single subject + claim that stands alone without the document).',
            },
            sourceRef: {
              type: 'string',
              description:
                "EXACTLY one ref from the closed-set anchor inventory ('heading:<text>' or 'row:<heading>:<n>'). Never invent an anchor.",
            },
            authority: {
              type: 'string',
              description:
                'OMIT to inherit the document frontmatter authority. Set ONLY when the text itself attributes the claim differently.',
            },
            asOf: {
              type: 'string',
              description:
                "OMIT to inherit the document's as_of date. Set (YYYY-MM-DD) ONLY when the row/line carries its own date.",
            },
            confidence: {
              type: 'number',
              description:
                '0..1 — how directly the source text states this fact (1 = verbatim claim; lower for inference).',
            },
            citation: {
              type: 'string',
              description: 'The verbatim source text the fact came from (short quote).',
            },
          },
          required: ['fact', 'sourceRef', 'confidence', 'citation'],
        },
      },
      conflicts: {
        type: 'array',
        maxItems: MAX_CONFLICTS,
        description:
          'Pairs where a NEW fact and an EXISTING fact cannot both be true. Empty when none.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            newFactIndex: {
              type: 'integer',
              description: '0-based index into the facts array above.',
            },
            existingFactId: {
              type: 'string',
              description: 'The id of the conflicting existing fact (from the digest).',
            },
            material: {
              type: 'boolean',
              description:
                'true when acting on the wrong fact would change strategy or embarrass the client.',
            },
            rationale: { type: 'string', description: 'Why the two cannot both be true.' },
          },
          required: ['newFactIndex', 'existingFactId', 'material', 'rationale'],
        },
      },
    },
    required: ['summary', 'facts', 'conflicts'],
  },
} as const;

// ---- sanitizers (first pass; api-strategy re-validates authoritatively) ----

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Normalize the raw tool output's `facts`: drop malformed entries (non-object /
 * missing fact / missing sourceRef / non-numeric confidence), clamp confidence
 * to 0..1, fact to 2000 chars, citation to 1000. Order is PRESERVED (no sort).
 * The model's conflicts index facts by their RAW array position, so alongside
 * the sanitized facts this returns the raw-index → sanitized-index map —
 * sanitizeConflicts remaps through it so a dropped malformed fact never shifts
 * a later conflict onto the wrong fact.
 */
export function sanitizeExtractedFactsIndexed(raw: unknown): {
  facts: ExtractedFact[];
  rawIndexToSanitized: Map<number, number>;
} {
  const facts: ExtractedFact[] = [];
  const rawIndexToSanitized = new Map<number, number>();
  if (!Array.isArray(raw)) return { facts, rawIndexToSanitized };
  for (let i = 0; i < raw.length && facts.length < MAX_FACTS; i++) {
    const f = raw[i] as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') continue;
    const fact = str(f.fact)?.slice(0, MAX_FACT_CHARS);
    const sourceRef = str(f.sourceRef);
    const confidence =
      typeof f.confidence === 'number' && Number.isFinite(f.confidence)
        ? clamp01(f.confidence)
        : undefined;
    if (fact === undefined || sourceRef === undefined || confidence === undefined) continue;
    rawIndexToSanitized.set(i, facts.length);
    facts.push({
      fact,
      sourceRef,
      // Nullable-by-omission (wire contract 1): a missing/blank authority or
      // asOf means "inherit the document frontmatter value" → null here.
      authority: str(f.authority) ?? null,
      asOf: str(f.asOf) ?? null,
      confidence,
      citation: typeof f.citation === 'string' ? f.citation.slice(0, MAX_CITATION_CHARS) : '',
    });
  }
  return { facts, rawIndexToSanitized };
}

/** Sanitized facts only (see sanitizeExtractedFactsIndexed). */
export function sanitizeExtractedFacts(raw: unknown): ExtractedFact[] {
  return sanitizeExtractedFactsIndexed(raw).facts;
}

/**
 * Normalize the raw tool output's `conflicts`: drop malformed entries, then
 * REMAP each newFactIndex from its RAW facts-array position (what the model
 * emitted against) to the SANITIZED position via the map from
 * sanitizeExtractedFactsIndexed. A conflict whose raw index was dropped (or
 * never existed) is dropped with it — never silently re-paired with whichever
 * fact shifted into that slot. api-strategy re-validates before persisting.
 */
export function sanitizeConflicts(
  raw: unknown,
  rawIndexToSanitized: ReadonlyMap<number, number>,
): ExtractedConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      newFactIndex: Number.isInteger(c.newFactIndex)
        ? rawIndexToSanitized.get(c.newFactIndex as number)
        : undefined,
      existingFactId: str(c.existingFactId),
      material: c.material === true,
      rationale: typeof c.rationale === 'string' ? c.rationale.slice(0, MAX_CITATION_CHARS) : '',
    }))
    .filter(
      (c): c is ExtractedConflict =>
        c.newFactIndex !== undefined && c.existingFactId !== undefined,
    )
    .slice(0, MAX_CONFLICTS);
}

// ---- system prompt ----

const STEWARD_PERSONA =
  'You are the Context Steward for a government-affairs strategy platform. You read ONE client context document and extract atomic, source-anchored facts, then pair conflicts against the facts already on record. You NEVER draft strategy, NEVER propose plan changes, and NEVER invent information — extraction and conflict detection only.';

function renderRefs(refs: StewardRef[]): string {
  if (!refs.length) return '(the document exposed no anchors — extract nothing)';
  return refs
    .map((r) => `- ${r.ref} (${r.kind}) — ${(r.preview ?? '').slice(0, MAX_PREVIEW_CHARS)}`)
    .join('\n');
}

function renderExistingFacts(facts: StewardExistingFact[]): string {
  if (!facts.length) return '(no existing facts on record — the conflicts array must be empty)';
  return facts
    .map(
      (f) =>
        `- [${f.id}] ${f.fact} (${f.documentTitle}; ${f.authority ?? 'unattributed'}; as of ${f.asOf ?? 'undated'})`,
    )
    .join('\n');
}

export function buildStewardSystemPrompt(input: StewardExtractInput): string {
  return [
    STEWARD_PERSONA,
    `# Document\nTemplate: ${input.templateKey}\nAuthority (frontmatter): ${input.authority ?? 'unattributed'}\nas_of (frontmatter): ${input.asOf ?? 'undated'}\n\n${input.content.slice(0, MAX_CONTENT_CHARS)}`,
    `# Source anchors (CLOSED SET)\nEvery fact's sourceRef must be cited from this inventory. Cite sourceRef ONLY from this list — do not invent anchors:\n${renderRefs(input.refs)}`,
    [
      '# Extraction rules',
      '- Atomic facts: one subject + one claim per entry, self-contained (readable without the document).',
      '- Separate facts from assumptions: extract stated facts as facts; a stated assumption/aspiration must be phrased as one ("The client assumes ..."), never presented as settled fact.',
      '- authority: keep the authority from the frontmatter (OMIT the field) unless the text itself attributes the claim differently — only then set it.',
      "- asOf: the document's as_of applies (OMIT the field) unless a row carries its own date — then use that row's date (YYYY-MM-DD).",
      '- NEVER extract credentials, passwords, access tokens, or personal data beyond names and roles.',
      '- confidence: 1.0 for a verbatim claim; lower it the more you had to infer.',
      '- citation: quote the source text verbatim (short).',
    ].join('\n'),
    `# Existing facts on record (for conflict pairing)\n${renderExistingFacts(input.existingFacts)}\n\nFlag a conflict ONLY when two facts cannot both be true; material=true when acting on the wrong one would change strategy or embarrass the client. Pair conflicts by the existing fact's id exactly as shown above.`,
    '# How to answer\nCall emit_extracted_facts with the summary, the facts (each anchored to one listed sourceRef), and any conflicts. Nothing extractable → empty facts array.',
  ].join('\n\n');
}
