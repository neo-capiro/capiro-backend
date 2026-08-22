import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { buildInstitutionalContextControlProjection } from '@capiro/meriv2-core';
import { ClientPeopleService } from './client-people.service.js';
import type {
  ClientProfileFillSource,
  FillEvidence,
} from './client-profile-fill.helpers.js';
import {
  ClientProfileFillContextPlaneService,
  buildModelContextBlock,
  projectClientProfileContactCandidates,
  type ClientProfileFillGovernedContext,
} from './client-profile-fill-context-plane.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import type { CrmFillEvaluationRunner, CrmFillExtractionLike } from './crm-fill-evaluation.runner.js';

export const RAW_CLIENT_PROFILE_FILL_SERVICE = Symbol('RAW_CLIENT_PROFILE_FILL_SERVICE');

interface ClientProfileFillInternals {
  startRun: ClientProfileFillService['startRun'];
  executeRun: (
    ctx: TenantContext,
    clientId: string,
    runId: string,
    sources: ClientProfileFillSource[],
  ) => Promise<void>;
  executeCapabilityDocumentRun: (
    ctx: TenantContext,
    clientId: string,
    runId: string,
    attachmentId: string,
  ) => Promise<void>;
  gatherSyncedEmail: (
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ) => Promise<number>;
  addFinding: (
    tenantId: string,
    clientId: string,
    runId: string,
    input: {
      kind: 'person';
      targetKey: string;
      source: string;
      factKind: 'fact';
      currentValue: unknown;
      proposedValue: unknown;
      confidence: number;
      evidence: FillEvidence[];
    },
  ) => Promise<boolean>;
  callOpenAiJson: (
    apiKey: string,
    model: string,
    system: string,
    prompt: string,
    schema: Record<string, unknown>,
  ) => Promise<string>;
  callAnthropicJson: (
    apiKey: string,
    model: string,
    system: string,
    prompt: string,
    schema: Record<string, unknown>,
  ) => Promise<string>;
  // Phase 27F: the two source-extraction methods a control-arm evaluation
  // replay re-invokes a second time, under a control governed bundle.
  extractPublicWeb: (
    ctx: TenantContext,
    client: unknown,
    homepage: unknown,
    results: unknown,
    pageCorpus: unknown,
  ) => Promise<CrmFillExtractionLike | null>;
  extractCapabilitiesFromDocument: (
    ctx: TenantContext,
    client: unknown,
    documentText: string,
  ) => Promise<CrmFillExtractionLike['capabilities']>;
}

const governedRun = new AsyncLocalStorage<ClientProfileFillGovernedContext>();

/**
 * Phase 27F read access to the SAME governed bundle `startRun` already
 * stored for this run — so a control-arm evaluation replay can build its
 * institutional-context-withheld variant of it without a second Context
 * Plane resolution (§18: freeze the evaluation input).
 */
export function getGovernedCrmFillBundle(): ClientProfileFillGovernedContext | null {
  return governedRun.getStore() ?? null;
}

/**
 * Phase 27F: run a callback under a DIFFERENT (control) governed bundle,
 * reusing the exact same AsyncLocalStorage-scoped injection the real path
 * uses for `callOpenAiJson`/`callAnthropicJson` — so re-invoking a private
 * extraction method a second time picks up the control
 * `modelContextBlock` automatically, with no second injection mechanism.
 */
export function runWithGovernedCrmFillBundle<T>(
  bundle: ClientProfileFillGovernedContext,
  fn: () => Promise<T>,
): Promise<T> {
  return governedRun.run(bundle, fn);
}

/**
 * Production wrapper for Phase 23.
 *
 * The mature Fill with Meri source/evidence/review/apply pipeline remains in
 * ClientProfileFillService. This wrapper replaces only its context acquisition
 * and model-preflight seams, ensuring every newly started enrichment run first
 * crosses the shared Context Plane and reuses that one bundle throughout its
 * detached execution.
 */
export function createGovernedClientProfileFillService(
  service: ClientProfileFillService,
  contextPlane: ClientProfileFillContextPlaneService,
  people: ClientPeopleService,
  // Phase 27F — optional, same contract as learningSignals/qualityTelemetry
  // elsewhere in this program: absent means no evaluation is ever attempted,
  // no other behavior change to Fill with Meri's real extraction/persist path.
  evaluation?: CrmFillEvaluationRunner,
): ClientProfileFillService {
  const internal = service as unknown as ClientProfileFillInternals;
  const originalStart = service.startRun.bind(service);
  const originalExecuteRun = internal.executeRun.bind(service);
  const originalExecuteDocumentRun = internal.executeCapabilityDocumentRun.bind(service);
  const originalOpenAi = internal.callOpenAiJson.bind(service);
  const originalAnthropic = internal.callAnthropicJson.bind(service);
  // Phase 27F seams. Bound defensively (unlike the seams above, which this
  // wrapper has always required) so an existing minimal test double for
  // `service` that predates this phase — one that fakes only startRun/
  // executeRun/callOpenAiJson/callAnthropicJson — keeps constructing this
  // wrapper without also having to fake extraction.
  const originalExtractPublicWeb = internal.extractPublicWeb?.bind(service);
  const originalExtractCapabilitiesFromDocument = internal.extractCapabilitiesFromDocument?.bind(service);

  internal.startRun = (async (
    ctx: TenantContext,
    clientId: string,
    requestedSources?: ClientProfileFillSource[],
    attachmentId?: string,
    seedWebsite?: string | null,
  ) => {
    // Keep request-shape validation ahead of packet persistence/audit. The raw
    // service repeats this check as defense in depth.
    if (attachmentId && requestedSources?.length) {
      throw new BadRequestException(
        'Choose either a capability document or connected enrichment sources',
      );
    }
    if (attachmentId && seedWebsite?.trim()) {
      throw new BadRequestException('Website seed applies only to connected enrichment sources');
    }
    // The packet is resolved before the durable run row or any provider call.
    const bundle = await contextPlane.resolve(ctx, {
      clientId,
      requestedSources,
      attachmentId: attachmentId ?? null,
    });
    return governedRun.run(bundle, () =>
      originalStart(ctx, clientId, requestedSources, attachmentId, seedWebsite),
    );
  }) as ClientProfileFillService['startRun'];

  internal.executeRun = async (ctx, clientId, runId, sources) => {
    const bundle = requireGovernedBundle(clientId);
    try {
      await contextPlane.recordRunContext(ctx, runId, bundle);
      await originalExecuteRun(ctx, clientId, runId, sources);
    } catch (error) {
      await contextPlane.failRun(ctx, clientId, runId, error).catch(() => undefined);
      throw error;
    }
  };

  internal.executeCapabilityDocumentRun = async (ctx, clientId, runId, attachmentId) => {
    const bundle = requireGovernedBundle(clientId);
    try {
      await contextPlane.recordRunContext(ctx, runId, bundle);
      await originalExecuteDocumentRun(ctx, clientId, runId, attachmentId);
    } catch (error) {
      await contextPlane.failRun(ctx, clientId, runId, error).catch(() => undefined);
      throw error;
    }
  };

  // Retire the legacy direct engagementContact/domain lookup from the live
  // synced-email source. Candidates now come only from authorized Retrieval V2
  // contact records in the one run bundle and still become reviewable findings.
  internal.gatherSyncedEmail = async (ctx, clientId, runId) => {
    const bundle = requireGovernedBundle(clientId);
    const candidates = projectClientProfileContactCandidates(bundle);
    const existingPeople = await people.listPeople(ctx, clientId);
    const emails = new Set(
      existingPeople
        .map((person) => person.email?.trim().toLowerCase())
        .filter((value): value is string => !!value),
    );
    const names = new Set(
      existingPeople
        .map((person) => person.name.trim().toLowerCase().replace(/\s+/g, ' '))
        .filter(Boolean),
    );

    let count = 0;
    for (const candidate of candidates) {
      const normalizedName = candidate.name.trim().toLowerCase().replace(/\s+/g, ' ');
      const normalizedEmail = candidate.email?.trim().toLowerCase() ?? null;
      if (normalizedEmail && emails.has(normalizedEmail)) continue;
      if (names.has(normalizedName)) continue;
      const inserted = await internal.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'person',
        targetKey: `person:${normalizedEmail ?? normalizedName}`,
        source: 'synced_email',
        factKind: 'fact',
        currentValue: null,
        proposedValue: {
          name: candidate.name,
          title: candidate.title,
          email: candidate.email,
          phone: candidate.phone,
          role: 'client_contact',
          notes: null,
        },
        confidence: 0.97,
        evidence: [
          {
            label: 'Governed synced contact explicitly linked to this client',
            source: 'Context Plane contacts',
            metadata: {
              packetId: bundle.packetId,
              recordId: candidate.recordId,
              organization: candidate.organization,
              originalSource: candidate.source,
              association: 'explicit_client_link',
              provenance: candidate.provenance,
            },
          },
        ],
      });
      if (inserted) count += 1;
    }
    return count;
  };

  // All model-assisted extraction receives the canonical CRM identity and
  // governed steering/coverage block. The block is explicitly non-evidentiary;
  // existing URL/document evidence checks still decide which proposals survive.
  internal.callOpenAiJson = async (apiKey, model, system, prompt, schema) => {
    const bundle = requireGovernedBundle();
    return originalOpenAi(
      apiKey,
      model,
      governedSystem(system),
      `${bundle.modelContextBlock}\n\n${prompt}`,
      schema,
    );
  };

  internal.callAnthropicJson = async (apiKey, model, system, prompt, schema) => {
    const bundle = requireGovernedBundle();
    return originalAnthropic(
      apiKey,
      model,
      governedSystem(system),
      `${bundle.modelContextBlock}\n\n${prompt}`,
      schema,
    );
  };

  // Phase 27F: fire-and-forget shadow evaluation for each source-extraction
  // call. Started here (not from a later worker) because the evidence these
  // methods close over (homepage/results/pageCorpus/documentText) is
  // ephemeral and must never be persisted. The control replay re-invokes
  // the SAME private extraction method a second time, under a control
  // governed bundle — never `addFinding`, so it can never write a CRM row.
  // Wiring is skipped entirely for a `service` that doesn't implement these
  // (see the defensive `?.bind` above).
  if (originalExtractPublicWeb) internal.extractPublicWeb = async (ctx, client, homepage, results, pageCorpus) => {
    const extraction = await originalExtractPublicWeb(ctx, client, homepage, results, pageCorpus);
    const bundle = governedRun.getStore();
    if (extraction && bundle && evaluation) {
      void evaluation
        .considerAndRun(ctx, `${bundle.packetId ?? 'unpersisted'}:public_web`, {
          clientId: bundle.canonicalClient.id,
          source: 'public_web',
          contextPacketId: bundle.packetId,
          institutionalItemCount: countInstitutionalItems(bundle.packet),
          treatmentExtraction: extraction,
          replay: () =>
            governedRun.run(controlBundle(bundle), () =>
              originalExtractPublicWeb(ctx, client, homepage, results, pageCorpus),
            ),
        })
        .catch(() => undefined);
    }
    return extraction;
  };

  if (originalExtractCapabilitiesFromDocument) internal.extractCapabilitiesFromDocument = async (ctx, client, documentText) => {
    const capabilities = await originalExtractCapabilitiesFromDocument(ctx, client, documentText);
    const bundle = governedRun.getStore();
    if (capabilities?.length && bundle && evaluation) {
      void evaluation
        .considerAndRun(ctx, `${bundle.packetId ?? 'unpersisted'}:capability_document`, {
          clientId: bundle.canonicalClient.id,
          source: 'capability_document',
          contextPacketId: bundle.packetId,
          institutionalItemCount: countInstitutionalItems(bundle.packet),
          treatmentExtraction: { capabilities },
          replay: async () => ({
            capabilities: await governedRun.run(controlBundle(bundle), () =>
              originalExtractCapabilitiesFromDocument(ctx, client, documentText),
            ),
          }),
        })
        .catch(() => undefined);
    }
    return capabilities;
  };

  return service;
}

/** Structural item count — every packet item is layer-tagged (no non-institutional item exists in `items`). */
function countInstitutionalItems(packet: unknown): number {
  const items = (packet as { items?: unknown })?.items;
  return Array.isArray(items) ? items.length : 0;
}

/**
 * A control variant of an already-resolved governed bundle: the five
 * institutional SteeringLayers withheld from a COPY of its packet, with a
 * correspondingly rebuilt `modelContextBlock` (§32 — the original bundle,
 * and the real ContextPacket it references, are never mutated).
 */
function controlBundle(bundle: ClientProfileFillGovernedContext): ClientProfileFillGovernedContext {
  const controlPacket = buildInstitutionalContextControlProjection(
    bundle.packet as { items?: unknown; rendered?: unknown; exclusions?: unknown },
  ) as unknown as ClientProfileFillGovernedContext['packet'];
  return {
    ...bundle,
    packet: controlPacket,
    modelContextBlock: buildModelContextBlock({
      client: bundle.canonicalClient,
      packet: controlPacket,
      coverage: bundle.coverage,
      kind: bundle.kind,
    }),
  };
}

function requireGovernedBundle(clientId?: string): ClientProfileFillGovernedContext {
  const bundle = governedRun.getStore();
  if (!bundle) throw new Error('phase23_crm_context_plane_bundle_required');
  if (clientId && bundle.canonicalClient.id !== clientId) {
    throw new Error('phase23_crm_context_plane_client_mismatch');
  }
  return bundle;
}

function governedSystem(system: string): string {
  return [
    system,
    'A governed Capiro CRM context block precedes the user payload.',
    'That block is PRIVATE CONTEXT for exact-client disambiguation, duplicate avoidance, approved positioning, and overwrite prevention only.',
    'It is not evidence. Never copy a value from that block into an enrichment proposal unless the selected public source or server-owned client document independently supports the same value.',
  ].join(' ');
}
