import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { UniversalEntityResolutionOrchestratorService } from '../knowledge/entities/universal-entity-resolution-orchestrator.service.js';
import { contextStageTimer } from './context-stage-timer.service.js';
import type { UniversalEntityResolutionOrchestrationResult } from '../knowledge/entities/universal-entity-resolution-orchestrator.types.js';
import type { KnowledgeRef } from '../knowledge/knowledge.types.js';
import { RetrievalV2Service } from '../retrieval/retrieval-v2.service.js';
import type { RetrievalCallerContext, RetrievalRequest } from '../retrieval/retrieval-v2.types.js';
import type {
  ContextEntitySubjectInput,
  ContextResolutionRequest,
  ContextResolutionResult,
  ContextResolvedEntity,
  ContextRetrievalResult,
  NormalizedContextSecurityScope,
  ResolvedContextSubjectScope,
} from './context-resolver.types.js';

const RESOLVER_VERSION = 'phase15-v1' as const;

/**
 * Universal pre-retrieval scope resolver.
 *
 * SecurityScope, SubjectScope, and FocusEntities are deliberately separate.
 * UI state is recorded as a hint only: it cannot grant access and is never
 * promoted to subject/focus unless the caller explicitly asks for that.
 */
@Injectable()
export class ContextResolverService {
  constructor(
    private readonly entityResolver: UniversalEntityResolutionOrchestratorService,
    private readonly retrieval: RetrievalV2Service,
  ) {}

  async resolve(request: ContextResolutionRequest): Promise<ContextResolutionResult> {
    this.validateRequest(request);
    const securityScope = this.normalizeSecurityScope(request);
    const subjectScope = this.resolveSubjectScope(request, securityScope);
    const focusEntityRefs = this.normalizeFocusEntityRefs(request, securityScope, subjectScope);
    const currentObjectUsedAsFocus =
      request.includeCurrentObjectAsFocus === true && !!request.currentObject;
    const externalLookupPermitted =
      subjectScope.kind === 'external_entity' &&
      request.subject?.allowExternalLookup === true &&
      securityScope.allowExternalLookup;

    let subjectEntity: ContextResolvedEntity | undefined;
    if (subjectScope.kind === 'external_entity') {
      const canonicalFocus = focusEntityRefs.find((ref) => ref.type === 'canonical_entity');
      subjectEntity =
        !request.subject && canonicalFocus
          ? {
              status: 'resolved',
              canonicalEntityId: canonicalFocus.id,
              confidence: 1,
              resolutionMethod: 'explicit_canonical_reference',
              publicLookupRan: false,
              stopReason: 'explicit_canonical_reference',
              candidates: [],
            }
          : await this.resolveExternalSubject(request, externalLookupPermitted);

      if (subjectEntity.status !== 'resolved' || !subjectEntity.canonicalEntityId) {
        return this.result({
          request,
          securityScope,
          subjectScope,
          subjectEntity,
          focusEntityRefs,
          status: subjectEntity.status === 'resolved' ? 'error' : subjectEntity.status,
          stopReason:
            subjectEntity.status === 'resolved'
              ? 'resolved_entity_missing_canonical_id'
              : subjectEntity.stopReason,
          externalLookupPermitted,
          currentObjectUsedAsFocus,
        });
      }
      focusEntityRefs.push({
        type: 'canonical_entity',
        id: subjectEntity.canonicalEntityId,
        ...(subjectEntity.canonicalName ? { label: subjectEntity.canonicalName } : {}),
      });
    }

    const dedupedFocus = dedupeRefs(focusEntityRefs);
    const canonicalEntityIds = uniqueStrings(
      dedupedFocus.filter((ref) => ref.type === 'canonical_entity').map((ref) => ref.id),
    );
    const retrievalRequest = request.retrieval
      ? this.buildRetrievalRequest(
          request,
          securityScope,
          subjectScope,
          canonicalEntityIds,
          currentObjectUsedAsFocus,
        )
      : undefined;

    return this.result({
      request,
      securityScope,
      subjectScope,
      subjectEntity,
      focusEntityRefs: dedupedFocus,
      canonicalEntityIds,
      retrievalRequest,
      status: 'ready',
      stopReason: retrievalRequest ? 'context_resolved_for_retrieval' : 'context_scope_resolved',
      externalLookupPermitted,
      currentObjectUsedAsFocus,
    });
  }

  async resolveAndRetrieve(request: ContextResolutionRequest): Promise<ContextRetrievalResult> {
    // Resolver and retrieval are timed SEPARATELY. Reporting one combined
    // number cannot distinguish a slow subject resolution from a slow source.
    const resolution = await contextStageTimer.time('resolver', () => this.resolve(request));
    if (!resolution.retrievalAllowed || !resolution.retrievalRequest) {
      return { resolution };
    }
    const retrieval = await contextStageTimer.time('retrieval', () =>
      this.retrieval.retrieve(resolution.retrievalRequest!),
    );
    return { resolution, retrieval };
  }

  private validateRequest(request: ContextResolutionRequest): void {
    if (!request.tenantId?.trim()) {
      throw new BadRequestException('tenantId is required.');
    }
    if (!request.actorUserId?.trim()) {
      throw new BadRequestException('actorUserId is required.');
    }
    if (!request.task?.trim()) throw new BadRequestException('task is required.');
    if (
      request.maxTokens !== undefined &&
      (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new BadRequestException('maxTokens must be a positive integer.');
    }
    if (request.subjectScope && request.subjectScope !== 'external_entity' && request.subject) {
      throw new BadRequestException(
        'Explicit subject identity input is valid only for subjectScope=external_entity.',
      );
    }
    if (request.retrieval && request.retrieval.requestedDomains.length === 0) {
      throw new BadRequestException('retrieval.requestedDomains must not be empty.');
    }
  }

  private normalizeSecurityScope(
    request: ContextResolutionRequest,
  ): NormalizedContextSecurityScope {
    return {
      tenantId: request.tenantId.trim(),
      actorUserId: request.actorUserId.trim(),
      authorizedClientIds: uniqueStrings(request.securityScope.authorizedClientIds ?? []),
      authorizedMailboxConnectionIds: uniqueStrings(
        request.securityScope.authorizedMailboxConnectionIds ?? [],
      ),
      graphPartitions: [...(request.securityScope.graphPartitions ?? [])],
      // Double opt-in: the request and the server-derived policy must both allow it.
      allowExternalLookup: request.securityScope.allowExternalLookup === true,
    };
  }

  private resolveSubjectScope(
    request: ContextResolutionRequest,
    securityScope: NormalizedContextSecurityScope,
  ): ResolvedContextSubjectScope {
    const kind = request.subjectScope ?? (request.subject ? 'external_entity' : 'general');
    const source: ResolvedContextSubjectScope['source'] = request.subjectScope
      ? 'explicit'
      : request.subject
        ? 'explicit_subject_input'
        : 'default_general';

    if (kind === 'client') {
      const clientId = request.clientId?.trim();
      if (!clientId) {
        throw new BadRequestException('clientId is required for subjectScope=client.');
      }
      if (!securityScope.authorizedClientIds.includes(clientId)) {
        throw new ForbiddenException('Client subject is outside the explicit SecurityScope.');
      }
      return { kind, source, clientIds: [clientId] };
    }

    if (kind === 'portfolio') {
      if (securityScope.authorizedClientIds.length === 0) {
        throw new ForbiddenException('Portfolio subject requires at least one authorized client.');
      }
      return {
        kind,
        source,
        clientIds: [...securityScope.authorizedClientIds],
      };
    }

    if (kind === 'external_entity' && !request.subject) {
      const canonicalFocus = request.focusEntityRefs?.some(
        (ref) => ref.type === 'canonical_entity' && !!ref.id?.trim(),
      );
      if (!canonicalFocus) {
        throw new BadRequestException(
          'External-entity subject requires identity input or an explicit canonical focus reference.',
        );
      }
    }

    return { kind, source, clientIds: [] };
  }

  private normalizeFocusEntityRefs(
    request: ContextResolutionRequest,
    securityScope: NormalizedContextSecurityScope,
    subjectScope: ResolvedContextSubjectScope,
  ): KnowledgeRef[] {
    const refs = (request.focusEntityRefs ?? []).map(normalizeRef);
    if (request.includeCurrentObjectAsFocus && request.currentObject) {
      refs.push(normalizeRef(request.currentObject));
    }
    if (subjectScope.kind === 'client') {
      refs.push({ type: 'client', id: subjectScope.clientIds[0]! });
    }

    for (const ref of refs) {
      if (ref.type === 'client' && !securityScope.authorizedClientIds.includes(ref.id)) {
        throw new ForbiddenException('Client focus entity is outside the explicit SecurityScope.');
      }
    }
    return dedupeRefs(refs);
  }

  private async resolveExternalSubject(
    request: ContextResolutionRequest,
    allowExternalLookup: boolean,
  ): Promise<ContextResolvedEntity> {
    const input = this.normalizeSubjectInput(request.subject);
    try {
      const resolved = await this.entityResolver.resolveAcrossSources(request.tenantId.trim(), {
        query: input.query,
        actorUserId: request.actorUserId.trim(),
        entityTypeHint: input.entityTypeHint ?? null,
        identifiers: input.identifiers,
        maxCandidates: input.maxCandidates,
        allowExternalLookup,
        // Phase 15 resolves scope; it never auto-registers a public entity.
        allowAuthoritativePublicRegistration: false,
      });
      return mapResolvedEntity(resolved);
    } catch {
      return {
        status: 'error',
        confidence: 0,
        resolutionMethod: 'resolver_execution_failed',
        publicLookupRan: false,
        stopReason: 'entity_resolution_failed',
        candidates: [],
      };
    }
  }

  private normalizeSubjectInput(
    subject: ContextEntitySubjectInput | undefined,
  ): Required<Pick<ContextEntitySubjectInput, 'query' | 'identifiers' | 'maxCandidates'>> &
    Pick<ContextEntitySubjectInput, 'entityTypeHint'> {
    if (!subject) {
      throw new BadRequestException('External-entity subject input is required.');
    }
    const identifiers = (subject.identifiers ?? [])
      .map((identifier) => ({
        type: identifier.type.trim(),
        value: identifier.value.trim(),
      }))
      .filter((identifier) => identifier.type && identifier.value);
    const query = subject.query?.trim() || identifiers[0]?.value || '';
    if (!query) {
      throw new BadRequestException('External-entity subject requires a query or identifier.');
    }
    return {
      query,
      identifiers,
      maxCandidates: Math.min(Math.max(subject.maxCandidates ?? 25, 1), 100),
      ...(subject.entityTypeHint?.trim() ? { entityTypeHint: subject.entityTypeHint.trim() } : {}),
    };
  }

  private buildRetrievalRequest(
    request: ContextResolutionRequest,
    securityScope: NormalizedContextSecurityScope,
    subjectScope: ResolvedContextSubjectScope,
    canonicalEntityIds: string[],
    currentObjectUsedAsFocus: boolean,
  ): RetrievalRequest {
    const directive = request.retrieval!;
    const requestedDomains = [...new Set(directive.requestedDomains)];
    const clientAuthorizationWasSpecified = request.securityScope.authorizedClientIds !== undefined;
    const mailboxAuthorizationWasSpecified =
      request.securityScope.authorizedMailboxConnectionIds !== undefined;

    // Preserve an explicit empty mailbox envelope below. The canonical mail
    // adapter denies that source before any mailbox/message read and reports
    // its coverage, allowing other authorized domains in this request to run.

    // Phase 11 exact client lookup predates the separate SecurityScope field.
    // Preserve fail-closed behavior until that rail consumes the new envelope
    // directly by passing the explicit envelope as its effective client subset.
    const exactClientCompatibilityScope =
      !!directive.exactLexical &&
      requestedDomains.includes('clients') &&
      subjectScope.clientIds.length === 0 &&
      clientAuthorizationWasSpecified;
    if (exactClientCompatibilityScope && securityScope.authorizedClientIds.length === 0) {
      throw new ForbiddenException('Exact client retrieval has no authorized client scope.');
    }
    const effectiveClientIds =
      subjectScope.clientIds.length > 0
        ? subjectScope.clientIds
        : exactClientCompatibilityScope
          ? securityScope.authorizedClientIds
          : [];

    const caller: RetrievalCallerContext = {
      tenantId: securityScope.tenantId,
      userId: securityScope.actorUserId,
      ...(clientAuthorizationWasSpecified
        ? { authorizedClientIds: securityScope.authorizedClientIds }
        : {}),
      ...(effectiveClientIds.length > 0 ? { clientIds: effectiveClientIds } : {}),
      ...(mailboxAuthorizationWasSpecified
        ? {
            authorizedMailboxConnectionIds: securityScope.authorizedMailboxConnectionIds,
          }
        : {}),
      ...(securityScope.graphPartitions.length > 0
        ? { graphPartitions: securityScope.graphPartitions }
        : {}),
    };

    return {
      queryClass: directive.queryClass,
      ...(directive.mondayBoardContext ? { mondayBoardContext: directive.mondayBoardContext } : {}),
      ...(directive.meetingBriefing ? { meetingBriefing: directive.meetingBriefing } : {}),
      ...(directive.deadlineAt ? { deadlineAt: directive.deadlineAt } : {}),
      requestedDomains,
      caller,
      query: directive.query === null ? undefined : directive.query?.trim() || request.task.trim(),
      ...(directive.exactLexical ? { exactLexical: directive.exactLexical } : {}),
      ...(directive.memoryItemId ? { memoryItemId: directive.memoryItemId } : {}),
      ...(directive.hearingFilters ? { hearingFilters: directive.hearingFilters } : {}),
      ...(canonicalEntityIds.length > 0 ? { canonicalEntityIds } : {}),
      ...((directive.asOf ?? request.asOf) ? { asOf: directive.asOf ?? request.asOf } : {}),
      ...(directive.windowStart ? { windowStart: directive.windowStart } : {}),
      ...(directive.windowEnd ? { windowEnd: directive.windowEnd } : {}),
      ...(directive.observedThrough ? { observedThrough: directive.observedThrough } : {}),
      ...(directive.edgeTypes ? { edgeTypes: directive.edgeTypes } : {}),
      ...(directive.pageSize !== undefined ? { pageSize: directive.pageSize } : {}),
      ...(directive.cursors ? { cursors: directive.cursors } : {}),
      ...(directive.requireComplete !== undefined
        ? { requireComplete: directive.requireComplete }
        : {}),
      metadata: {
        contextResolver: {
          version: RESOLVER_VERSION,
          surface: request.surface,
          subjectScope: subjectScope.kind,
          subjectScopeSource: subjectScope.source,
          uiClientSelected: !!request.clientId,
          uiClientUsedAsSubject: subjectScope.kind === 'client',
          currentObjectUsedAsFocus,
          canonicalEntityCount: canonicalEntityIds.length,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        },
      },
    };
  }

  private result(input: {
    request: ContextResolutionRequest;
    securityScope: NormalizedContextSecurityScope;
    subjectScope: ResolvedContextSubjectScope;
    subjectEntity?: ContextResolvedEntity;
    focusEntityRefs: KnowledgeRef[];
    canonicalEntityIds?: string[];
    retrievalRequest?: RetrievalRequest;
    status: ContextResolutionResult['status'];
    stopReason: string;
    externalLookupPermitted: boolean;
    currentObjectUsedAsFocus: boolean;
  }): ContextResolutionResult {
    const uiClientId = input.request.clientId?.trim() || undefined;
    const canonicalEntityIds =
      input.canonicalEntityIds ??
      uniqueStrings(
        input.focusEntityRefs.filter((ref) => ref.type === 'canonical_entity').map((ref) => ref.id),
      );
    const retrievalAllowed = input.status === 'ready' && !!input.retrievalRequest;
    return {
      status: input.status,
      stopReason: input.stopReason,
      securityScope: input.securityScope,
      subjectScope: input.subjectScope,
      ...(input.subjectEntity ? { subjectEntity: input.subjectEntity } : {}),
      focusEntityRefs: dedupeRefs(input.focusEntityRefs),
      canonicalEntityIds,
      uiContext: {
        ...(uiClientId ? { clientId: uiClientId } : {}),
        ...(input.request.currentObject
          ? { currentObject: { ...input.request.currentObject } }
          : {}),
      },
      ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
      ...(input.request.asOf ? { asOf: input.request.asOf } : {}),
      ...(input.request.maxTokens !== undefined ? { maxTokens: input.request.maxTokens } : {}),
      retrievalAllowed,
      ...(input.retrievalRequest ? { retrievalRequest: input.retrievalRequest } : {}),
      trace: {
        resolverVersion: RESOLVER_VERSION,
        uiClientSelected: !!uiClientId,
        uiClientWithinSecurityEnvelope:
          !!uiClientId && input.securityScope.authorizedClientIds.includes(uiClientId),
        uiClientUsedAsSubject: input.subjectScope.kind === 'client',
        currentObjectSelected: !!input.request.currentObject,
        currentObjectUsedAsFocus: input.currentObjectUsedAsFocus,
        externalLookupPermitted: input.externalLookupPermitted,
        externalLookupRan: input.subjectEntity?.publicLookupRan ?? false,
        retrievalPlanned: !!input.retrievalRequest,
      },
    };
  }
}

function mapResolvedEntity(
  result: UniversalEntityResolutionOrchestrationResult,
): ContextResolvedEntity {
  const candidates = result.candidates.map((candidate) => ({
    canonicalEntityId: candidate.entityId,
    canonicalName: candidate.canonicalName,
    entityType: candidate.entityType,
    confidence: candidate.confidence,
    sourceType: candidate.sourceType,
  }));
  if (result.status === 'resolved' && result.entity) {
    return {
      status: 'resolved',
      canonicalEntityId: result.entity.id,
      canonicalName: result.entity.canonicalName,
      entityType: result.entity.entityType,
      confidence: result.confidence,
      resolutionMethod: result.resolutionMethod,
      publicLookupRan: result.publicLookupRan,
      stopReason: result.stopReason,
      candidates,
    };
  }
  if (result.status === 'resolved') {
    return {
      status: 'error',
      confidence: result.confidence,
      resolutionMethod: result.resolutionMethod,
      publicLookupRan: result.publicLookupRan,
      stopReason: 'resolved_entity_missing_canonical_id',
      candidates,
    };
  }
  return {
    status: result.status,
    confidence: result.confidence,
    resolutionMethod: result.resolutionMethod,
    publicLookupRan: result.publicLookupRan,
    stopReason: result.stopReason,
    candidates,
  };
}

function normalizeRef(ref: KnowledgeRef | { type: string; id: string }): KnowledgeRef {
  const type = ref.type?.trim();
  const id = ref.id?.trim();
  if (!type || !id) {
    throw new BadRequestException('Focus entity references require type and id.');
  }
  return {
    type,
    id,
    ...('label' in ref && ref.label ? { label: ref.label } : {}),
    ...('metadata' in ref && ref.metadata ? { metadata: ref.metadata } : {}),
  };
}

function dedupeRefs(refs: readonly KnowledgeRef[]): KnowledgeRef[] {
  const seen = new Set<string>();
  const out: KnowledgeRef[] = [];
  for (const ref of refs) {
    const normalized = normalizeRef(ref);
    const key = `${normalized.type}\u0000${normalized.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
