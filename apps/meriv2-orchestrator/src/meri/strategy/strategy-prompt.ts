import {
  MERI_GROUNDING_INVARIANT,
  buildAssurancePromptBlock,
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
  truncateToTokens,
} from '@capiro/meriv2-core';
import type { SystemPromptParts } from '../prompt-cache.helpers.js';

/*
 * Strategy Planner Meri — pure prompt/tool/sanitize logic (no network, no DI),
 * mirroring in-editor-prompt.ts. Terminal JSON-Schema tools mean the LLM returns
 * typed nodes/edits; api-strategy re-validates before persisting (this sanitize
 * is a first pass). Grounding: the live fiscal window + firm phases + reference
 * calendars + the Client Context Pack (§6.13) are rendered into the system
 * prompt (CRT-12); NO read tools run in the loop.
 */

const KINDS = ['action', 'decision', 'gate', 'milestone', 'risk'] as const;
const SUBJECTS = [
  'deliverable',
  'submission',
  'member',
  'committee',
  'ask',
  'agency',
  'outcome',
  'optics',
] as const;
const STATUSES = ['draft', 'in_progress', 'internal_review', 'active', 'suggested'] as const;

// ---- request shapes (what api-strategy forwards) ----

export interface FiscalGrounding {
  today?: string;
  fys?: number[];
  fyLabels?: string[];
  focalFy?: string;
}
export interface FirmPhaseRow {
  label: string;
  startFy: number;
  startQ: number;
  endFy: number;
  endQ: number;
}
export interface ReferenceRowLite {
  label: string;
  fy?: number | null;
  startsOn?: string | null;
  endsOn?: string | null;
}
export interface ReferenceGrounding {
  congress?: ReferenceRowLite[];
  ppbeLanes?: ReferenceRowLite[];
  ppbeCurrentPhases?: ReferenceRowLite[];
}

/** Extracted text of a user-uploaded grounding document (CRT-5/MRI-7). Resolved
 *  by api-strategy from ClioAttachment and forwarded here (never fetched in the
 *  loop). */
export interface StrategyAttachment {
  filename: string;
  text: string;
}

/** Stage E wire contract (2): one Steward-curated fact api-strategy forwards. */
export interface StewardFactLite {
  id: string;
  fact: string;
  sourceRef: string;
  documentTitle: string;
  templateKey: string;
  authority: string | null;
  asOf: string | null;
}

/** Stage E wire contract (2): Steward context health api-strategy forwards. */
export interface StewardHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  missingRequired: string[];
  openMaterialConflicts: Array<{
    id: string;
    factAId: string;
    factBId: string;
    factA: string;
    factB: string;
  }>;
}

export interface StrategyDraftInput {
  clientId: string;
  type: string;
  goal?: string | null;
  meriContext?: string | null;
  targetDate?: string | null;
  attachmentIds?: string[];
  attachments?: StrategyAttachment[];
  fiscal?: FiscalGrounding;
  firmPhases?: FirmPhaseRow[];
  reference?: ReferenceGrounding;
  stewardFacts?: StewardFactLite[];
  stewardHealth?: StewardHealth;
}

export interface StrategyStateNode {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note?: string | null;
  ownerUserId?: string | null;
  status: string;
  startsOn?: string | null;
  endsOn?: string | null;
  openEnded?: boolean;
  dependsOnIds?: string[];
  meriAuthored?: boolean;
}
export interface StrategyState {
  id: string;
  title: string;
  type: string;
  goal?: string | null;
  meriContext?: string | null;
  targetDate?: string | null;
  nodes: StrategyStateNode[];
}
export interface StrategyAssistantInput {
  scope: 'node' | 'strategy';
  nodeId?: string | null;
  instruction: string;
  attachmentIds?: string[];
  attachments?: StrategyAttachment[];
  clientId: string;
  strategy: StrategyState;
  fiscal?: FiscalGrounding;
  firmPhases?: FirmPhaseRow[];
  reference?: ReferenceGrounding;
  stewardFacts?: StewardFactLite[];
  stewardHealth?: StewardHealth;
}
export interface StrategyReferenceAssistInput {
  kind: 'congress' | 'ppbe';
  instruction: string;
  rows: unknown[];
  fiscal?: FiscalGrounding;
}

/** The plan node the Execution Agent is staging a deliverable/message for. */
export interface DocumentDraftNode {
  id: string;
  kind: string;
  subject: string;
  title: string;
  note?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

/**
 * Stage-G grounded content generation: draft the FULL body of one Execution
 * Agent artifact for a single plan node — a multi-section Workspace document
 * ('workspace_draft') or a complete Outreach campaign message
 * ('outreach_record') — grounded in the same fiscal/reference Grounding pack +
 * client Context Pack + Steward facts the draft()/assistant() paths already
 * assemble. `goal` is the strategy's own goal (the main steering signal,
 * mirrored from StrategyDraftInput.goal — api-strategy MUST forward it).
 */
export interface StrategyDocumentDraftInput {
  /** ALWAYS a real client id — api-strategy skips generation entirely (falls
   *  back to the deterministic placeholder) for a client-less workspace node
   *  rather than ever forwarding null/empty here (the pack + prompt are
   *  client-anchored). */
  clientId: string;
  kind: 'workspace_draft' | 'outreach_record';
  type: string;
  goal?: string | null;
  node: DocumentDraftNode;
  fiscal?: FiscalGrounding;
  firmPhases?: FirmPhaseRow[];
  reference?: ReferenceGrounding;
  stewardFacts?: StewardFactLite[];
  stewardHealth?: StewardHealth;
  attachments?: StrategyAttachment[];
}

// ---- terminal tools ----

const NODE_PROPS = {
  kind: { type: 'string', enum: [...KINDS] },
  subject: { type: 'string', enum: [...SUBJECTS] },
  title: { type: 'string' },
  note: { type: 'string' },
  status: { type: 'string', enum: [...STATUSES] },
  startsOn: { type: 'string', description: 'YYYY-MM-DD, within the shown FY window' },
  endsOn: { type: 'string', description: 'YYYY-MM-DD, optional (omit for a point event)' },
  sources: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: {
          type: 'string',
          description: 'A Client context section heading this node is grounded in.',
        },
        ref: { type: 'string', description: 'Optional finer reference (row/heading).' },
      },
      required: ['section'],
    },
    description:
      'The context section(s) that ground this node (A9). Cite what you used; do not invent client facts.',
  },
} as const;

export const PROPOSE_STRATEGY_DRAFT_TOOL = {
  name: 'propose_strategy_draft',
  description:
    'Return the drafted strategy: a 1-2 sentence plan summary and the ordered plan nodes. Call this when ready. Every node needs kind, subject, title, and a real startsOn date (YYYY-MM-DD) placed where the work actually happens across the PPBE / congressional / firm cycles. A step that cannot begin until an earlier step finishes should list that step in dependsOn.',
  // A7: constrained decoding on models that support it (stripped otherwise by
  // request-scoped-llm.client's modelSupportsStrict gate) — cuts malformed/
  // truncated tool_use JSON at the source, ahead of sanitizeDraftNodes.
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', description: 'A 1-2 sentence summary of the plan.' },
      nodes: {
        type: 'array',
        description: 'The ordered plan nodes.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...NODE_PROPS,
            dependsOn: {
              type: 'array',
              items: { type: 'integer' },
              description:
                '0-based indexes of OTHER nodes in this list that must complete before this step (blockers). A gate/decision a step waits on belongs here. Omit or [] if none.',
            },
          },
          required: ['kind', 'subject', 'title', 'startsOn', 'sources'],
        },
      },
    },
    required: ['summary', 'nodes'],
  },
} as const;

export const PROPOSE_PLAN_EDITS_TOOL = {
  name: 'propose_plan_edits',
  description:
    'Return your reply and any edits to the existing plan. op is add|update|remove|retime. add needs kind/subject/title/startsOn; update/remove/retime need the target nodeId. dependsOn lists the node ids this step is blocked by (existing nodes only). For a question needing no change, pass an empty edits array.',
  // A7: constrained decoding on models that support it (see PROPOSE_STRATEGY_DRAFT_TOOL).
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', description: 'Your conversational reply to the user.' },
      summary: { type: 'string', description: 'Updated 1-2 sentence plan summary (optional).' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'remove', 'retime'] },
            nodeId: { type: 'string', description: 'Target node id for update/remove/retime.' },
            ...NODE_PROPS,
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description:
                "Node ids this step depends on (must be EXISTING nodes). Replaces the step's current edges.",
            },
          },
          required: ['op'],
        },
      },
    },
    required: ['reply', 'edits'],
  },
} as const;

export const PROPOSE_REFERENCE_EDITS_TOOL = {
  name: 'propose_reference_edits',
  description:
    'Return the edited reference rows as the FULL working set (preserve rows you are not changing). For the legislative (congress) calendar each row is {label, from, to} where from/to are quarter INDICES (0 = first shown FY Q1). For the PPBE reference each row is {fy, phase}. Include a short reply.',
  // A7: constrained decoding on models that support it (see PROPOSE_STRATEGY_DRAFT_TOOL).
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      rows: { type: 'array', items: { type: 'object' } },
    },
    required: ['rows'],
  },
} as const;

/**
 * Stage-G document/message body draft. ONE shape covers both artifact kinds —
 * the system prompt (buildDocumentDraftSystemPrompt) instructs the model to
 * write a full multi-section DOCUMENT for 'workspace_draft' or a single
 * cohesive MESSAGE (sections are its paragraphs/subheads) for
 * 'outreach_record'; api-strategy maps `sections` onto
 * config.sectionContent (workspace) or flattens them into OutreachRecord.body
 * (outreach). `html` is a first-pass allowlist (h2/h3/p/ul/ol/li/strong/em/a);
 * api-strategy re-sanitizes authoritatively before persisting (sanitizeSectionHtml).
 */
export const PROPOSE_DOCUMENT_DRAFT_TOOL = {
  name: 'propose_document_draft',
  description:
    "Return the drafted deliverable: a 1-2 sentence internal summary and the ordered body sections. For a workspace_draft, write a complete multi-section document. For an outreach_record, write one cohesive campaign message — split it into sections (e.g. opening, key points, ask, close) rather than one giant block. Ground every section in the context provided; do not invent client facts. Cite what grounded each section in that section's sources.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description: 'A 1-2 sentence internal summary of the drafted deliverable.',
      },
      title: { type: 'string', description: 'Optional refined title/subject for the deliverable.' },
      sections: {
        type: 'array',
        description:
          'Ordered body sections. For a workspace document each becomes a config.sectionContent entry; for an outreach message they are concatenated into the campaign body.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string' },
            html: {
              type: 'string',
              description:
                'HTML fragment restricted to <h2>/<h3>/<p>/<ul>/<ol>/<li>/<strong>/<em>/<a>. No scripts, styles, or event handlers.',
            },
            sources: NODE_PROPS.sources,
          },
          required: ['heading', 'html', 'sources'],
        },
      },
    },
    required: ['summary', 'sections'],
  },
} as const;

// ---- sanitizers (first pass; api-strategy re-validates authoritatively) ----

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** A9: normalize per-node provenance to [{section, ref?}] (drops blanks). */
function sanitizeSources(raw: unknown): Array<{ section: string; ref?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({ section: str(s.section), ref: str(s.ref) }))
    .filter((s) => !!s.section)
    .map((s) =>
      s.ref ? { section: s.section as string, ref: s.ref } : { section: s.section as string },
    );
  return out.length ? out : undefined;
}

export function sanitizeDraftNodes(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  // A3: dependsOn values coming off the wire are 0-based indexes into `raw` AS THE
  // MODEL RETURNED IT. The filter/sort/slice below all change array positions, so we
  // carry each node's originalIndex through the pipeline and remap dependsOn against
  // the FINAL array once it settles (below), instead of passing the raw indexes through.
  const withOriginalIndex = raw
    .map((n, originalIndex) => ({ n, originalIndex }))
    .filter(
      (e): e is { n: Record<string, unknown>; originalIndex: number } =>
        !!e.n && typeof e.n === 'object',
    )
    .map(({ n, originalIndex }) => ({
      kind: str(n.kind),
      subject: str(n.subject),
      title: str(n.title),
      note: typeof n.note === 'string' ? n.note : undefined,
      status: str(n.status),
      startsOn: str(n.startsOn),
      endsOn: str(n.endsOn),
      dependsOn: Array.isArray(n.dependsOn)
        ? n.dependsOn.filter((x): x is number => Number.isInteger(x))
        : undefined,
      sources: sanitizeSources(n.sources), // A9
      originalIndex,
    }))
    .filter((n) => n.kind && n.subject && n.title && n.startsOn)
    // A9: coherent truncation — keep the EARLIEST 60 (sorted by start date),
    // never an arbitrary tail-drop mid-sequence.
    .sort((a, b) => String(a.startsOn).localeCompare(String(b.startsOn)))
    .slice(0, 60);

  // originalIndex -> final position in the array returned below.
  const finalIndexByOriginal = new Map<number, number>();
  withOriginalIndex.forEach(({ originalIndex }, finalIndex) =>
    finalIndexByOriginal.set(originalIndex, finalIndex),
  );

  return withOriginalIndex.map(({ originalIndex, dependsOn, ...node }, finalIndex) => ({
    ...node,
    // Remap original-index -> final-index; drop edges to nodes that didn't survive
    // filtering/truncation and any self-reference (dangling/incorrect edges must not
    // silently point at the wrong node).
    dependsOn: dependsOn
      ?.map((idx) => finalIndexByOriginal.get(idx))
      .filter((idx): idx is number => idx !== undefined && idx !== finalIndex),
  }));
}

export function sanitizePlanEdits(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const ops = new Set(['add', 'update', 'remove', 'retime']);
  return (
    raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => {
        const op = str(e.op);
        const out: Record<string, unknown> = { op };
        for (const k of [
          'nodeId',
          'kind',
          'subject',
          'title',
          'status',
          'startsOn',
          'endsOn',
        ] as const) {
          const v = str(e[k]);
          if (v !== undefined) out[k] = v;
        }
        if (typeof e.note === 'string') out.note = e.note;
        if (typeof e.openEnded === 'boolean') out.openEnded = e.openEnded;
        // A3: node-id edges (existing nodes only; api-strategy validates existence).
        if (Array.isArray(e.dependsOn)) {
          out.dependsOn = e.dependsOn.filter((x): x is string => typeof x === 'string');
        }
        // A9: preserve an explicit empty array (clears provenance) same as dependsOn above;
        // only omit the key when the model didn't send a sources array at all.
        if (Array.isArray(e.sources)) out.sources = sanitizeSources(e.sources) ?? [];
        return out;
      })
      .filter((e) => typeof e.op === 'string' && ops.has(e.op as string))
      // A9: coherent truncation, mirroring sanitizeDraftNodes — never an arbitrary
      // tail-drop. Edits without a startsOn (e.g. `remove`, dateless `update`) sort
      // first (so a stale-node removal isn't silently dropped), then dated ops
      // (add/retime/update) sort ascending so the most imminent survive the cut.
      .sort((a, b) => String(a.startsOn ?? '').localeCompare(String(b.startsOn ?? '')))
      .slice(0, 60)
  );
}

export function sanitizeRefRows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').slice(0, 60);
}

/** Stage-G doc-draft section shape (post-sanitize). */
export interface DocumentDraftSection {
  heading: string;
  html: string;
  sources?: Array<{ section: string; ref?: string }>;
}

const DOC_SECTION_MAX_COUNT = 12;
const DOC_SECTION_HTML_MAX_CHARS = 8_000;
/** First-pass best-effort allowlist — api-strategy's sanitizeSectionHtml is
 *  authoritative; this only trims the obviously-disallowed before it ever
 *  leaves the orchestrator. */
const DOC_ALLOWED_TAG_RE = /<\/?(?!h2\b|h3\b|p\b|ul\b|ol\b|li\b|strong\b|em\b|a\b)[a-zA-Z][^>]*>/g;
const DOC_SCRIPT_STYLE_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const DOC_EVENT_ATTR_RE = /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function firstPassAllowlist(html: string): string {
  return html
    .replace(DOC_SCRIPT_STYLE_RE, '')
    .replace(DOC_ALLOWED_TAG_RE, '')
    .replace(DOC_EVENT_ATTR_RE, '');
}

/**
 * Stage-G first-pass sanitizer for propose_document_draft's `sections`: coerce
 * to array, drop entries with no heading/html, cap section count and
 * per-section HTML length (a truncated section is still usable — never an
 * arbitrary tail-drop across sections since order is preserved), and
 * best-effort strip disallowed tags/scripts/event handlers. api-strategy's
 * sanitizeSectionHtml is the AUTHORITATIVE allowlist before persistence.
 */
interface DraftDocumentSectionCandidate {
  heading?: string;
  html?: string;
  sources?: Array<{ section: string; ref?: string }>;
}

export function sanitizeDocumentSections(raw: unknown): DocumentDraftSection[] {
  if (!Array.isArray(raw)) return [];
  const candidates: DraftDocumentSectionCandidate[] = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      heading: str(s.heading),
      html:
        typeof s.html === 'string'
          ? firstPassAllowlist(s.html).slice(0, DOC_SECTION_HTML_MAX_CHARS)
          : undefined,
      sources: sanitizeSources(s.sources),
    }));
  const out: DocumentDraftSection[] = [];
  for (const c of candidates) {
    if (c.heading && c.html && c.html.trim().length > 0) {
      out.push({ heading: c.heading, html: c.html, sources: c.sources });
    }
  }
  return out.slice(0, DOC_SECTION_MAX_COUNT);
}

// ---- grounding + prompt builders ----

function renderFiscal(f?: FiscalGrounding): string {
  if (!f) return '(fiscal window not provided)';
  const window = f.fyLabels?.length ? f.fyLabels.join(', ') : '(unknown)';
  return `Today: ${f.today ?? '(unknown)'}. Shown FY window: ${window}. Focal FY: ${f.focalFy ?? '(unknown)'}. Place node dates as real YYYY-MM-DD within this window.`;
}

function renderFirmPhases(rows?: FirmPhaseRow[]): string {
  if (!rows?.length) return 'Firm phases are not configured — assume a standard annual rhythm.';
  return rows
    .map(
      (p) =>
        `- ${p.label}: FY${String(p.startFy).slice(2)} Q${p.startQ} → FY${String(p.endFy).slice(2)} Q${p.endQ}`,
    )
    .join('\n');
}

function renderReference(ref?: ReferenceGrounding): string {
  if (!ref) return '(reference calendars not provided)';
  const lines: string[] = [];
  if (ref.congress?.length) {
    lines.push('Legislative milestones:');
    for (const r of ref.congress.slice(0, 24)) {
      lines.push(
        `- ${r.label}${r.startsOn ? ` (${r.startsOn}${r.endsOn ? `–${r.endsOn}` : ''})` : ''}`,
      );
    }
  }
  if (ref.ppbeCurrentPhases?.length) {
    lines.push('PPBE current phases:');
    for (const r of ref.ppbeCurrentPhases.slice(0, 12)) {
      lines.push(`- FY${String(r.fy ?? '').slice(2)}: ${r.label}`);
    }
  }
  return lines.length ? lines.join('\n') : '(no reference rows)';
}

function renderAttachments(rows?: StrategyAttachment[]): string {
  if (!rows?.length) return '';
  return rows
    .slice(0, 10)
    .map((d) => `### ${d.filename}\n${(d.text ?? '').slice(0, 12_000)}`)
    .join('\n\n');
}

function renderPlan(s: StrategyState): string {
  if (!s.nodes.length) return '(the plan currently has no steps)';
  return s.nodes
    .map(
      (n) =>
        `- [${n.id}] ${n.kind}/${n.subject} · "${n.title}"${n.startsOn ? ` · ${n.startsOn}${n.endsOn ? `→${n.endsOn}` : ''}` : ''} · ${n.status}${
          n.dependsOnIds?.length
            ? ` · depends on ${n.dependsOnIds.map((d) => `[${d}]`).join(', ')}`
            : ''
        }`,
    )
    .join('\n');
}

// ---- Stage E: Steward facts section (wire contract 2) ----

/** The section name node `sources` cite steward facts under (paired with ref 'fact:<id>'). */
export const STEWARD_FACTS_SECTION = 'Client context facts (Steward)';

/**
 * The Steward's core-grounding templates: facts from these sort FIRST in the
 * budgeted section (mirrors api-strategy's required-template set for
 * stewardHealth.missingRequired — the goal/limits/asks a plan cannot safely
 * omit).
 */
export const STEWARD_REQUIRED_TEMPLATE_KEYS = [
  '01_strategy_brief',
  '02_client_constraints',
  '03_ask_and_options',
] as const;

/** Section token budget, mirroring the pack's per-section CAP idiom (CTX-3). */
const STEWARD_FACTS_TOKEN_CAP = 2000;

/**
 * One line per fact: '- [fact:<id>] <fact> (<authority>, as of <asOf>)'.
 * Sorted required-templates-first, then newest asOf (undated last), so the
 * token-budget truncation drops the least-load-bearing tail — never a brief/
 * constraint/ask fact ahead of a stale optional one.
 */
export function renderStewardFacts(facts: StewardFactLite[]): string {
  const required = new Set<string>(STEWARD_REQUIRED_TEMPLATE_KEYS);
  const lines = [...facts]
    .sort((a, b) => {
      const tierA = required.has(a.templateKey) ? 0 : 1;
      const tierB = required.has(b.templateKey) ? 0 : 1;
      if (tierA !== tierB) return tierA - tierB;
      return String(b.asOf ?? '').localeCompare(String(a.asOf ?? ''));
    })
    .map(
      (f) =>
        `- [fact:${f.id}] ${f.fact} (${f.authority ?? 'unattributed'}, as of ${f.asOf ?? 'undated'})`,
    );
  return truncateToTokens(lines.join('\n'), STEWARD_FACTS_TOKEN_CAP);
}

/** The full prompt section (empty string when no facts were forwarded). */
function stewardFactsSection(facts?: StewardFactLite[]): string {
  if (!facts?.length) return '';
  return [
    `# ${STEWARD_FACTS_SECTION}`,
    'Curated, source-anchored facts the Context Steward maintains for this client — the most reliable client grounding below.',
    renderStewardFacts(facts),
    `When one of these facts grounds a node, cite it in that node's \`sources\` as {section: "${STEWARD_FACTS_SECTION}", ref: "fact:<id>"} using the fact id shown above.`,
  ].join('\n');
}

const PERSONA =
  'You are Meri, a cross-jurisdiction government-affairs strategist. You turn an explicitly supplied or approved client objective into a concrete, date-placed plan of actions, decisions, gates, milestones, and risks across the relevant federal, state, local, regulatory, procurement, grants, budget, legislative, and firm operating cycles. Never invent a client objective or silently default to the federal rail.';

/**
 * Prompt caching (P0-1 orchestrator parity): the ONE thing genuinely
 * invariant across every strategy call, of any kind, for any client — the
 * persona + the zero-trust grounding kernel. Everything else in these four
 * builders (fiscal/firm/reference calendars, the Client Context Pack,
 * Steward facts, grounding health, attachments, the current plan/strategy)
 * is per-request data and stays in each builder's `dynamic` tail. Shared
 * across all four so a cache write from ANY strategy operation is read by
 * the next one, not just repeats of the same operation.
 */
const STRATEGY_BASE = [PERSONA, MERI_GROUNDING_INVARIANT].join('\n\n');

function strategyAssuranceBlock(input: {
  request: string;
  clientId?: string;
  objective?: string | null;
  fiscal?: FiscalGrounding;
  surface: 'strategy' | 'workspace-gen' | 'outreach';
}): string {
  const frame = resolveGovernmentAffairsOperatingFrame({
    request: input.request,
    asOf: input.fiscal?.today,
    explicit: {
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.objective ? { clientObjective: input.objective } : {}),
    },
    structuredFiscalYears: input.fiscal?.fys,
  });
  const plan = planGovernmentAffairsEvidence({
    request: input.request,
    frame,
    surface: input.surface,
  });
  return buildAssurancePromptBlock(frame, plan);
}

export function composeDraftSystemPrompt(
  input: StrategyDraftInput,
  packText: string,
  healthNote?: string,
): SystemPromptParts {
  const dynamic = [
    strategyAssuranceBlock({
      request: [input.type, input.goal, input.meriContext].filter(Boolean).join('\n'),
      clientId: input.clientId,
      objective: input.goal,
      fiscal: input.fiscal,
      surface: 'strategy',
    }),
    `# Objective type\n${input.type}`,
    input.goal
      ? `# Goal\n${input.goal}`
      : '# Goal\n(none stated — do not invent one; propose a discovery step or generic options and identify the required client decision)',
    input.meriContext ? `# Extra context from the user\n${input.meriContext}` : '',
    input.targetDate ? `# Target outcome date\n${input.targetDate}` : '',
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Firm phases\n${renderFirmPhases(input.firmPhases)}`,
    `# Reference calendars\n${renderReference(input.reference)}`,
    `# Client context\n${packText}`,
    stewardFactsSection(input.stewardFacts),
    healthNote ? `# Grounding health\n${healthNote}` : '',
    input.attachments?.length
      ? `# Attached documents (user-provided grounding)\n${renderAttachments(input.attachments)}`
      : '',
    '# How to answer\nCall propose_strategy_draft with a 1-2 sentence summary and the ordered nodes. Ground every node in the context above (including any attached documents); do not invent client facts. Place dates where the work actually happens. For each node, cite the grounding section(s) in `sources`.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { base: STRATEGY_BASE, dynamic };
}

/** Legacy joined-string form — kept for strategy-prompt.spec.ts and any
 *  caller that doesn't need the cache split. Byte-identical to before:
 *  `STRATEGY_BASE` is exactly `[PERSONA, MERI_GROUNDING_INVARIANT].join('\n\n')`,
 *  so `${base}\n\n${dynamic}` reproduces the original single joined array. */
export function buildDraftSystemPrompt(
  input: StrategyDraftInput,
  packText: string,
  healthNote?: string,
): string {
  const { base, dynamic } = composeDraftSystemPrompt(input, packText, healthNote);
  return `${base}\n\n${dynamic}`;
}

export function composeAssistantSystemPrompt(
  input: StrategyAssistantInput,
  packText: string,
  healthNote?: string,
): SystemPromptParts {
  const focus =
    input.scope === 'node' && input.nodeId
      ? `# Focus\nThe user is editing node [${input.nodeId}]. Prefer edits to that node unless they clearly ask for more.`
      : '# Focus\nThe user may change any part of the plan.';
  const dynamic = [
    strategyAssuranceBlock({
      request: [input.instruction, input.strategy.type, input.strategy.goal]
        .filter(Boolean)
        .join('\n'),
      clientId: input.clientId,
      objective: input.strategy.goal,
      fiscal: input.fiscal,
      surface: 'strategy',
    }),
    `# Current strategy\n${input.strategy.title} (${input.strategy.type})${input.strategy.goal ? `\nGoal: ${input.strategy.goal}` : ''}`,
    `# Current plan\n${renderPlan(input.strategy)}`,
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Firm phases\n${renderFirmPhases(input.firmPhases)}`,
    `# Reference calendars\n${renderReference(input.reference)}`,
    `# Client context\n${packText}`,
    stewardFactsSection(input.stewardFacts),
    healthNote ? `# Grounding health\n${healthNote}` : '',
    input.attachments?.length
      ? `# Attached documents (user-provided grounding)\n${renderAttachments(input.attachments)}`
      : '',
    focus,
    '# How to answer\nCall propose_plan_edits with a short reply and the edits (add/update/remove/retime). Use the exact node ids above for update/remove/retime. Ground changes in the context (including any attached documents); do not invent client facts. Empty edits if no change is needed.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { base: STRATEGY_BASE, dynamic };
}

/** Legacy joined-string form — see buildDraftSystemPrompt's comment. */
export function buildAssistantSystemPrompt(
  input: StrategyAssistantInput,
  packText: string,
  healthNote?: string,
): string {
  const { base, dynamic } = composeAssistantSystemPrompt(input, packText, healthNote);
  return `${base}\n\n${dynamic}`;
}

export function composeReferenceSystemPrompt(
  input: StrategyReferenceAssistInput,
): SystemPromptParts {
  const which =
    input.kind === 'congress' ? 'legislative (congressional) calendar' : 'PPBE reference';
  const dynamic = [
    strategyAssuranceBlock({
      request: `${which}: ${input.instruction}`,
      fiscal: input.fiscal,
      surface: 'strategy',
    }),
    `# Task\nEdit the firm's ${which} per the user's instruction. This is reference data shared across strategies — be conservative and precise.`,
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Current rows (JSON)\n${JSON.stringify(input.rows).slice(0, 8000)}`,
    '# How to answer\nCall propose_reference_edits with the FULL edited row set (preserve rows you are not changing) and a short reply.',
  ].join('\n\n');
  return { base: STRATEGY_BASE, dynamic };
}

/** Legacy joined-string form — see buildDraftSystemPrompt's comment. */
export function buildReferenceSystemPrompt(input: StrategyReferenceAssistInput): string {
  const { base, dynamic } = composeReferenceSystemPrompt(input);
  return `${base}\n\n${dynamic}`;
}

function renderDocumentNode(n: DocumentDraftNode): string {
  const dates = n.startsOn ? `${n.startsOn}${n.endsOn ? `–${n.endsOn}` : ''}` : '(no date set)';
  return [
    `- [${n.id}] ${n.kind}/${n.subject} · "${n.title}" · ${dates}`,
    n.note ? `  Note: ${n.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Stage-G grounded generation for the Execution Agent (Task a1/a2). Branches
 * on `input.kind`: a workspace_draft gets "write a document" framing, an
 * outreach_record gets "write one cohesive campaign message" framing — the
 * terminal tool shape (propose_document_draft) is identical either way.
 */
export function composeDocumentDraftSystemPrompt(
  input: StrategyDocumentDraftInput,
  packText: string,
  healthNote?: string,
): SystemPromptParts {
  const isWorkspace = input.kind === 'workspace_draft';
  const deliverableNote = isWorkspace
    ? 'You are drafting a full internal WORKSPACE DOCUMENT (a white paper / strategy memo) for this step. Write complete, substantive sections — this is a real first draft, not an outline.'
    : 'You are drafting a full OUTREACH CAMPAIGN MESSAGE for this step — the message that will eventually go to the counterparty named by this step. Write it as a cohesive message (opening, key points, the ask, a close), split into sections. This message is STAGED ONLY — it will never be sent by you or as a result of this call.';
  const dynamic = [
    strategyAssuranceBlock({
      request: [input.kind, input.type, input.goal, input.node.title, input.node.note]
        .filter(Boolean)
        .join('\n'),
      clientId: input.clientId,
      objective: input.goal,
      fiscal: input.fiscal,
      surface: input.kind === 'outreach_record' ? 'outreach' : 'workspace-gen',
    }),
    `# Deliverable\n${deliverableNote}`,
    `# Objective type\n${input.type}`,
    input.goal
      ? `# Strategy goal\n${input.goal}`
      : '# Strategy goal\n(none stated — do not manufacture an objective or ask; hold client-specific recommendations until direction is supplied)',
    `# The step this deliverable is for\n${renderDocumentNode(input.node)}`,
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Firm phases\n${renderFirmPhases(input.firmPhases)}`,
    `# Reference calendars\n${renderReference(input.reference)}`,
    `# Client context\n${packText}`,
    stewardFactsSection(input.stewardFacts),
    healthNote ? `# Grounding health\n${healthNote}` : '',
    input.attachments?.length
      ? `# Attached documents (user-provided grounding)\n${renderAttachments(input.attachments)}`
      : '',
    "# How to answer\nCall propose_document_draft with a 1-2 sentence internal summary and the ordered body sections. Ground every section in the context above; do not invent client facts. Cite what grounded each section in that section's `sources`.",
  ]
    .filter(Boolean)
    .join('\n\n');
  return { base: STRATEGY_BASE, dynamic };
}

/** Legacy joined-string form — see buildDraftSystemPrompt's comment. */
export function buildDocumentDraftSystemPrompt(
  input: StrategyDocumentDraftInput,
  packText: string,
  healthNote?: string,
): string {
  const { base, dynamic } = composeDocumentDraftSystemPrompt(input, packText, healthNote);
  return `${base}\n\n${dynamic}`;
}
