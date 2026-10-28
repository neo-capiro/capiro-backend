// WS-22 native generation bridge — the single approved path from a Workspace
// document-agent generation phase to the existing greenfield Meri native
// conversation owner, and from that owner's result into the EXISTING draft
// proposal/revision owner.
//
// Why this file exists: the supported generated phases (brief synthesis,
// context recommend, context analyze, outline generation and the document run)
// used to be served by `WorkspaceReasoningGateway` / `GenerationService`, which
// perform direct Anthropic provider IO and hold the dormant MeriV2 orchestrator
// proxy. Those are not the approved greenfield owner. This leaf replaces only
// the *seam*: it prepares ONE canonical native conversation SDK turn for the
// exact authenticated identity and the draft's selected client, keeps the exact
// request/run/proposal identities, and lets the native result enter the
// existing WsAgentProposal owner as a pending proposal that a human must
// explicitly accept. It never writes document content autonomously and it never
// falls back to the legacy owners.
//
// Dependency-light on purpose: this module imports only node:crypto and types,
// so it can be exercised by a plain unit test without Prisma, NestJS, a
// database, the network, a model or a browser.
//
// Ownership boundary (see NEEDS-COORDINATION.txt):
//   * `NativeGenerationTurnPort` is the reserved Meri-side producer leaf. Until
//     a deployment composes a real implementation, `available()` is false and
//     every supported phase answers an explicit unavailability.
//   * `NativeGenerationProposalOwner` is the EXISTING owner
//     (`DocumentAgentRevisionService.createProposal`) — not a new store.
import { createHash } from 'node:crypto';
import {
  computeOutlineHash,
  type ContextConflict,
  type ContextCoverage,
  type DocumentAgentOutlineSection,
  type DocumentAgentState,
} from './document-agent-state.js';

/** Injection token for the approved greenfield Meri native conversation owner. */
export const NATIVE_GENERATION_TURN = Symbol('NATIVE_GENERATION_TURN');

/** The generated phases this bridge is allowed to serve. */
export type NativeGenerationPhase =
  | 'brief'
  | 'context-recommend'
  | 'context-analyze'
  | 'outline'
  | 'document';

export const NATIVE_GENERATION_PHASES: readonly NativeGenerationPhase[] = [
  'brief',
  'context-recommend',
  'context-analyze',
  'outline',
  'document',
];

/**
 * The explicit paid-generation intent a supported phase must carry. It is a
 * truthful field of the request the caller already sends: the five supported
 * routes declare `paidGeneration` in their closed DTOs, so the intent travels
 * as validated body data and the client can never start paid generation
 * implicitly. There is no acknowledgement header and no borrowed
 * `Idempotency-Key` value: the route's own `idempotencyKey` keeps its ordinary
 * request-equality meaning, and the native request identity is derived by this
 * bridge from the exact request (see `nativeGenerationRequestId`).
 */
export type NativeGenerationIntent = {
  acknowledged: true;
};

/** One exact retained Workspace source id the turn is scoped to. */
export type NativeGenerationSource = { id: string; kind: string };

/**
 * The exact retained native request identity. A read or cancel addresses THESE
 * five facts (never a body-carried authority), so the native owner can compare
 * them with the identity derived from the request it already retained.
 */
export type NativeGenerationTurnSubject = {
  requestId: string;
  tenantId: string;
  actorId: string;
  draftId: string;
  clientId: string | null;
  /**
   * The exact run the original turn started, when the caller retained it. A read
   * or cancel that carries it must resolve to exactly this run; the conversation
   * itself is always DERIVED from the exact request id, never body-selected.
   */
  runId?: string;
};

/**
 * The closed native turn request. Identity comes from the authenticated
 * context; the client comes from the draft's canonical client binding.
 */
export type NativeGenerationTurnRequest = NativeGenerationTurnSubject & {
  phase: NativeGenerationPhase;
  expectedRevision: number;
  paidGeneration: true;
  sources: NativeGenerationSource[];
};

/** The native result payload, narrowed per phase. */
export type NativeGenerationResult = {
  brief?: {
    objective?: string;
    audience?: string;
    desiredAction?: string;
    subject?: string;
    centralArgument?: string;
    evidenceInstructions?: string;
    tone?: string;
    targetPages?: number;
    deadline?: string;
    assumptions: Array<{ id: string; text: string; status: 'open' | 'confirmed' | 'rejected' }>;
    provenance: Record<string, 'user' | 'retrieved' | 'suggested' | 'assumed'>;
  };
  context?: {
    includedItemIds: string[];
    excludedItems: Array<{ itemId: string; reason: string }>;
    conflicts?: ContextConflict[];
    coverage?: ContextCoverage;
  };
  outline?: DocumentAgentOutlineSection[];
  /** The document body, keyed by the approved outline's section ids, in order. */
  document?: { sections: Array<{ id: string; text: string }> };
};

export type NativeGenerationTurnOutcome =
  | { status: 'complete'; runId: string; result: NativeGenerationResult }
  | { status: 'approval_required'; runId: string; proposalId: string }
  | { status: 'failed'; runId: string; state: string }
  | { status: 'unknown'; requestId: string };

/**
 * The reserved Meri-side producer: the conversation product-control owner that
 * commits the immutable prompt/window/skill pins, runs the existing Claude
 * Agent SDK turn, and returns ONE turn result with that owner's exact-request /
 * UNKNOWN / cancel fence. `readTurn` is the exact-request read-back a reconcile
 * uses instead of a blind retry.
 *
 * Every call carries the CURRENT authenticated session credential. The native
 * owner verifies it itself; this bridge never derives tenant, actor or client
 * authority from a body.
 */
export interface NativeGenerationTurnPort {
  turn(
    request: NativeGenerationTurnRequest,
    options: { credential: string; signal?: AbortSignal },
  ): Promise<NativeGenerationTurnOutcome>;
  readTurn(request: NativeGenerationTurnRequest, credential: string): Promise<NativeGenerationTurnOutcome | null>;
  cancel(subject: NativeGenerationTurnSubject, credential: string): Promise<void>;
}

/** The EXISTING draft proposal/revision owner (`DocumentAgentRevisionService`). */
export interface NativeGenerationProposalOwner {
  createProposal(params: {
    tenantId: string;
    draftId: string;
    createdById: string;
    type: string;
    baseRevision: number;
    baseHash: string;
    payload: Record<string, unknown>;
  }): Promise<{ proposalId: string }>;
}

export type NativeGenerationAdmission =
  | { kind: 'result'; requestId: string; runId: string; result: NativeGenerationResult }
  | { kind: 'proposed'; requestId: string; runId: string; proposalId: string }
  | { kind: 'approval-required'; requestId: string; runId: string; proposalId: string }
  | { kind: 'unknown'; requestId: string };

export type NativeGenerationRefusalCode =
  | 'intent-required'
  | 'credential-required'
  | 'request-identity'
  | 'phase-gate'
  | 'owner-unavailable'
  | 'run-failed';

/** A refusal is a policy decision, not a transport failure. */
export class NativeGenerationRefusal extends Error {
  constructor(
    readonly code: NativeGenerationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeGenerationRefusal';
  }
}

const refusal = (code: NativeGenerationRefusalCode, message: string) =>
  new NativeGenerationRefusal(code, message);

const REQUEST_ID = /^wsgen:[a-f0-9]{64}$/;

/** Deterministic JSON so the request identity never depends on key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The request identity of the EXACT request. It is derived from the canonical
 * fact set (never chosen by a caller), so reloading the same request replays
 * the same native turn and any changed input produces a different identity.
 * No source text or prompt content enters the identity — only opaque ids,
 * phase, revision and the exact retained source ids.
 */
export function nativeGenerationRequestId(exact: {
  tenantId: string;
  actorId: string;
  draftId: string;
  clientId: string | null;
  phase: NativeGenerationPhase;
  expectedRevision: number;
  sources: NativeGenerationSource[];
}): string {
  const sources = [...exact.sources]
    .map((source) => ({ id: source.id, kind: source.kind }))
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
  return `wsgen:${createHash('sha256')
    .update(canonical({ kind: 'workspace-native-generation/1', ...exact, sources }), 'utf8')
    .digest('hex')}`;
}

/**
 * Validate the explicit paid-generation intent. A phase may not be issued
 * without it; the request identity that actually scopes the turn is derived by
 * the server from the exact request, so a caller can never name (or repoint) it.
 */
export function parseNativeGenerationIntent(raw: unknown): NativeGenerationIntent {
  if (raw !== true)
    throw refusal(
      'intent-required',
      'This action starts paid model generation and requires an explicit paid-generation intent.',
    );
  return { acknowledged: true };
}

/** The existing Workspace phase gate for each supported generated phase. */
export function assertNativeGenerationPhaseGate(
  state: DocumentAgentState,
  phase: NativeGenerationPhase,
): void {
  switch (phase) {
    case 'brief':
      if (!state.goal?.text)
        throw refusal('phase-gate', 'Set the document goal before synthesizing a brief.');
      return;
    case 'context-recommend':
    case 'context-analyze':
      if (!state.brief.objective)
        throw refusal('phase-gate', 'Write the brief objective before building the context plan.');
      return;
    case 'outline':
      if (!state.blueprintPin)
        throw refusal('phase-gate', 'A blueprint must be pinned before generating an outline.');
      return;
    case 'document':
      if (!state.brief.approvedAt)
        throw refusal('phase-gate', 'Brief must be approved before generation.');
      if (!state.contextPlan.approvedAt)
        throw refusal('phase-gate', 'Context must be approved before generation.');
      if (!state.outline.approvedAt)
        throw refusal('phase-gate', 'Outline must be approved before generation.');
      return;
  }
}

/**
 * The proposal type and payload the EXISTING outline accept path already
 * applies: `acceptProposal` reads `outline_revision` + `outlineSnapshot` and
 * re-checks staleness against the hash it recomputes through
 * `computeOutlineHash`. An outline change is therefore admitted as a pending
 * proposal and only lands when a reviewer holding `canReview` accepts it.
 */
export const NATIVE_GENERATION_OUTLINE_PROPOSAL_TYPE = 'outline_revision';

export type NativeGenerationAdmissionInput = {
  state: DocumentAgentState;
  phase: NativeGenerationPhase;
  tenantId: string;
  actorId: string;
  draftId: string;
  clientId: string | null;
  expectedRevision: number;
  sources: NativeGenerationSource[];
  intent: unknown;
  /** The CURRENT authenticated session credential the native owner verifies. */
  credential: string;
  signal?: AbortSignal;
};

/**
 * The bridge. It holds exactly two collaborators: the optional native turn
 * owner (the reserved producer) and the existing proposal owner. There is no
 * queue, no store and no second agent platform here.
 */
export class NativeGenerationBridge {
  constructor(
    private readonly owners: {
      turn?: NativeGenerationTurnPort;
      proposals: NativeGenerationProposalOwner;
    },
  ) {}

  /** True only when a real native owner is composed for this deployment. */
  available(): boolean {
    return this.owners.turn !== undefined;
  }

  /**
   * Admit one supported phase: validate the explicit paid intent and the exact
   * request identity, check the existing Workspace phase gate, issue exactly
   * one native turn, and hand a complete result to the existing proposal owner.
   */
  async admit(input: NativeGenerationAdmissionInput): Promise<NativeGenerationAdmission> {
    const request = this.exactRequest(input);
    parseNativeGenerationIntent(input.intent);
    this.requireCredential(input.credential);
    assertNativeGenerationPhaseGate(input.state, input.phase);
    const turn = this.owners.turn;
    if (!turn)
      throw refusal(
        'owner-unavailable',
        'The approved greenfield Meri native conversation owner is not composed for this deployment; no legacy provider is used.',
      );
    const outcome = await turn.turn(request, {
      credential: input.credential,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return this.admitOutcome(input, request.requestId, outcome);
  }

  /**
   * Reconcile an UNKNOWN admission. It reads the EXACT retained request back
   * from the native owner and never re-issues the turn — a blind retry could
   * start a second paid run.
   */
  async reconcile(input: NativeGenerationAdmissionInput): Promise<NativeGenerationAdmission> {
    const request = this.exactRequest(input);
    this.requireCredential(input.credential);
    const turn = this.owners.turn;
    if (!turn)
      throw refusal(
        'owner-unavailable',
        'The approved greenfield Meri native conversation owner is not composed for this deployment; no legacy provider is used.',
      );
    const outcome = await turn.readTurn(request, input.credential);
    if (outcome === null) return { kind: 'unknown', requestId: request.requestId };
    return this.admitOutcome(input, request.requestId, outcome);
  }

  /** Cancel the exact retained request at the native owner. */
  async cancel(subject: NativeGenerationTurnSubject, credential: string): Promise<void> {
    if (!REQUEST_ID.test(subject?.requestId ?? ''))
      throw refusal('request-identity', 'The generation request identity is missing or malformed.');
    this.requireCredential(credential);
    const turn = this.owners.turn;
    if (!turn)
      throw refusal(
        'owner-unavailable',
        'The approved greenfield Meri native conversation owner is not composed for this deployment; no legacy provider is used.',
      );
    await turn.cancel(subject, credential);
  }

  /** Every native call carries the CURRENT authenticated session credential. */
  private requireCredential(credential: string | undefined): asserts credential is string {
    if (typeof credential !== 'string' || credential.length === 0)
      throw refusal(
        'credential-required',
        'The current authenticated session credential is required to reach the native conversation owner.',
      );
  }

  private exactRequest(input: NativeGenerationAdmissionInput): NativeGenerationTurnRequest {
    return {
      phase: input.phase,
      tenantId: input.tenantId,
      actorId: input.actorId,
      draftId: input.draftId,
      clientId: input.clientId,
      expectedRevision: input.expectedRevision,
      // The explicit paid acknowledgement is part of the request the owner was
      // given, so the RETAINED request identity carries it too: a reconcile read
      // must present the same closed request the turn presented, or the owner
      // cannot recognise its own retained request.
      paidGeneration: true,
      sources: input.sources,
      requestId: nativeGenerationRequestId({
        tenantId: input.tenantId,
        actorId: input.actorId,
        draftId: input.draftId,
        clientId: input.clientId,
        phase: input.phase,
        expectedRevision: input.expectedRevision,
        sources: input.sources,
      }),
    };
  }

  private async admitOutcome(
    input: NativeGenerationAdmissionInput,
    requestId: string,
    outcome: NativeGenerationTurnOutcome,
  ): Promise<NativeGenerationAdmission> {
    if (outcome.status === 'unknown') return { kind: 'unknown', requestId };
    if (outcome.status === 'failed')
      throw refusal(
        'run-failed',
        `The native conversation run ended in ${outcome.state} without producing this phase's output.`,
      );
    if (outcome.status === 'approval_required')
      return {
        kind: 'approval-required',
        requestId,
        runId: outcome.runId,
        proposalId: outcome.proposalId,
      };
    // A document body is admitted as a PENDING `content_revision` proposal by the
    // document-agent SERVICE — the owner that holds the draft's existing
    // `sectionContent` and computes the proposal's base hash. This bridge never
    // writes document content: it only verifies that the native body keys EXACTLY
    // the approved outline's sections, in order, and hands the result back.
    if (input.phase === 'document') {
      const approved = input.state.outline.sections.map((section) => section.id);
      const document = outcome.result.document;
      if (!document || !approved.length || document.sections.length !== approved.length)
        throw refusal('phase-gate', 'The native document result did not carry the approved outline sections.');
      if (document.sections.some((section, index) => section.id !== approved[index] || !section.text.trim()))
        throw refusal('phase-gate', 'The native document body did not key the approved outline sections exactly.');
      return {
        kind: 'result',
        requestId,
        runId: outcome.runId,
        result: {
          document: {
            sections: document.sections.map((section) => ({ id: section.id, text: section.text })),
          },
        },
      };
    }
    // An outline change is admitted as a PENDING proposal through the existing
    // revision owner and only lands when a reviewer accepts it.
    if (input.phase === 'outline') {
      const { proposalId } = await this.owners.proposals.createProposal({
        tenantId: input.tenantId,
        draftId: input.draftId,
        createdById: input.actorId,
        type: NATIVE_GENERATION_OUTLINE_PROPOSAL_TYPE,
        baseRevision: input.state.revision,
        baseHash: computeOutlineHash(input.state.outline.sections),
        payload: nativeOutlineProposalPayload(input, requestId, outcome),
      });
      return { kind: 'proposed', requestId, runId: outcome.runId, proposalId };
    }
    // Brief and context phases: the validated native result is handed straight
    // back to the document-agent's own state owner, which applies it under its
    // mutation lock; the existing approval pins (`brief.approvedAt`,
    // `contextPlan.approvedAt`) stay the human acceptance.
    if (input.phase === 'brief') {
      if (!outcome.result.brief)
        throw refusal('phase-gate', 'The native brief result did not carry a brief.');
      return { kind: 'result', requestId, runId: outcome.runId, result: { brief: outcome.result.brief } };
    }
    if (!outcome.result.context)
      throw refusal('phase-gate', 'The native context result did not carry a context plan.');
    return { kind: 'result', requestId, runId: outcome.runId, result: { context: outcome.result.context } };
  }
}

/**
 * The pending outline proposal payload. It carries the native result under the
 * field name the EXISTING accept path already applies (`outlineSnapshot`), plus
 * the retained provenance ids. No source text is placed in a URL, and no
 * private runtime type is imported.
 */
export function nativeOutlineProposalPayload(
  input: NativeGenerationAdmissionInput,
  requestId: string,
  outcome: Extract<NativeGenerationTurnOutcome, { status: 'complete' }>,
): Record<string, unknown> {
  if (!Array.isArray(outcome.result.outline))
    throw refusal('phase-gate', 'The native outline result did not carry outline sections.');
  return {
    outlineSnapshot: outcome.result.outline,
    nativeGeneration: {
      owner: 'meri-greenfield-native-conversation',
      requestId,
      runId: outcome.runId,
      phase: input.phase,
      expectedRevision: input.expectedRevision,
      clientId: input.clientId,
    },
  };
}
