import { governedRun } from './profile-extraction-context.js';
import type { TenantContext } from '@capiro/shared';
import { buildInstitutionalContextControlProjection } from '@capiro/meriv2-core';
import { ClientPeopleService } from './client-people.service.js';
import type {
  FillEvidence,
} from './client-profile-fill.helpers.js';
import {
  buildModelContextBlock,
  projectClientProfileContactCandidates,
  type ClientProfileFillGovernedContext,
} from './client-profile-fill-context-plane.service.js';
import {
  ClientProfileFillRelationshipHistoryService,
} from './client-profile-fill-relationship-history.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import type { CrmFillEvaluationRunner, CrmFillExtractionLike } from './crm-fill-evaluation.runner.js';

export const RAW_CLIENT_PROFILE_FILL_SERVICE = Symbol('RAW_CLIENT_PROFILE_FILL_SERVICE');

interface ClientProfileFillInternals {
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
      kind: 'person' | 'relationship_link';
      targetKey: string;
      source: string;
      factKind: 'fact';
      currentValue: unknown;
      proposedValue: unknown;
      confidence: number;
      evidence: FillEvidence[];
    },
  ) => Promise<boolean>;
  // Phase 27F: the two source-extraction methods a control-arm evaluation
  // replay re-invokes a second time, under a control governed bundle.
  extractPublicWeb: (
    ctx: TenantContext,
    client: unknown,
    homepage: unknown,
    results: unknown,
    pageCorpus: unknown,
    ...scope: unknown[]
  ) => Promise<CrmFillExtractionLike | null>;
  extractCapabilitiesFromDocument: (
    ctx: TenantContext,
    client: unknown,
    documentText: string,
    ...scope: unknown[]
  ) => Promise<CrmFillExtractionLike['capabilities']>;
}


/**
 * Read the governed bundle resolved by the durable worker for this task — so a control-arm evaluation replay can build its
 * institutional-context-withheld variant of it without a second Context
 * Plane resolution (§18: freeze the evaluation input).
 */
export function getGovernedCrmFillBundle(): ClientProfileFillGovernedContext | null {
  return governedRun.getStore() ?? null;
}

/**
 * Phase 27F: run a callback under a DIFFERENT (control) governed bundle,
 * reusing the exact same AsyncLocalStorage-scoped injection the real path
 * uses for the SDK extraction boundary — so re-invoking a private
 * extraction method a second time picks up the control
 * `modelContextBlock` automatically, with no second injection mechanism.
 */
export function runWithGovernedCrmFillBundle<T>(
  bundle: ClientProfileFillGovernedContext,
  fn: () => Promise<T>,
): Promise<T> {
  return governedRun.run(bundle, fn);
}

/** Adapt active source extraction and contact review to the worker's governed context. */
export function createGovernedClientProfileFillService(
  service: ClientProfileFillService,
  people: ClientPeopleService,
  // Phase 27F — optional, same contract as learningSignals/qualityTelemetry
  // elsewhere in this program: absent means no evaluation is ever attempted,
  // no other behavior change to the active extraction/persistence path.
  evaluation?: CrmFillEvaluationRunner,
  relationshipHistory?: ClientProfileFillRelationshipHistoryService,
): ClientProfileFillService {
  const internal = service as unknown as ClientProfileFillInternals;
  // Bind the active extraction seams used by the durable worker and evaluation.
  const originalExtractPublicWeb = internal.extractPublicWeb?.bind(service);
  const originalExtractCapabilitiesFromDocument = internal.extractCapabilitiesFromDocument?.bind(service);

  // Retire the legacy direct engagementContact/domain lookup from the live
  // synced-email source. Candidates now come only from authorized Retrieval V2
  // contact records in the one run bundle and still become reviewable findings.
  // Phase 4 then reuses the same task to propose authoritative meeting/thread
  // associations for the Relationships history projection.
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

    if (relationshipHistory) {
      count += await relationshipHistory.gather(
        ctx,
        clientId,
        runId,
        [...existingPeople, ...candidates],
        (tenantId, findingClientId, findingRunId, input) =>
          internal.addFinding(tenantId, findingClientId, findingRunId, input),
      );
    }
    return count;
  };

  // Phase 27F: fire-and-forget shadow evaluation for each source-extraction
  // call. Started here (not from a later worker) because the evidence these
  // methods close over (homepage/results/pageCorpus/documentText) is
  // ephemeral and must never be persisted. The control replay re-invokes
  // the SAME private extraction method a second time, under a control
  // governed bundle — never `addFinding`, so it can never write a CRM row.
  // Wiring is skipped entirely for a `service` that doesn't implement these
  // (see the defensive `?.bind` above).
  if (originalExtractPublicWeb) internal.extractPublicWeb = async (ctx, client, homepage, results, pageCorpus, ...scope) => {
    const extraction = await originalExtractPublicWeb(ctx, client, homepage, results, pageCorpus, ...scope);
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
              originalExtractPublicWeb(ctx, client, homepage, results, pageCorpus, ...scope),
            ),
        })
        .catch(() => undefined);
    }
    return extraction;
  };

  if (originalExtractCapabilitiesFromDocument) internal.extractCapabilitiesFromDocument = async (ctx, client, documentText, ...scope) => {
    const capabilities = await originalExtractCapabilitiesFromDocument(ctx, client, documentText, ...scope);
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
              originalExtractCapabilitiesFromDocument(ctx, client, documentText, ...scope),
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
