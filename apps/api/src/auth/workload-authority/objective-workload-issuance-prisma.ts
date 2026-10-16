import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  loadObjectivePreacceptanceCurrentFactsWithinTx,
  type ObjectiveCurrentSourceOptions,
} from './objective-workload-current.js';
import {
  ObjectiveWorkloadIssuanceError,
  type CurrentObjectiveIssuanceSource,
  type ObjectiveIssuanceSelector,
  type ObjectiveIssuanceTransaction,
  type ObjectiveIssuanceTransactionPort,
  type ObjectiveWorkloadIssueDecisionRecord,
  type ObjectiveWorkloadIssuanceRecord,
  type ObjectiveWorkloadDeliveryRecord,
  type ObjectiveWorkloadProofUseRecord,
} from './objective-workload-issuance.js';
import {
  OBJECTIVE_GENERATION_WORKER_SUBJECT,
  OBJECTIVE_STRATEGY_AUDIENCE,
} from './objective-workload-jwt.js';

/** Unmounted Core SQL port. The migration's CHECK(enabled=false) means the
 * current-facts loader denies before any issuance can succeed. Neither this
 * file nor the offline test runs SQL against a database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function unavailable(): never { throw new ObjectiveWorkloadIssuanceError('UNAVAILABLE'); }
const exactOne = (rows: unknown): void => {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) unavailable();
};
const atMostOne = <T>(rows: unknown): T | null => {
  if (!Array.isArray(rows) || rows.length > 1) unavailable();
  return (rows[0] as T | undefined) ?? null;
};

/** The default is disabled. Even an explicitly enabled source option cannot
 * pass the current migration's DB CHECK(enabled=false). The policy digest is
 * operator-pinned, never read from the caller proof or target request. */
export function createPrismaObjectiveIssuancePort(
  prisma: PrismaService,
  options: ObjectiveCurrentSourceOptions,
): ObjectiveIssuanceTransactionPort {
  const nativeTransactions = new WeakMap<object, { native: Prisma.TransactionClient; tenantId: string }>();

  return {
    withTenantTransaction<T>(tenantId: string, run: (tx: ObjectiveIssuanceTransaction) => Promise<T>) {
      if (!UUID.test(tenantId)) return Promise.reject(new ObjectiveWorkloadIssuanceError('UNAVAILABLE'));
      return prisma.withTenant(tenantId, async (native) => {
        const tx: ObjectiveIssuanceTransaction = {
          async lockOperation(operationId) {
            if (!UUID.test(operationId)) unavailable();
            // The namespace prevents unrelated advisory locks from sharing a
            // key. Hash collision can only over-serialize. This is an xact
            // lock on the SAME native transaction used for both inserts.
            const rows = await native.$queryRaw<Array<{ locked: string }>>`
              SELECT pg_advisory_xact_lock(
                hashtextextended('capiro-objective-workload-issuance:' || ${operationId}::text, 0::bigint)
              )::text AS locked`;
            exactOne(rows);
            if (typeof rows[0]?.locked !== 'string') unavailable();
          },
          async findDecision(operationId) {
            if (!UUID.test(operationId)) unavailable();
            const rows = await native.$queryRaw<ObjectiveWorkloadIssueDecisionRecord[]>`
              SELECT operation_id::text AS "operationId",caller_issuer AS "callerIssuer",
                caller_subject AS "callerSubject",issuance_request_sha256 AS "issuanceRequestSha256",
                decision,resolved_tenant_id::text AS "tenantId",
                generation_job_id::text AS "generationJobId",phase
              FROM client_objective_workload_issue_decisions
              WHERE resolved_tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid FOR SHARE`;
            return atMostOne<ObjectiveWorkloadIssueDecisionRecord>(rows);
          },
          async insertDecision(row) {
            if (row.tenantId !== tenantId ||
                (row.decision === 'issued' && (!row.generationJobId || !UUID.test(row.generationJobId) ||
                  row.phase !== 'admit')) ||
                (row.decision === 'denied' && (row.generationJobId !== null || row.phase !== null))) unavailable();
            const count = await native.$executeRaw`
              INSERT INTO client_objective_workload_issue_decisions (
                operation_id,caller_issuer,caller_subject,issuance_request_sha256,decision,
                resolved_tenant_id,generation_job_id,phase
              ) VALUES (
                ${row.operationId}::uuid,${row.callerIssuer},${row.callerSubject},
                ${row.issuanceRequestSha256},${row.decision},${tenantId}::uuid,
                ${row.generationJobId}::uuid,${row.phase}
              )`;
            if (count !== 1) unavailable();
          },
          async findIssuance(operationId) {
            if (!UUID.test(operationId)) unavailable();
            const rows = await native.$queryRaw<ObjectiveWorkloadIssuanceRecord[]>`
              SELECT operation_id::text AS "operationId", tenant_id::text AS "tenantId",
                client_id::text AS "clientId", objective_id::text AS "objectiveId",
                work_action AS "workAction", control_id::text AS "controlId",
                consent_id::text AS "consentId", generation_job_id::text AS "generationJobId",
                delegation_ref::text AS "delegationRef", caller_issuer AS "callerIssuer",
                caller_subject AS "callerSubject", issuance_request_sha256 AS "issuanceRequestSha256",
                authorization_jti::text AS "authorizationJti", token_issuer AS "tokenIssuer",
                token_subject AS "tokenSubject", token_audience AS "tokenAudience",
                signer_key_id AS "signerKeyId", phase, target_method AS "targetMethod",
                target_path AS "targetPath", target_query AS "targetQuery",
                target_body_sha256 AS "targetBodySha256", attempt_id::text AS "attemptId",
                run_id::text AS "runId", accepted_binding_sha256 AS "acceptedBindingSha256",
                source_sha256 AS "sourceSha256",
                iat_seconds AS "iatSeconds", nbf_seconds AS "nbfSeconds", exp_seconds AS "expSeconds"
              FROM client_objective_workload_issuances
              WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid FOR SHARE`;
            return atMostOne<ObjectiveWorkloadIssuanceRecord>(rows);
          },
          async insertIssuance(row) {
            if (row.tenantId !== tenantId) unavailable();
            const count = await native.$executeRaw`
              INSERT INTO client_objective_workload_issuances (
                operation_id,tenant_id,client_id,objective_id,work_action,control_id,consent_id,
                generation_job_id,delegation_ref,caller_issuer,caller_subject,issuance_request_sha256,
                authorization_jti,token_issuer,token_subject,token_audience,signer_key_id,phase,
                target_method,target_path,target_query,target_body_sha256,attempt_id,run_id,
                accepted_binding_sha256,source_sha256,iat_seconds,nbf_seconds,exp_seconds
              ) VALUES (
                ${row.operationId}::uuid,${tenantId}::uuid,${row.clientId}::uuid,${row.objectiveId}::uuid,
                ${row.workAction},${row.controlId}::uuid,${row.consentId}::uuid,
                ${row.generationJobId}::uuid,${row.delegationRef}::uuid,
                ${row.callerIssuer},${row.callerSubject},${row.issuanceRequestSha256},
                ${row.authorizationJti}::uuid,${row.tokenIssuer},${row.tokenSubject},${row.tokenAudience},
                ${row.signerKeyId},${row.phase},${row.targetMethod},${row.targetPath},${row.targetQuery},
                ${row.targetBodySha256},${row.attemptId}::uuid,${row.runId}::uuid,
                ${row.acceptedBindingSha256},${row.sourceSha256},
                ${row.iatSeconds},${row.nbfSeconds},${row.expSeconds}
              )`;
            if (count !== 1) unavailable();
          },
          async findDelivery(operationId) {
            if (!UUID.test(operationId)) unavailable();
            const rows = await native.$queryRaw<ObjectiveWorkloadDeliveryRecord[]>`
              SELECT operation_id::text AS "operationId",tenant_id::text AS "tenantId",
                authorization_jti::text AS "authorizationJti",state,
                token_sha256 AS "tokenSha256"
              FROM client_objective_workload_deliveries
              WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid FOR SHARE`;
            return atMostOne<ObjectiveWorkloadDeliveryRecord>(rows);
          },
          async insertDelivery(row) {
            if (row.tenantId !== tenantId || row.state !== 'claimed' ||
                row.tokenSha256 !== null || !UUID.test(row.authorizationJti)) unavailable();
            const count = await native.$executeRaw`
              INSERT INTO client_objective_workload_deliveries
                (operation_id,tenant_id,authorization_jti,state,token_sha256)
              VALUES (${row.operationId}::uuid,${tenantId}::uuid,
                ${row.authorizationJti}::uuid,'claimed',NULL)`;
            if (count !== 1) unavailable();
          },
          async finalizeDelivery(operationId, state, tokenSha256) {
            if (!UUID.test(operationId) ||
                (state === 'issued' && !/^[0-9a-f]{64}$/.test(tokenSha256 ?? '')) ||
                (state === 'unknown' && tokenSha256 !== null)) unavailable();
            const count = await native.$executeRaw`
              UPDATE client_objective_workload_deliveries
              SET state=${state},token_sha256=${tokenSha256},finalized_at=clock_timestamp()
              WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid
                AND state='claimed'`;
            if (count !== 1) unavailable();
          },
          async findProofUse(callerIssuer, proofJti) {
            if (!UUID.test(proofJti)) unavailable();
            const rows = await native.$queryRaw<ObjectiveWorkloadProofUseRecord[]>`
              SELECT tenant_id::text AS "tenantId",caller_issuer AS "callerIssuer",
                caller_subject AS "callerSubject",caller_key_id AS "callerKeyId",
                proof_jti::text AS "proofJti",operation_id::text AS "operationId",
                operation_decision AS "operationDecision",proof_outcome AS "proofOutcome",
                proof_request_sha256 AS "proofRequestSha256",
                proof_iat_seconds AS "proofIatSeconds",proof_nbf_seconds AS "proofNbfSeconds",
                proof_exp_seconds AS "proofExpSeconds"
              FROM client_objective_workload_proof_uses
              WHERE tenant_id=${tenantId}::uuid AND caller_issuer=${callerIssuer}
                AND proof_jti=${proofJti}::uuid FOR SHARE`;
            return atMostOne<ObjectiveWorkloadProofUseRecord>(rows);
          },
          async insertProofUse(row) {
            if (row.tenantId !== tenantId) unavailable();
            const count = await native.$executeRaw`
              INSERT INTO client_objective_workload_proof_uses (
                tenant_id,caller_issuer,caller_subject,caller_key_id,proof_jti,operation_id,
                operation_decision,proof_outcome,proof_request_sha256,
                proof_iat_seconds,proof_nbf_seconds,proof_exp_seconds
              ) VALUES (
                ${tenantId}::uuid,${row.callerIssuer},${row.callerSubject},${row.callerKeyId},
                ${row.proofJti}::uuid,${row.operationId}::uuid,
                ${row.operationDecision},${row.proofOutcome},${row.proofRequestSha256},
                ${row.proofIatSeconds},${row.proofNbfSeconds},${row.proofExpSeconds}
              )`;
            if (count !== 1) unavailable();
          },
        };
        nativeTransactions.set(tx, { native, tenantId });
        return run(tx);
      });
    },
    async loadCurrent(tx: ObjectiveIssuanceTransaction, selector: ObjectiveIssuanceSelector): Promise<CurrentObjectiveIssuanceSource> {
      const scope = nativeTransactions.get(tx);
      if (!scope || selector.tenantId !== scope.tenantId || selector.phase !== 'admit') unavailable();
      // The helper owns job -> native scope -> canonical -> control ->
      // delegation locks and compares the immutable request, actor,
      // membership, client wall, policy and live database clock.
      const facts = await loadObjectivePreacceptanceCurrentFactsWithinTx(
        scope.native,
        { tenantId: selector.tenantId, delegationRef: selector.delegationRef,
          consentId: selector.consentId, generationJobId: selector.generationJobId, phase: 'admit' },
        options,
      );
      const databaseNowSeconds = Math.ceil(facts.checkedAtMs / 1000);
      const validUntilSeconds = Math.floor(facts.effectExpiresAtMs / 1000);
      if (!Number.isSafeInteger(databaseNowSeconds) || !Number.isSafeInteger(validUntilSeconds) ||
          validUntilSeconds <= databaseNowSeconds) unavailable();
      return Object.freeze({
        enabled: true, databaseNowSeconds, validUntilSeconds,
        tenantId: facts.tenantId, clientId: facts.clientId, objectiveId: facts.objectiveId,
        workAction: 'objective.strategy.draft', controlId: facts.controlId,
        consentId: facts.consentId, generationJobId: facts.generationJobId,
        delegationRef: facts.delegationRef,
        // These constants are returned only AFTER the loader compared the
        // exact DB delegation service subject and audience under lock.
        serviceSubject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
        audience: OBJECTIVE_STRATEGY_AUDIENCE,
        sourceSha256: null,
      });
    },
  };
}
