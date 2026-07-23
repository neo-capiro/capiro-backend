import { MERI_GROUNDING_INVARIANT } from '@capiro/meriv2-core';

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
}
export interface StrategyReferenceAssistInput {
  kind: 'congress' | 'ppbe';
  instruction: string;
  rows: unknown[];
  fiscal?: FiscalGrounding;
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
} as const;

export const PROPOSE_STRATEGY_DRAFT_TOOL = {
  name: 'propose_strategy_draft',
  description:
    'Return the drafted strategy: a 1-2 sentence plan summary and the ordered plan nodes. Call this when ready. Every node needs kind, subject, title, and a real startsOn date (YYYY-MM-DD) placed where the work actually happens across the PPBE / congressional / firm cycles.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'A 1-2 sentence summary of the plan.' },
      nodes: {
        type: 'array',
        description: 'The ordered plan nodes.',
        items: { type: 'object', properties: NODE_PROPS, required: ['kind', 'subject', 'title', 'startsOn'] },
      },
    },
    required: ['summary', 'nodes'],
  },
} as const;

export const PROPOSE_PLAN_EDITS_TOOL = {
  name: 'propose_plan_edits',
  description:
    'Return your reply and any edits to the existing plan. op is add|update|remove|retime. add needs kind/subject/title/startsOn; update/remove/retime need the target nodeId. For a question needing no change, pass an empty edits array.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Your conversational reply to the user.' },
      summary: { type: 'string', description: 'Updated 1-2 sentence plan summary (optional).' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'remove', 'retime'] },
            nodeId: { type: 'string', description: 'Target node id for update/remove/retime.' },
            ...NODE_PROPS,
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
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      rows: { type: 'array', items: { type: 'object' } },
    },
    required: ['rows'],
  },
} as const;

// ---- sanitizers (first pass; api-strategy re-validates authoritatively) ----

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function sanitizeDraftNodes(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => ({
      kind: str(n.kind),
      subject: str(n.subject),
      title: str(n.title),
      note: typeof n.note === 'string' ? n.note : undefined,
      status: str(n.status),
      startsOn: str(n.startsOn),
      endsOn: str(n.endsOn),
    }))
    .filter((n) => n.kind && n.subject && n.title && n.startsOn)
    .slice(0, 60);
}

export function sanitizePlanEdits(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const ops = new Set(['add', 'update', 'remove', 'retime']);
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => {
      const op = str(e.op);
      const out: Record<string, unknown> = { op };
      for (const k of ['nodeId', 'kind', 'subject', 'title', 'status', 'startsOn', 'endsOn'] as const) {
        const v = str(e[k]);
        if (v !== undefined) out[k] = v;
      }
      if (typeof e.note === 'string') out.note = e.note;
      if (typeof e.openEnded === 'boolean') out.openEnded = e.openEnded;
      return out;
    })
    .filter((e) => typeof e.op === 'string' && ops.has(e.op as string))
    .slice(0, 60);
}

export function sanitizeRefRows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').slice(0, 60);
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
    .map((p) => `- ${p.label}: FY${String(p.startFy).slice(2)} Q${p.startQ} → FY${String(p.endFy).slice(2)} Q${p.endQ}`)
    .join('\n');
}

function renderReference(ref?: ReferenceGrounding): string {
  if (!ref) return '(reference calendars not provided)';
  const lines: string[] = [];
  if (ref.congress?.length) {
    lines.push('Legislative milestones:');
    for (const r of ref.congress.slice(0, 24)) {
      lines.push(`- ${r.label}${r.startsOn ? ` (${r.startsOn}${r.endsOn ? `–${r.endsOn}` : ''})` : ''}`);
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
        `- [${n.id}] ${n.kind}/${n.subject} · "${n.title}"${n.startsOn ? ` · ${n.startsOn}${n.endsOn ? `→${n.endsOn}` : ''}` : ''} · ${n.status}`,
    )
    .join('\n');
}

const PERSONA =
  'You are Meri, a government-affairs strategist. You turn a client goal into a concrete, date-placed plan of steps (actions, decisions, gates, milestones, risks) aligned to the federal budget (PPBE), the congressional calendar, and the firm’s own operating rhythm.';

export function buildDraftSystemPrompt(input: StrategyDraftInput, packText: string): string {
  return [
    PERSONA,
    MERI_GROUNDING_INVARIANT,
    `# Objective type\n${input.type}`,
    input.goal ? `# Goal\n${input.goal}` : '# Goal\n(none stated — infer a reasonable objective from the client context)',
    input.meriContext ? `# Extra context from the user\n${input.meriContext}` : '',
    input.targetDate ? `# Target outcome date\n${input.targetDate}` : '',
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Firm phases\n${renderFirmPhases(input.firmPhases)}`,
    `# Reference calendars\n${renderReference(input.reference)}`,
    `# Client context\n${packText}`,
    input.attachments?.length
      ? `# Attached documents (user-provided grounding)\n${renderAttachments(input.attachments)}`
      : '',
    '# How to answer\nCall propose_strategy_draft with a 1-2 sentence summary and the ordered nodes. Ground every node in the context above (including any attached documents); do not invent client facts. Place dates where the work actually happens.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildAssistantSystemPrompt(input: StrategyAssistantInput, packText: string): string {
  const focus =
    input.scope === 'node' && input.nodeId
      ? `# Focus\nThe user is editing node [${input.nodeId}]. Prefer edits to that node unless they clearly ask for more.`
      : '# Focus\nThe user may change any part of the plan.';
  return [
    PERSONA,
    MERI_GROUNDING_INVARIANT,
    `# Current strategy\n${input.strategy.title} (${input.strategy.type})${input.strategy.goal ? `\nGoal: ${input.strategy.goal}` : ''}`,
    `# Current plan\n${renderPlan(input.strategy)}`,
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Firm phases\n${renderFirmPhases(input.firmPhases)}`,
    `# Reference calendars\n${renderReference(input.reference)}`,
    `# Client context\n${packText}`,
    input.attachments?.length
      ? `# Attached documents (user-provided grounding)\n${renderAttachments(input.attachments)}`
      : '',
    focus,
    '# How to answer\nCall propose_plan_edits with a short reply and the edits (add/update/remove/retime). Use the exact node ids above for update/remove/retime. Ground changes in the context (including any attached documents); do not invent client facts. Empty edits if no change is needed.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildReferenceSystemPrompt(input: StrategyReferenceAssistInput): string {
  const which = input.kind === 'congress' ? 'legislative (congressional) calendar' : 'PPBE reference';
  return [
    PERSONA,
    MERI_GROUNDING_INVARIANT,
    `# Task\nEdit the firm's ${which} per the user's instruction. This is reference data shared across strategies — be conservative and precise.`,
    `# Fiscal calendar\n${renderFiscal(input.fiscal)}`,
    `# Current rows (JSON)\n${JSON.stringify(input.rows).slice(0, 8000)}`,
    '# How to answer\nCall propose_reference_edits with the FULL edited row set (preserve rows you are not changing) and a short reply.',
  ].join('\n\n');
}
