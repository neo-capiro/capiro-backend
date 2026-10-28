/**
 * WS-22 durable intake → approved greenfield native conversation owner.
 *
 * WHY THIS FILE EXISTS
 * The two-step Max draft flow (`POST /document-agent/intakes`) persists a real,
 * idempotent receipt — draft, server-authorized sources, `ws_intake` snapshot and
 * a durable `ws_generation_run` — and then left the run's `drafting` stage to
 * `GenerationService`, which performs direct Anthropic provider IO and holds the
 * dormant MeriV2 orchestrator proxy. That is the legacy owner, so the flow's
 * submit action stayed unactivated on the consumer side even though its contract
 * shipped. This adapter removes that seam and nothing else:
 *
 *   * it derives ONE canonical native turn request for the DURABLE RUN from the
 *     facts the run already retains (the frozen intake snapshot, the pinned
 *     published blueprint version and the draft's own agent revision) and issues
 *     it through `NATIVE_GENERATION_TURN` — the SAME injection token, the SAME
 *     `NativeGenerationConversationClient` transport and the SAME closed wire
 *     protocol the five Workspace document-agent phases already use. There is no
 *     second transport, no queue and no store here;
 *   * it reuses the existing `document` phase of that closed vocabulary: the
 *     pinned published blueprint version IS this flow's approved structure, and
 *     its section ids travel as the retained `outline-section` sources, so the
 *     native answer is keyed to exactly those sections, in order;
 *   * it never persists the current session credential, never derives authority
 *     from a body, never re-dispatches a retained request, and never falls back
 *     to a legacy provider.
 *
 * The adapter itself WRITES NOTHING. It reads the draft's retained facts, decides
 * whether the run may issue its one paid turn or must instead re-read the SAME
 * retained request, validates the answer against the retained blueprint, and
 * returns an admission. Every durable write (run row, per-section state, draft
 * content, retained binding) stays with the run's existing owners
 * (`GenerationRunWorkerService` for the run, the draft config for the binding).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit } from '../collaborators/role-policy.js';
import {
  NATIVE_GENERATION_TURN,
  nativeGenerationRequestId,
  NativeGenerationRefusal,
  type NativeGenerationSource,
  type NativeGenerationTurnOutcome,
  type NativeGenerationTurnPort,
  type NativeGenerationTurnRequest,
} from '../document-agent/native-generation.bridge.js';
import { NativeGenerationOwnerError } from '../document-agent/native-generation-conversation.client.js';

/** The closed native phase the durable intake run reuses. */
export const NATIVE_INTAKE_PHASE = 'document' as const;

/** The owner identity recorded in a retained binding. */
export const NATIVE_INTAKE_OWNER = 'meri-greenfield-native-conversation' as const;

/**
 * Local guards for the private leaf's own request bound (16 KiB, bounded id
 * arrays). They are conservative on purpose: an oversized retained set is
 * refused here with a stated reason instead of being sent to the owner.
 */
const MAX_SOURCES = 128;
const MAX_SECTIONS = 64;

/** A `ws_generation_run` row, as the adapter needs to address it. */
export type NativeIntakeRunRef = {
  tenantId: string;
  runId: string;
  draftId: string;
  actorId: string;
};

/**
 * The retained native binding for one durable run. It carries the derived request
 * identity, the owner's run identity once the owner answered, and the retained
 * ids the request was scoped to — never a credential, never prompt or document
 * text, never authority.
 */
export type NativeIntakeBinding = {
  owner: typeof NATIVE_INTAKE_OWNER;
  phase: typeof NATIVE_INTAKE_PHASE;
  requestId: string;
  nativeRunId: string | null;
  outcome: 'unknown' | 'approval-required' | 'complete' | 'failed';
  expectedRevision: number;
  retainedAt: string;
  /** The retained source ids the EXACT request carried (ids only). */
  sourceIds: string[];
  /** The pinned blueprint's section ids the answer must key, in order. */
  sectionIds: string[];
  /** The owner's existing proposal id, when it retained an approval requirement. */
  proposalId?: string;
};

/** One accepted document section, mapped to the draft's own section title. */
export type NativeIntakeSection = { id: string; title: string; text: string };

export type NativeIntakeAdmission =
  | {
      kind: 'result';
      binding: NativeIntakeBinding;
      sections: NativeIntakeSection[];
      detail: string;
    }
  | { kind: 'unknown'; binding: NativeIntakeBinding; detail: string }
  | {
      kind: 'approval-required';
      binding: NativeIntakeBinding;
      proposalId: string;
      detail: string;
    }
  | {
      kind: 'failed';
      binding: NativeIntakeBinding;
      state: string;
      retryable: false;
      detail: string;
    }
  | {
      kind: 'refused';
      binding: NativeIntakeBinding | null;
      code: string;
      message: string;
      retryable: boolean;
      detail: string;
    };

/**
 * The facts the exact request is derived from. They come from the draft's own
 * retained state, so re-deriving them for the same run always yields the same
 * request identity (that is what makes an exact replay an exact replay) and a
 * changed revision, blueprint or retained source set yields a different one.
 */
export type NativeIntakeFacts = {
  draftId: string;
  clientId: string | null;
  expectedRevision: number;
  blueprint: {
    versionId: string;
    version: number;
    definitionHash: string;
    sectionIds: string[];
    sectionTitles: string[];
  };
  sources: NativeGenerationSource[];
  /** The binding already retained for this run, when one is. */
  retained: NativeIntakeBinding | null;
};

/** A refusal of this flow's own retention rules (a policy decision, not IO). */
export class NativeIntakeRefusal extends Error {
  constructor(
    readonly code: NativeIntakeRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeIntakeRefusal';
  }
}

export type NativeIntakeRefusalCode =
  | 'not-an-intake-run'
  | 'blueprint-not-pinned'
  | 'blueprint-changed'
  | 'blueprint-has-no-sections'
  | 'blueprint-ambiguous-titles'
  | 'retained-request-mismatch'
  | 'credential-required'
  | 'owner-unavailable'
  | 'answer-mismatch';

const refusal = (code: NativeIntakeRefusalCode, message: string) =>
  new NativeIntakeRefusal(code, message);

type BlueprintDefinition = {
  sections?: Array<{ id?: unknown; title?: unknown }>;
};

type StoredIntake = {
  schemaVersion?: number;
  blueprintVersionId?: string;
  blueprintVersion?: number;
  blueprintDefinitionHash?: string;
  intakeId?: string;
  runId?: string;
  native?: unknown;
};

type StoredIntakeSnapshot = {
  blueprintVersionId?: string;
  resolvedSources?: { sources?: Array<{ id?: unknown; sourceType?: unknown }> };
};

@Injectable()
export class NativeIntakeAdapter {
  private readonly logger = new Logger(NativeIntakeAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    @Optional()
    @Inject(NATIVE_GENERATION_TURN)
    private readonly turn?: NativeGenerationTurnPort | null,
  ) {}

  /** True only when a real native owner is composed for this deployment. */
  available(): boolean {
    return this.turn !== undefined && this.turn !== null;
  }

  /**
   * The exact canonical request for this durable run, derived from the run's own
   * retained facts. Exported as a free function too, so the derivation can be
   * asserted without a database.
   */
  async exactRequest(run: NativeIntakeRunRef): Promise<{
    facts: NativeIntakeFacts;
    request: NativeGenerationTurnRequest;
  }> {
    const facts = await this.retainedFacts(run);
    return { facts, request: exactIntakeRequest(facts, run) };
  }

  /**
   * Admit this run's native work ONCE. A run with nothing retained issues exactly
   * one turn. A run whose request was already issued is READ FIRST: the owner is
   * asked for the SAME stored request, and only when the owner itself answers
   * that it holds no run for that exact request is the same request issued once —
   * the request identity (and the owner's own allocation journal) is what makes
   * that at-most-once. A retained request is NEVER blindly re-dispatched.
   */
  async admit(run: NativeIntakeRunRef, credential: string): Promise<NativeIntakeAdmission> {
    let facts: NativeIntakeFacts;
    try {
      facts = await this.retainedFacts(run);
    } catch (error) {
      return this.refused(null, error);
    }
    const request = exactIntakeRequest(facts, run);
    // A run that already retained an exact request may only ever be served from
    // THAT request. The canonical request is derived from CURRENT facts, so a
    // draft that moved since (the drafting guard is inert at revision 0, where
    // these runs start, and ordinary saves do not bump the revision) derives a
    // DIFFERENT identity: reading it would miss the owner's own journal entry,
    // and the follow-up issue would be a SECOND paid run under a new identity
    // that silently overwrites the retained one. Refuse instead — terminally,
    // before ANY owner call, and with no binding in the admission, so nothing is
    // written over the original: it stays exactly as retained and can still be
    // read or cancelled as it stands (the caller re-intakes for the moved draft).
    if (facts.retained !== null && facts.retained.requestId !== request.requestId)
      return this.refused(
        facts,
        refusal(
          'retained-request-mismatch',
          'This run already retained a different exact native request, so no new paid request is derived for it.',
        ),
      );
    const owner = this.turn;
    if (owner === undefined || owner === null)
      return this.refused(
        null,
        refusal(
          'owner-unavailable',
          'The approved greenfield Meri native conversation owner is not composed for this deployment; no legacy provider is used.',
        ),
      );
    if (typeof credential !== 'string' || credential.length === 0)
      return this.refused(
        null,
        refusal(
          'credential-required',
          'The current authenticated session credential is required to reach the native conversation owner.',
        ),
      );

    let outcome: NativeGenerationTurnOutcome;
    try {
      if (facts.retained === null) {
        outcome = await owner.turn(request, { credential });
      } else {
        const read = await owner.readTurn(request, credential);
        if (read === null) {
          // The owner's own explicit answer is that it holds no run for this exact
          // request, so the retained identity may be issued once. The SAME request
          // bytes go out: nothing is re-derived, re-scoped or repointed.
          outcome = await owner.turn(request, { credential });
        } else {
          outcome = read;
        }
      }
    } catch (error) {
      return this.refused(facts, error, request.requestId);
    }
    try {
      return this.admission(facts, request, outcome);
    } catch (error) {
      // An answer that does not key the pinned structure is a failure of this
      // request, reported as such — never written and never re-issued blindly.
      return this.refused(facts, error, request.requestId);
    }
  }

  /**
   * The run's retained facts. The draft is read tenant-scoped and the acting
   * identity must still hold edit rights on it (the existing collaborators owner
   * is the current-access authority for this flow), the pinned blueprint version
   * must still hash to the pinned definition hash, and the retained source set is
   * the FROZEN intake snapshot's server-authorized set — never later config and
   * never a body.
   */
  async retainedFacts(run: NativeIntakeRunRef): Promise<NativeIntakeFacts> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { prospectId: null, id: run.draftId, tenantId: run.tenantId },
      select: { id: true, clientId: true, config: true },
    });
    if (!draft) throw refusal('not-an-intake-run', 'The run is not linked to a draft.');

    // Current access: the same owner the interactive route asserts, re-checked on
    // every native call (an attended admission and a later reconcile alike).
    await this.collaborators.assertCan(
      run.tenantId,
      run.draftId,
      run.actorId,
      canEdit,
      'Only owners and editors can generate content in this document',
    );

    const config = (draft.config as Record<string, unknown> | null) ?? {};
    const intake = config.quickDraftIntake as StoredIntake | undefined;
    if (!intake || typeof intake.blueprintVersionId !== 'string')
      throw refusal(
        'not-an-intake-run',
        'This run was not created by the durable intake flow, so it has no pinned intake facts.',
      );

    const state = config.documentAgent as { revision?: unknown } | undefined;
    const expectedRevision = typeof state?.revision === 'number' ? state.revision : 0;

    const blueprintVersion = await this.prisma.wsBlueprintVersion.findFirst({
      where: { id: intake.blueprintVersionId, OR: [{ tenantId: null }, { tenantId: run.tenantId }] },
      select: { id: true, version: true, definitionHash: true, definition: true },
    });
    if (!blueprintVersion)
      throw refusal(
        'blueprint-not-pinned',
        'The blueprint version this intake pinned is no longer available; the retained request cannot be re-derived.',
      );
    // The retained structure must be the PINNED one. A version whose bytes no
    // longer hash to the pinned hash is refused rather than silently re-derived.
    if (
      typeof intake.blueprintDefinitionHash === 'string' &&
      intake.blueprintDefinitionHash !== blueprintVersion.definitionHash
    )
      throw refusal(
        'blueprint-changed',
        'The pinned blueprint version no longer matches the definition hash retained at intake time.',
      );

    const sections = ((blueprintVersion.definition as BlueprintDefinition | null)?.sections ?? []).map(
      (section, index) => ({
        id: typeof section.id === 'string' && section.id ? section.id : `section-${index + 1}`,
        title:
          typeof section.title === 'string' && section.title ? section.title : `Section ${index + 1}`,
      }),
    );
    if (!sections.length || sections.length > MAX_SECTIONS)
      throw refusal(
        'blueprint-has-no-sections',
        'The selected blueprint does not contain any usable document sections.',
      );
    // EVERY section must key its own output. The generated body is keyed by
    // section TITLE (the draft's own editor field), so two sections sharing a
    // title would collide — one section's body would silently replace the
    // other's. This is a property of the pinned structure, not of the current
    // access or owner state, so it is refused BEFORE the native effect (nothing
    // is sent to the owner) and is terminal for this request. Section ids, the
    // pinned definition hash and the pinned order are untouched.
    const titles = new Set<string>();
    for (const section of sections) {
      if (titles.has(section.title))
        throw refusal(
          'blueprint-ambiguous-titles',
          `The pinned blueprint declares more than one section titled "${section.title}", so a generated body could not be keyed to a unique section.`,
        );
      titles.add(section.title);
    }

    const snapshot = await this.retainedSnapshot(run);
    const sources = intentSources(run.draftId, intake.blueprintVersionId, draft.clientId ?? null, snapshot, sections);

    return {
      draftId: run.draftId,
      clientId: draft.clientId ?? null,
      expectedRevision,
      blueprint: {
        versionId: blueprintVersion.id,
        version: blueprintVersion.version,
        definitionHash: blueprintVersion.definitionHash,
        sectionIds: sections.map((section) => section.id),
        sectionTitles: sections.map((section) => section.title),
      },
      sources,
      retained: readBinding(intake.native),
    };
  }

  /** The FROZEN intake snapshot's resolved, server-authorized source set. */
  private async retainedSnapshot(run: NativeIntakeRunRef): Promise<StoredIntakeSnapshot> {
    const intake = await this.prisma.wsIntake.findFirst({
      where: { tenantId: run.tenantId, runId: run.runId },
      select: { intakeSnapshot: true },
    });
    return (intake?.intakeSnapshot as StoredIntakeSnapshot | null) ?? {};
  }

  private refused(
    facts: NativeIntakeFacts | null,
    error: unknown,
    requestId?: string,
  ): NativeIntakeAdmission {
    const code = nativeIntakeRefusalCode(error);
    const message = error instanceof Error ? error.message : 'The native conversation owner failed.';
    this.logger.warn(`native intake refused (${code}): ${message}`);
    const binding =
      facts && requestId
        ? { ...bindingFor(facts, requestId), outcome: 'unknown' as const, nativeRunId: null }
        : null;
    return {
      kind: 'refused',
      binding,
      code,
      message,
      retryable: nativeIntakeRetryable(error),
      detail: `native ${NATIVE_INTAKE_PHASE} admission refused (${code}): ${message}`.slice(0, 500),
    };
  }

  private admission(
    facts: NativeIntakeFacts,
    request: NativeGenerationTurnRequest,
    outcome: NativeGenerationTurnOutcome,
  ): NativeIntakeAdmission {
    const base = bindingFor(facts, request.requestId);
    if (outcome.status === 'unknown')
      return {
        kind: 'unknown',
        binding: { ...base, outcome: 'unknown', nativeRunId: null },
        detail: `native ${request.phase} request ${request.requestId} retained; the owner has not published a terminal run yet`,
      };
    if (outcome.status === 'failed')
      return {
        kind: 'failed',
        binding: { ...base, outcome: 'failed', nativeRunId: outcome.runId },
        state: outcome.state,
        retryable: false,
        detail: `native ${request.phase} run ${outcome.runId} ended in ${outcome.state}`,
      };
    if (outcome.status === 'approval_required')
      return {
        kind: 'approval-required',
        binding: { ...base, outcome: 'approval-required', nativeRunId: outcome.runId, proposalId: outcome.proposalId },
        proposalId: outcome.proposalId,
        detail: `native ${request.phase} run ${outcome.runId} retained an approval requirement (proposal ${outcome.proposalId})`,
      };

    // A complete answer must key the PINNED blueprint's sections exactly, in
    // order, each with real body text. Nothing is trusted from the answer itself.
    const document = outcome.result.document;
    const expected = facts.blueprint.sectionIds;
    if (!document || document.sections.length !== expected.length)
      throw refusal(
        'answer-mismatch',
        'The native document answer did not carry the pinned blueprint sections.',
      );
    if (document.sections.some((section, index) => section.id !== expected[index] || !section.text.trim()))
      throw refusal(
        'answer-mismatch',
        'The native document answer did not key the pinned blueprint sections exactly.',
      );
    return {
      kind: 'result',
      binding: { ...base, outcome: 'complete', nativeRunId: outcome.runId },
      sections: document.sections.map((section, index) => ({
        id: section.id,
        title: facts.blueprint.sectionTitles[index]!,
        text: section.text,
      })),
      detail: `native ${request.phase} run ${outcome.runId} admitted ${document.sections.length} sections`,
    };
  }
}

/**
 * Refusals that are terminal for the exact request (the request itself can never
 * be admitted) versus ones that depend on the CURRENT access/owner state and may
 * legitimately be retried by an attended attempt.
 */
const RETRYABLE_CODES = new Set<string>([
  'unavailable',
  'authority',
  'credential-required',
  'owner-unavailable',
  'unexpected',
]);

/** The stable code of a refusal from any of this flow's three owners. */
export function nativeIntakeRefusalCode(error: unknown): string {
  if (error instanceof NativeGenerationRefusal) return error.code;
  if (error instanceof NativeGenerationOwnerError) return error.code;
  if (error instanceof NativeIntakeRefusal) return error.code;
  return 'unexpected';
}

/**
 * Whether a refusal may still be resolved by an attended attempt holding current
 * access, rather than being terminal for the exact request. Shared with the run
 * owner, so a refusal is classified identically wherever it is observed.
 */
export function nativeIntakeRetryable(error: unknown): boolean {
  return RETRYABLE_CODES.has(nativeIntakeRefusalCode(error));
}

const bindingFor = (facts: NativeIntakeFacts, requestId: string): NativeIntakeBinding => ({
  owner: NATIVE_INTAKE_OWNER,
  phase: NATIVE_INTAKE_PHASE,
  requestId,
  nativeRunId: null,
  outcome: 'unknown',
  expectedRevision: facts.expectedRevision,
  retainedAt: new Date().toISOString(),
  sourceIds: facts.sources.map((source) => `${source.kind}:${source.id}`),
  sectionIds: [...facts.blueprint.sectionIds],
});

/** Read a retained binding from the draft's own intake linkage block. */
export function readBinding(raw: unknown): NativeIntakeBinding | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.requestId !== 'string' || !/^wsgen:[a-f0-9]{64}$/.test(value.requestId)) return null;
  if (
    value.outcome !== 'unknown' &&
    value.outcome !== 'approval-required' &&
    value.outcome !== 'complete' &&
    value.outcome !== 'failed'
  )
    return null;
  return {
    owner: NATIVE_INTAKE_OWNER,
    phase: NATIVE_INTAKE_PHASE,
    requestId: value.requestId,
    nativeRunId: typeof value.nativeRunId === 'string' ? value.nativeRunId : null,
    outcome: value.outcome,
    expectedRevision: typeof value.expectedRevision === 'number' ? value.expectedRevision : 0,
    retainedAt: typeof value.retainedAt === 'string' ? value.retainedAt : new Date(0).toISOString(),
    sourceIds: Array.isArray(value.sourceIds) ? value.sourceIds.filter((id): id is string => typeof id === 'string') : [],
    sectionIds: Array.isArray(value.sectionIds) ? value.sectionIds.filter((id): id is string => typeof id === 'string') : [],
    ...(typeof value.proposalId === 'string' ? { proposalId: value.proposalId } : {}),
  };
}

/**
 * The exact canonical request. Its identity is derived by the SAME exported
 * function the document-agent bridge uses, over the run's retained facts only —
 * a caller can never name or repoint it, and re-deriving an unchanged request
 * always replays the owner's own retained request.
 */
export function exactIntakeRequest(
  facts: NativeIntakeFacts,
  run: { tenantId: string; actorId: string; draftId: string },
): NativeGenerationTurnRequest {
  const subject = {
    tenantId: run.tenantId,
    actorId: run.actorId,
    draftId: run.draftId,
    clientId: facts.clientId,
    phase: NATIVE_INTAKE_PHASE,
    expectedRevision: facts.expectedRevision,
    sources: facts.sources,
  };
  return {
    ...subject,
    paidGeneration: true,
    requestId: nativeGenerationRequestId(subject),
  };
}

/**
 * The retained source set of the exact request. It is ids only: the draft, the
 * pinned blueprint version, the client when the intake bound one, every
 * server-authorized resolved source of the frozen snapshot, and — in the pinned
 * blueprint's own order — the section ids the answer must key.
 */
export function intentSources(
  draftId: string,
  blueprintVersionId: string,
  clientId: string | null,
  snapshot: StoredIntakeSnapshot,
  sections: Array<{ id: string; title: string }>,
): NativeGenerationSource[] {
  const sources: NativeGenerationSource[] = [
    { id: draftId, kind: 'workspace-draft' },
    { id: blueprintVersionId, kind: 'blueprint-version' },
  ];
  if (clientId !== null) sources.push({ id: clientId, kind: 'client' });
  const seen = new Set(sources.map((source) => `${source.kind}:${source.id}`));
  for (const source of snapshot.resolvedSources?.sources ?? []) {
    if (typeof source?.id !== 'string' || !source.id) continue;
    if (typeof source.sourceType !== 'string' || !source.sourceType) continue;
    // The blueprint version is already carried as its canonical structural source.
    if (source.sourceType === 'blueprint_version') continue;
    const key = `${source.sourceType}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ id: source.id, kind: source.sourceType });
  }
  sources.push(...sections.map((section) => ({ id: section.id, kind: 'outline-section' })));
  if (sources.length > MAX_SOURCES)
    throw refusal(
      'not-an-intake-run',
      'The retained intake carries more sources than the native protocol accepts.',
    );
  return sources;
}
