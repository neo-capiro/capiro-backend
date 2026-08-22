import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import {
  EVALUATION_CONFIG_VERSION,
  computeEvaluationSamplingKey,
  decideEvaluationEligibility,
  evaluationEnabled,
  evaluationSampleRate,
  shouldSampleForEvaluation,
} from '@capiro/meriv2-core';
import { EvaluationCaptureService } from '../evaluation/evaluation-capture.service.js';

/** Structural shape only — avoids exporting `PublicWebExtraction` out of client-profile-fill.service.ts just for this. */
export interface CrmFillExtractionLike {
  readonly people?: ReadonlyArray<{ name: string }>;
  readonly facilities?: ReadonlyArray<{ name: string }>;
  readonly capabilities?: ReadonlyArray<{ name: string }>;
}

export interface CrmFillEvaluationInput {
  readonly clientId: string;
  readonly source: 'public_web' | 'capability_document';
  readonly contextPacketId: string | null;
  /** How many institutional-layer items the treatment's governed bundle carried. */
  readonly institutionalItemCount: number;
  readonly treatmentExtraction: CrmFillExtractionLike | null;
  /**
   * Re-invokes the SAME private extraction method a second time under a
   * control (institutional-context-withheld) governed bundle. Returns null
   * when there is no governed bundle to project (should not happen for an
   * eligible request, but defensive).
   */
  readonly replay: () => Promise<CrmFillExtractionLike | null>;
}

/**
 * Phase 27F — the CRM Fill shadow-evaluation runner.
 *
 * CRM Fill has no per-finding ContextPacket: one packet backs a whole
 * multi-source run (`crm-fill-finding.telemetry-adapter.ts`'s own doc
 * comment). The natural evaluation unit here is therefore one
 * SOURCE-EXTRACTION CALL within a run — `extractPublicWeb` /
 * `extractCapabilitiesFromDocument` — not one finding.
 *
 * Reuses the exact extraction methods already on `ClientProfileFillService`
 * (invoked a second time by the caller's `replay()` closure, under a
 * control-projected governed bundle) — no second extraction implementation.
 * Never calls `addFinding`: the control extraction's candidates are
 * compared and hashed here, then discarded — never written to
 * `client_profile_fill_finding` or any other CRM table (§10/§42: never
 * mutate CRM for testing).
 */
@Injectable()
export class CrmFillEvaluationRunner {
  private readonly logger = new Logger(CrmFillEvaluationRunner.name);

  constructor(private readonly evaluation: EvaluationCaptureService) {}

  async considerAndRun(ctx: TenantContext, artifactId: string, input: CrmFillEvaluationInput): Promise<void> {
    if (!evaluationEnabled(process.env.LEARNING_EVALUATION)) return;
    if (!input.treatmentExtraction) return;

    const eligibility = decideEvaluationEligibility({
      enabled: true,
      contextPacketId: input.contextPacketId,
      institutionalItemCount: input.institutionalItemCount,
      // The treatment run's governed bundle is still held (AsyncLocalStorage
      // scope) at the moment this runs — nothing further needs fetching.
      authoritativeInputReplayable: true,
      operationSupported: true,
      providerAvailable: true,
      withinBudget: true,
    });

    const samplingKey = computeEvaluationSamplingKey({
      tenantId: ctx.tenantId,
      operation: 'crm_fill.extraction.generate',
      artifactId,
    });
    const observedAt = new Date();
    const common = {
      tenantId: ctx.tenantId,
      clientId: input.clientId,
      surface: 'crm_fill' as const,
      operation: 'crm_fill.extraction.generate',
      evaluationType: 'institutional_context_ablation' as const,
      contextPacketId: input.contextPacketId,
      treatmentArtifactType: 'crm_fill_extraction',
      treatmentArtifactId: artifactId,
      samplingKey,
      configVersion: EVALUATION_CONFIG_VERSION,
      observedAt,
    };

    if (!eligibility.eligible) {
      await this.evaluation.recordDecision({ ...common, status: 'skipped', skipReason: eligibility.reason });
      return;
    }

    const rate = evaluationSampleRate(process.env.LEARNING_EVALUATION_SAMPLE_RATE);
    if (!shouldSampleForEvaluation(samplingKey, rate)) {
      await this.evaluation.recordDecision({ ...common, status: 'skipped', skipReason: 'not_sampled' });
      return;
    }

    const treatmentOutputHash = hashJson(input.treatmentExtraction);
    const recorded = await this.evaluation.recordDecision({
      ...common,
      status: 'pending',
      treatmentOutputHash,
    });
    if (recorded.status !== 'recorded') return;

    await this.evaluation.markRunning(ctx.tenantId, recorded.id);
    try {
      const controlExtraction = await input.replay();
      const controlOutputHash = controlExtraction ? hashJson(controlExtraction) : null;
      const overlap = nameOverlap(input.treatmentExtraction, controlExtraction);
      await this.evaluation.markCompleted(ctx.tenantId, recorded.id, {
        treatmentOutputHash,
        controlOutputHash,
        controlProjectionPolicy: 'withhold_all_institutional_layers',
        metrics: {
          controlProducedOutput: controlExtraction !== null,
          treatmentProposedCount: proposedCount(input.treatmentExtraction),
          controlProposedCount: controlExtraction ? proposedCount(controlExtraction) : null,
          findingOverlapRate: overlap,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`CrmFillEvaluationRunner control replay failed: ${reason}`);
      await this.evaluation.markFailed(ctx.tenantId, recorded.id, reason.slice(0, 160));
    }
  }
}

function proposedCount(extraction: CrmFillExtractionLike): number {
  return (extraction.people?.length ?? 0) + (extraction.facilities?.length ?? 0) + (extraction.capabilities?.length ?? 0);
}

function names(extraction: CrmFillExtractionLike | null): Set<string> {
  if (!extraction) return new Set();
  const all = [
    ...(extraction.people ?? []),
    ...(extraction.facilities ?? []),
    ...(extraction.capabilities ?? []),
  ];
  return new Set(all.map((item) => item.name.trim().toLowerCase()).filter(Boolean));
}

/** |treatment ∩ control| / |treatment ∪ control| over proposed candidate names — null when both sides are empty. */
function nameOverlap(treatment: CrmFillExtractionLike, control: CrmFillExtractionLike | null): number | null {
  const a = names(treatment);
  const b = names(control);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return null;
  let intersection = 0;
  for (const name of a) if (b.has(name)) intersection += 1;
  return intersection / union.size;
}

/** Identity/comparison only — the extraction body itself is never persisted (§25). */
function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
