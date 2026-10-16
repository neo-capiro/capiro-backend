import type { Prisma } from '../../generated/prisma-client/index.js';
import type { DraftJobInput, DraftJobRuntime } from './draft-job.types.js';
import { admitObjective } from './objective-generation-admission.js';
import { lockObjectiveSources, readObjectiveSources } from './objective-generation-sources.js';
import { digest, SAFE_FAILURES, type ObjectiveAdmission } from './objective-generation.types.js';
import type { StrategyContextPlaneClient } from './strategy-context-plane.client.js';
import { generationAssociation, generationMarker, recordCanonicalGenerationProducer } from './objective-canonical-producer-ledger.js';
import { requireCanonicalGenerationEffectWithinTx } from './objective-canonical-generation-fence.js';

export interface ObjectiveClaim {
  id: string;
  tenantId: string;
  ownerUserId: string;
  claimToken: string;
  attempt: number;
  input: DraftJobInput;
}
export class ObjectiveLeaseLost extends Error {}
export function objectivePersistence(
  job: ObjectiveClaim,
  contextPlane: StrategyContextPlaneClient,
  admission: () => ObjectiveAdmission | undefined,
): NonNullable<DraftJobRuntime['persistence']> {
  let lockedInput: DraftJobInput | undefined;
  const envelope = job.input.objectiveGeneration!;
  return {
    beforeTransaction: async () => {
      const compiled = admission();
      if (!compiled) throw new Error('Objective context not compiled');
      envelope.historyCheckedAt = await contextPlane.recheckObjective(
        {
          tenantId: job.tenantId,
          clerkUserId: job.ownerUserId,
          clientId: envelope.request.clientId,
          mode: 'draft',
          objective: envelope.request.objective,
          generationRequestId: envelope.request.requestId,
          generationType: envelope.request.type,
        },
        compiled,
      );
    },
    beforeWrite: async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ input: DraftJobInput; ownerUserId: string; clientId: string; valid: boolean }>
      >`
        SELECT input, owner_user_id AS "ownerUserId", client_id::text AS "clientId",
          (status='running' AND claimed_by=${job.claimToken} AND attempt=${job.attempt}) AS valid
        FROM sp_draft_job WHERE tenant_id=${job.tenantId}::uuid AND id=${job.id}::uuid FOR UPDATE`;
      const row = rows[0];
      if (
        !row?.valid ||
        row.ownerUserId !== job.ownerUserId ||
        row.clientId !== envelope.request.clientId ||
        !row.input.objectiveGeneration ||
        row.input.objectiveGeneration.receipt.result ||
        row.input.objectiveGeneration.receipt.failure !== null ||
        row.input.objectiveGeneration.receipt.schemaVersion !== 1 ||
        row.input.objectiveGeneration.fingerprint !== envelope.fingerprint ||
        digest(envelope.request) !== envelope.fingerprint ||
        digest(row.input.objectiveGeneration.request) !== digest(envelope.request)
      )
        throw new ObjectiveLeaseLost();
      // Fixed table SHARE gate protects inserts/moves/deletes as well as values.
      // No network/model operation executes under these locks.
      await lockObjectiveSources(tx);
      const admitted = await admitObjective(
        tx,
        { tenantId: job.tenantId, clerkUserId: job.ownerUserId },
        envelope.request,
      );
      const compiled = admission();
      if (
        !compiled ||
        digest(admitted.source) !== digest(envelope.receipt.source) ||
        admitted.sourceDigest !== compiled.context.sourceDigest ||
        digest(row.input.objectiveGeneration.receipt.context) !== digest(compiled.context) ||
        digest(
          await readObjectiveSources(
            tx,
            job.tenantId,
            envelope.request.clientId,
            compiled.contactIds,
            job.ownerUserId,
          ),
        ) !== compiled.localDigest
      )
        throw new Error('OBJECTIVE_CONTEXT_INCOMPLETE');
      const deadline = await tx.$queryRaw<Array<{ valid: boolean }>>`
        SELECT deadline_at > clock_timestamp() AS valid FROM sp_draft_job WHERE id=${job.id}::uuid AND tenant_id=${job.tenantId}::uuid`;
      if (!deadline[0]?.valid) throw new ObjectiveLeaseLost();
      if (row.input.canonicalGeneration) {
        const associated = await generationAssociation(tx, job.tenantId, job.ownerUserId, job.id);
        if (digest(row.input.canonicalGeneration) !== digest(generationMarker(associated.admission)) ||
            job.claimToken !== `canonical:${associated.acceptance.issuance.issuanceKey}` || job.attempt !== 2)
          throw new ObjectiveLeaseLost();
        await requireCanonicalGenerationEffectWithinTx(tx, associated.admission, {
          generationJobId: job.id, generationRequestId: envelope.request.requestId });
      }
      lockedInput = row.input;
    },
    afterWrite: async (tx, saved) => {
      const compiled = admission();
      if (!lockedInput?.objectiveGeneration || !compiled) throw new ObjectiveLeaseLost();
      const times = await tx.$queryRaw<
        Array<{ savedAt: Date }>
      >`SELECT clock_timestamp() AS "savedAt"`;
      const receipt = lockedInput.objectiveGeneration.receipt;
      if (!envelope.historyCheckedAt || !Number.isFinite(Date.parse(envelope.historyCheckedAt)))
        throw new ObjectiveLeaseLost();
      receipt.context.reobservedAt = envelope.historyCheckedAt;
      lockedInput.objectiveGeneration.historyCheckedAt = envelope.historyCheckedAt;
      receipt.result = {
        ...saved,
        sourceDigest: compiled.context.sourceDigest!,
        contextPacketId: compiled.context.packetId!,
        coverageDigest: compiled.context.coverageDigest!,
        inputDigest: compiled.context.inputDigest!,
        savedAt: times[0]!.savedAt.toISOString(),
      };
      receipt.failure = null;
      const updated =
        await tx.$executeRaw`UPDATE sp_draft_job SET status='completed', stage='completed',
        progress_text='Done', strategy_id=${saved.strategyId}::uuid, error_message=NULL, stream_preview=NULL,
        input=${JSON.stringify(lockedInput)}::jsonb, updated_at=clock_timestamp()
        WHERE id=${job.id}::uuid AND tenant_id=${job.tenantId}::uuid AND status='running'
          AND claimed_by=${job.claimToken} AND attempt=${job.attempt} AND strategy_id IS NULL
          AND deadline_at > clock_timestamp() AND (input #> '{objectiveGeneration,receipt,result}')='null'::jsonb`;
      if (updated !== 1) throw new ObjectiveLeaseLost();
      if (lockedInput.canonicalGeneration) {
        const producer = await recordCanonicalGenerationProducer(tx, job.tenantId, job.ownerUserId, job.id);
        await requireCanonicalGenerationEffectWithinTx(tx, producer.sourceAdmission, {
          generationJobId: job.id, generationRequestId: envelope.request.requestId }, 'after-write');
        const fresh = await tx.$queryRaw<Array<{ valid: boolean }>>`
          SELECT ceil(extract(epoch FROM clock_timestamp())*1000) < ${producer.acceptance.issuance.expiresAtMs} AS valid`;
        if (!fresh[0]?.valid) throw new ObjectiveLeaseLost();
      }
    },
  };
}

export function safeObjectiveFailure(error: unknown) {
  const response = (error as { getResponse?: () => unknown })?.getResponse?.() as
    { code?: string } | undefined;
  const candidate = response?.code ?? (error instanceof Error ? error.message : '');
  const code = candidate && SAFE_FAILURES[candidate] ? candidate : 'OBJECTIVE_GENERATION_FAILED';
  return { code, message: SAFE_FAILURES[code]! };
}
