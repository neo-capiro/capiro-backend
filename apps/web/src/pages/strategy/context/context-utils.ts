/*
 * Stage D context-document pure helpers: response normalizers (tolerant of a
 * bare array vs a wrapped object envelope), the derived STALE flag, the
 * 400-body field-error parser the upload modal renders, and the locate →
 * highlight-range resolver. All pure (vitest-covered, no React/network).
 */
import type {
  ContextConflict,
  ContextConflictFact,
  ContextConflictState,
  ContextDocumentDetail,
  ContextDocumentListItem,
  ContextFact,
  ContextFactState,
  ContextFieldError,
  ContextHealth,
  ContextLocateResult,
  ContextSection,
  ExtractFactsResult,
  OpenMaterialConflict,
} from '../types.js';

// ---- response normalizers -------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Accepts `[…]` or `{ documents: […] }` / `{ items: […] }`. */
export function normalizeDocumentList(data: unknown): ContextDocumentListItem[] {
  if (Array.isArray(data)) return data as ContextDocumentListItem[];
  if (isRecord(data)) {
    const inner = data.documents ?? data.items;
    if (Array.isArray(inner)) return inner as ContextDocumentListItem[];
  }
  return [];
}

/** Accepts the document itself or a `{ document: … }` envelope. */
export function normalizeDocument(data: unknown): ContextDocumentDetail {
  if (isRecord(data) && !('id' in data) && isRecord(data.document)) {
    return data.document as unknown as ContextDocumentDetail;
  }
  return data as ContextDocumentDetail;
}

/** Accepts `[…]` or `{ sections: […] }`; tolerates heading/title/text naming. */
export function normalizeSections(data: unknown): ContextSection[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.sections)
      ? data.sections
      : [];
  const out: ContextSection[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const heading =
      typeof item.heading === 'string'
        ? item.heading
        : typeof item.title === 'string'
          ? item.title
          : typeof item.text === 'string'
            ? item.text
            : null;
    const ref =
      typeof item.ref === 'string'
        ? item.ref
        : typeof item.anchor === 'string'
          ? item.anchor
          : typeof item.id === 'string'
            ? item.id
            : heading;
    if (!ref || heading === null) continue;
    out.push({
      ref,
      heading,
      level: typeof item.level === 'number' ? item.level : typeof item.depth === 'number' ? item.depth : 2,
      line:
        typeof item.line === 'number'
          ? item.line
          : typeof item.startLine === 'number'
            ? item.startLine
            : null,
    });
  }
  return out;
}

/** Accepts startLine/endLine (or start/end) + optional lines/snippet echo. */
export function normalizeLocate(data: unknown, ref: string): ContextLocateResult {
  const d = isRecord(data) ? data : {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const startLine = num(d.startLine) ?? num(d.start) ?? num(d.fromLine) ?? num(d.line);
  const endLine = num(d.endLine) ?? num(d.end) ?? num(d.toLine) ?? startLine;
  let lines: string[] | null = null;
  if (Array.isArray(d.lines) && d.lines.every((l) => typeof l === 'string')) {
    lines = d.lines as string[];
  } else if (typeof d.snippet === 'string') {
    lines = d.snippet.split('\n');
  } else if (typeof d.text === 'string') {
    lines = d.text.split('\n');
  }
  return { ref: typeof d.ref === 'string' ? d.ref : ref, startLine, endLine, lines };
}

// ---- derived STALE --------------------------------------------------------

/**
 * UTC YYYY-MM-DD (validUntil is a date column — compare lexically). UTC, not
 * local: the server's staleness cutoff is the UTC calendar day
 * (context-documents.service isStale), so the chip and the API must agree
 * around midnight.
 */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A doc is STALE when it is still current (draft/active) but its staleness
 * horizon has passed. Superseded/archived docs are already out of rotation —
 * no amber chip. Falls back to front-matter `valid_until` when the column is
 * null (older rows).
 */
export function isContextDocStale(
  doc: Pick<ContextDocumentListItem, 'state' | 'validUntil' | 'frontmatter'>,
  today: string = todayIso(),
): boolean {
  if (doc.state !== 'active' && doc.state !== 'draft') return false;
  const fmValid = doc.frontmatter?.valid_until;
  const horizon = doc.validUntil ?? (typeof fmValid === 'string' ? fmValid : null);
  if (!horizon) return false;
  const iso = horizon.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso < today;
}

/**
 * Only current documents (draft/active) can be archived. The server 409s
 * unconditionally on the other two states — archived rows already are, and a
 * superseded row is retained history ("archive the active document instead",
 * context-documents.service) — so the view must not render an Archive button
 * that can never succeed.
 */
export function canArchiveContextDoc(state: ContextDocumentListItem['state']): boolean {
  return state === 'draft' || state === 'active';
}

/**
 * Stage E "Extract facts" button visibility contract. The extract route is
 * gated server-side on BOTH agenticMeri (class AgenticGuard) AND the
 * steward-specific contextSteward flag (method-level ContextStewardGuard), so
 * showing the button on agenticMeri alone yields a guaranteed 403 for tenants
 * without the steward opt-in. It also 409s unconditionally on non-active
 * documents ("only an active document can be extracted", steward.service) —
 * so the view must not render a button that can never succeed. Both feature
 * bits are optional (older cached /me shape) and degrade to hidden.
 */
export function canExtractContextFacts(
  features: { agenticMeri?: boolean; contextSteward?: boolean } | undefined,
  state: ContextDocumentListItem['state'],
): boolean {
  return Boolean(features?.agenticMeri) && Boolean(features?.contextSteward) && state === 'active';
}

/** Front-matter scalar → display string (null/absent → null). */
export function fmScalar(
  frontmatter: ContextDocumentListItem['frontmatter'],
  key: string,
): string | null {
  const v = frontmatter?.[key];
  if (v === null || v === undefined) return null;
  return String(v);
}

/** "03_ask_and_options" → "Ask and options" (group header label). */
export function templateLabel(templateKey: string): string {
  const stripped = templateKey.replace(/^\d+[_-]/, '').replace(/[_-]+/g, ' ').trim();
  if (!stripped) return templateKey;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// ---- 400-body field errors ------------------------------------------------

export interface UploadErrorView {
  general: string;
  fields: ContextFieldError[];
}

const GENERAL_FALLBACK = 'The document failed validation and was not saved.';

/**
 * Parses the upload 400 body into a general failure message + field-level
 * errors. Tolerates the plausible server shapes:
 *   { message, errors: [{ field|path, message }] }
 *   { message, fieldErrors: { field: msg | [msgs] } }
 *   { message: ['field: msg', 'plain msg'] }   (Nest ValidationPipe style)
 *   { message: 'plain msg' }
 * Anything unrecognized degrades to the general message alone.
 */
export function parseUploadError(err: unknown): UploadErrorView {
  const resp = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  const body = isRecord(resp?.data) ? resp.data : null;
  if (!body) return { general: GENERAL_FALLBACK, fields: [] };

  const fields: ContextFieldError[] = [];
  let general = typeof body.message === 'string' ? body.message : GENERAL_FALLBACK;

  const pushField = (field: unknown, message: unknown) => {
    if (typeof field === 'string' && field && typeof message === 'string' && message) {
      fields.push({ field, message });
    }
  };

  const errors = body.errors ?? body.fieldErrors ?? body.details;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (isRecord(e)) pushField(e.field ?? e.path ?? e.property, e.message ?? e.error);
      else if (typeof e === 'string') splitFieldMessage(e, pushField, () => {});
    }
  } else if (isRecord(errors)) {
    for (const [field, msg] of Object.entries(errors)) {
      if (typeof msg === 'string') pushField(field, msg);
      else if (Array.isArray(msg)) for (const m of msg) pushField(field, m);
    }
  }

  // Nest ValidationPipe: message is a string[] mixing "field: msg" and prose.
  if (Array.isArray(body.message)) {
    const generalLines: string[] = [];
    for (const line of body.message) {
      if (typeof line !== 'string') continue;
      splitFieldMessage(line, pushField, (prose) => generalLines.push(prose));
    }
    general = generalLines.length > 0 ? generalLines.join(' ') : GENERAL_FALLBACK;
  }

  return { general, fields };
}

/** "as_of: must be an ISO date" → field error; anything else → prose. */
function splitFieldMessage(
  line: string,
  onField: (field: string, message: string) => void,
  onProse: (line: string) => void,
): void {
  const m = /^([A-Za-z0-9_.[\]-]+):\s+(.+)$/.exec(line.trim());
  if (m) onField(m[1]!, m[2]!);
  else onProse(line);
}

// ---- Stage E: Steward response normalizers ---------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const FACT_STATES: readonly ContextFactState[] = ['active', 'superseded', 'stale', 'rejected'];
const CONFLICT_STATES: readonly ContextConflictState[] = ['open', 'resolved', 'dismissed'];

/** Accepts `[…]` or `{ facts: […] }` / `{ items: […] }`; tolerates a nested `document`. */
export function normalizeFacts(data: unknown): ContextFact[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.facts)
      ? data.facts
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  const out: ContextFact[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.fact !== 'string') continue;
    const doc = isRecord(item.document) ? item.document : null;
    out.push({
      id: item.id,
      documentId: str(item.documentId) ?? str(doc?.id) ?? '',
      clientId: str(item.clientId) ?? str(doc?.clientId),
      fact: item.fact,
      sourceRef: str(item.sourceRef) ?? '',
      authority: str(item.authority),
      asOf: str(item.asOf),
      confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : null,
      state: FACT_STATES.includes(item.state as ContextFactState) ? (item.state as ContextFactState) : 'active',
      citation: str(item.citation),
      documentTitle: str(item.documentTitle) ?? str(doc?.title),
      templateKey: str(item.templateKey) ?? str(doc?.templateKey),
      createdAt: str(item.createdAt) ?? '',
      updatedAt: str(item.updatedAt) ?? str(item.createdAt) ?? '',
    });
  }
  return out;
}

/** A conflict's embedded fact — an object `{ fact, … }`, a bare string, or a `…Text` echo. */
function conflictFact(v: unknown, textFallback: string | null): ContextConflictFact | null {
  if (isRecord(v) && typeof v.fact === 'string') {
    const doc = isRecord(v.document) ? v.document : null;
    return {
      id: str(v.id) ?? '',
      fact: v.fact,
      documentTitle: str(v.documentTitle) ?? str(doc?.title),
      authority: str(v.authority),
      asOf: str(v.asOf),
      clientId: str(v.clientId) ?? str(doc?.clientId),
    };
  }
  const text = typeof v === 'string' && v !== '' ? v : textFallback;
  if (text) return { id: '', fact: text, documentTitle: null, authority: null, asOf: null, clientId: null };
  return null;
}

/** Accepts `[…]` or `{ conflicts: […] }` / `{ items: […] }`. */
export function normalizeConflicts(data: unknown): ContextConflict[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.conflicts)
      ? data.conflicts
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  const out: ContextConflict[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const factA = conflictFact(item.factA, str(item.factAText));
    const factB = conflictFact(item.factB, str(item.factBText));
    out.push({
      id: item.id,
      factAId: str(item.factAId) ?? (factA?.id || ''),
      factBId: str(item.factBId) ?? (factB?.id || ''),
      clientId: str(item.clientId) ?? factA?.clientId ?? factB?.clientId ?? null,
      material: item.material === true,
      state: CONFLICT_STATES.includes(item.state as ContextConflictState)
        ? (item.state as ContextConflictState)
        : 'open',
      resolutionNote: str(item.resolutionNote),
      factA,
      factB,
      createdAt: str(item.createdAt) ?? '',
    });
  }
  return out;
}

/** Tolerant open-material-conflict list (shared by health + groundingHealth). */
export function normalizeOpenMaterialConflicts(v: unknown): OpenMaterialConflict[] {
  if (!Array.isArray(v)) return [];
  const out: OpenMaterialConflict[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const factA = str(item.factA) ?? (isRecord(item.factA) ? str(item.factA.fact) : null);
    const factB = str(item.factB) ?? (isRecord(item.factB) ? str(item.factB.fact) : null);
    if (!factA || !factB) continue;
    out.push({
      id: str(item.id) ?? '',
      factAId: str(item.factAId) ?? '',
      factBId: str(item.factBId) ?? '',
      factA,
      factB,
    });
  }
  return out;
}

/** GET /context/health?clientId= → the health strip's view. Unknown status → 'ok'. */
export function normalizeContextHealth(data: unknown): ContextHealth {
  const d = isRecord(data) ? data : {};
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const staleRaw = d.staleDocuments ?? d.staleDocs ?? d.staleCount;
  return {
    status: d.status === 'degraded' || d.status === 'conflicted' ? d.status : 'ok',
    missingRequired: Array.isArray(d.missingRequired)
      ? d.missingRequired.filter((s): s is string => typeof s === 'string')
      : [],
    staleDocuments: num(staleRaw) ?? (Array.isArray(staleRaw) ? staleRaw.length : 0),
    openMaterialConflicts: normalizeOpenMaterialConflicts(d.openMaterialConflicts),
  };
}

/** POST /context/documents/:id/extract result — counts tolerate array echoes. */
export function normalizeExtractResult(data: unknown): ExtractFactsResult {
  const d = isRecord(data) ? data : {};
  const count = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : 0;
  return {
    inserted: count(d.inserted ?? d.facts),
    droppedRefs: count(d.droppedRefs),
    conflicts: count(d.conflicts),
    summary: str(d.summary),
  };
}

/** Hard truncation for banner text (the editor names factA vs factB at ≤120). */
export function clip(s: string, max = 120): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---- locate → highlight range ---------------------------------------------

/**
 * Resolves a locate result to a 1-based inclusive [start, end] line range in
 * the loaded document body. Prefers the API's line numbers (clamped); falls
 * back to finding the echoed lines verbatim in the content. Null when the
 * result cannot be anchored (the view then shows a "not found" note).
 */
export function resolveHighlight(
  contentLines: string[],
  loc: ContextLocateResult,
): { start: number; end: number } | null {
  const n = contentLines.length;
  if (loc.startLine !== null && loc.startLine >= 1 && loc.startLine <= n) {
    const end = Math.min(Math.max(loc.endLine ?? loc.startLine, loc.startLine), n);
    return { start: loc.startLine, end };
  }
  if (loc.lines && loc.lines.length > 0) {
    const needle = loc.lines.map((l) => l.trim());
    for (let i = 0; i <= n - needle.length; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (contentLines[i + j]!.trim() !== needle[j]) {
          match = false;
          break;
        }
      }
      if (match) return { start: i + 1, end: i + needle.length };
    }
  }
  return null;
}
