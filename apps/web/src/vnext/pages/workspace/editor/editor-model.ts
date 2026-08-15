import type { WsConfig, WsDocument } from '../../../../pages/workspace/types.js';
import type {
  AgentPhase,
  AgentState,
  GenerationStage,
  GenerationStatusResponse,
} from '../types/agent.js';

export type InspectorTab = 'brief' | 'context' | 'outline' | 'design' | 'quality';
export type SpineStop = 'brief' | 'context' | 'outline' | 'draft' | 'quality' | 'delivery';

export const SPINE_STOPS: ReadonlyArray<{ id: SpineStop; label: string }> = [
  { id: 'brief', label: 'Brief' },
  { id: 'context', label: 'Context' },
  { id: 'outline', label: 'Outline' },
  { id: 'draft', label: 'Draft' },
  { id: 'quality', label: 'Quality' },
  { id: 'delivery', label: 'Delivery' },
];

export const SERVER_STAGE_NAMES = [
  'preflight',
  'evidence_plan',
  'narrative_plan',
  'drafting',
  'editorial_pass',
  'assurance',
  'snapshot',
  'complete',
] as const;

export function phaseToTab(phase: AgentPhase): InspectorTab {
  switch (phase) {
    case 'brief':
      return 'brief';
    case 'context':
      return 'context';
    case 'outline':
    case 'generate':
      return 'outline';
    case 'draft':
    case 'quality':
    case 'complete':
      return 'quality';
    default:
      return 'brief';
  }
}

export function phaseToSpineIndex(phase: AgentPhase): number {
  switch (phase) {
    case 'type':
    case 'blueprint':
    case 'design':
    case 'goal':
    case 'brief':
      return 0;
    case 'context':
      return 1;
    case 'outline':
      return 2;
    case 'generate':
    case 'draft':
      return 3;
    case 'quality':
      return 4;
    case 'complete':
      return 5;
    default:
      return 0;
  }
}

export function canOpenSpineStop(
  phase: AgentPhase,
  stop: SpineStop,
): boolean {
  if (stop === 'delivery') {
    return ['draft', 'quality', 'complete'].includes(phase);
  }
  const target =
    stop === 'draft'
      ? 3
      : stop === 'quality'
        ? 4
        : phaseToSpineIndex(stop);
  return target <= phaseToSpineIndex(phase);
}

export function mainSectionContent(config: WsConfig): Record<string, string> {
  const raw = config.sectionContent;
  return raw && typeof raw === 'object' ? { ...raw } : {};
}

export function documentBodyToHtml(document: WsDocument): string {
  const blocks = Array.isArray(document.body.blocks)
    ? document.body.blocks
    : [];
  return blocks
    .map((block) => (typeof block.content === 'string' ? block.content : ''))
    .filter(Boolean)
    .join('\n');
}

export function htmlToDocumentBody(html: string): Record<string, unknown> {
  return {
    blocks: [
      {
        id: 'main',
        type: 'section',
        content: html,
      },
    ],
  };
}

export function primaryDocument(documents: WsDocument[]): WsDocument | null {
  return [...documents].sort((a, b) => a.ordinal - b.ordinal)[0] ?? null;
}

export function unresolvedConflictCount(state: AgentState): number {
  return state.contextPlan.conflicts.filter((conflict) => !conflict.resolved)
    .length;
}

export function hasGeneratedContent(config: WsConfig): boolean {
  return Object.values(mainSectionContent(config)).some((content) =>
    content.replace(/<[^>]+>/g, '').trim(),
  );
}

export function normalizeGenerationStages(
  run: GenerationStatusResponse | null | undefined,
): GenerationStage[] {
  if (!run) return [];
  const byName = new Map(run.stages.map((stage) => [stage.name, stage]));
  // Only return server-emitted stages. Never manufacture status or progress.
  return SERVER_STAGE_NAMES.flatMap((name) => {
    const stage = byName.get(name);
    return stage ? [stage] : [];
  });
}

export function errorCode(error: unknown): string {
  const value = error as
    | { code?: string; statusCode?: number; body?: { code?: string; message?: string }; message?: string }
    | null;
  return value?.code ?? value?.body?.code ?? String(value?.statusCode ?? 'UNKNOWN');
}

export function errorMessage(error: unknown, fallback: string): string {
  const value = error as
    | { message?: string; body?: { message?: string } }
    | null;
  return value?.body?.message ?? value?.message ?? fallback;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
