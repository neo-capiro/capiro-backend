import type { ChatMessage } from './chat-store.js';
import { meriRuntimeStatus } from './meri-runtime-status.js';
import {
  mapPersistedCitations,
  mapPersistedContextPacketId,
  mapPersistedGroundingCaveat,
  mapPersistedRetrieval,
  mapPersistedVerification,
  mapPersistedWorkPerformed,
} from '../../vnext/meri/meri-route-state.js';

/** Public, persisted research state. Never infer completion from a closed socket. */
export interface MeriResearchRun {
  id: string;
  phase: 'plan' | 'research';
  status:
    | 'running'
    | 'complete'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'partial'
    | 'awaiting_clarification';
  stage: string;
  startedAt?: string;
  heartbeatAt?: string;
  failureReason?: string;
  elapsedMs?: number;
}

export interface MeriRecoveredResearch {
  id: string;
  conversationId: string;
  title: string;
  run: MeriResearchRun;
  questions: string[];
  plan: string[];
  planMessageId: string | null;
  reportMessageId: string | null;
  report: string | null;
  reportEvidence?: MeriResearchReportEvidence;
}

export type MeriResearchReportEvidence = Pick<
  ChatMessage,
  | 'citations'
  | 'contextPacketId'
  | 'retrieval'
  | 'verification'
  | 'groundingCaveat'
  | 'groundingStatement'
  | 'runtimeStatus'
  | 'orchestratorIntent'
  | 'orchestratorTier'
  | 'planSteps'
  | 'trustSteps'
>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function readResearchRun(value: unknown): MeriResearchRun | null {
  const run = record(value);
  if (
    typeof run.id !== 'string' ||
    !['plan', 'research'].includes(String(run.phase)) ||
    ![
      'running',
      'complete',
      'failed',
      'cancelled',
      'interrupted',
      'partial',
      'awaiting_clarification',
    ].includes(String(run.status))
  )
    return null;
  return {
    id: run.id,
    phase: run.phase as MeriResearchRun['phase'],
    status: run.status as MeriResearchRun['status'],
    stage: typeof run.stage === 'string' ? run.stage : 'Research',
    ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}),
    ...(typeof run.heartbeatAt === 'string' ? { heartbeatAt: run.heartbeatAt } : {}),
    ...(typeof run.failureReason === 'string' ? { failureReason: run.failureReason } : {}),
    ...(typeof run.elapsedMs === 'number' && Number.isFinite(run.elapsedMs)
      ? { elapsedMs: Math.max(0, run.elapsedMs) }
      : {}),
  };
}

export function readRecoveredResearch(
  value: unknown,
  conversationId: string,
): MeriRecoveredResearch | null {
  const session = record(value);
  const metadata = record(session.metadata);
  const handoff = record(metadata.handoff);
  const run = readResearchRun(session.run ?? metadata.run);
  if (typeof session.id !== 'string' || handoff.conversationId !== conversationId || !run)
    return null;
  const report = record(session.report);
  const publicMetadata = record(session.reportMetadata);
  return {
    id: session.id,
    conversationId,
    title: typeof session.title === 'string' ? session.title : 'Research',
    run,
    questions: strings(session.clarifyingQuestions),
    plan: strings(session.plan),
    planMessageId: typeof metadata.planMessageId === 'string' ? metadata.planMessageId : null,
    reportMessageId: typeof metadata.reportMessageId === 'string' ? metadata.reportMessageId : null,
    // The server applies held-report policy; only its public artifact body is used.
    report: typeof report.bodyText === 'string' ? report.bodyText : null,
    ...(Object.keys(publicMetadata).length
      ? {
          reportEvidence: readResearchReportEvidence(publicMetadata),
        }
      : {}),
  };
}

/** Use the same validated public metadata for the final stream event and reload. */
export function readResearchReportEvidence(value: unknown): MeriResearchReportEvidence {
  const metadata = record(value);
  const persisted = { metadata };
  return {
    citations: mapPersistedCitations(persisted),
    ...mapPersistedWorkPerformed(persisted),
    contextPacketId: mapPersistedContextPacketId(persisted),
    retrieval: mapPersistedRetrieval(persisted),
    verification: mapPersistedVerification(persisted),
    groundingCaveat: mapPersistedGroundingCaveat(persisted),
    groundingStatement:
      typeof metadata.groundingStatement === 'string' ? metadata.groundingStatement : undefined,
    runtimeStatus: meriRuntimeStatus(metadata),
  };
}

export function mayResumeResearch(run: MeriResearchRun): boolean {
  return (
    ['interrupted', 'failed', 'partial', 'cancelled'].includes(run.status) ||
    (run.phase === 'plan' && run.status === 'complete')
  );
}

export function researchRecoveryLabel(run: MeriResearchRun): string {
  if (run.stage === 'Research request saved; planning has not started')
    return 'Your research request is saved. Resume to start the plan.';
  if (run.stage === 'Clarifications saved; research has not started')
    return 'Your answers are saved. Resume to begin research.';
  if (run.status === 'running') return `${run.stage}. Research continues on the server.`;
  if (run.status === 'awaiting_clarification') return 'Research is waiting for your answers.';
  if (run.phase === 'plan' && run.status === 'complete')
    return 'Your research plan is ready to continue.';
  if (run.status === 'cancelled') return 'Research was stopped. You can resume this saved request.';
  if (run.status === 'partial')
    return 'Research did not complete. Resume this saved request to retry the report.';
  return 'Research was interrupted. Resume this saved request with its original evidence and scope.';
}
