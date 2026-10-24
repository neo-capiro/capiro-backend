import { Injectable } from '@nestjs/common';
import { objectiveStrategyJobTenantWithinSystemTx, readObjectiveStrategyJobSubjectWithinTx } from '@capiro/shared/objective-strategy-intake';
import { PrismaService } from '../prisma/prisma.service.js';
import { hasInternalServiceIdentity } from '../auth/internal-service.guard.js';
import { ObjectiveNativeReader, readNativeObjectiveAcceptance } from '../meri/objective-native-reader.js';
import { readGenerationLedger } from '../meri/objective-canonical-producer-ledger.js';
import { GENERATION_ADMISSION, parseCanonicalGenerationAdmission, canonicalGenerationAdmissionSha256 } from '../meri/objective-canonical-generation.js';
import { readCanonicalRequestPublication } from '../meri/objective-canonical-request-ledger.js';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { CanonicalApplicationError } from './objective-canonical-application.js';
import type { CanonicalGenerationAdmission, AcceptedRunBinding } from '../meri/objective-canonical-generation.js';

export type CanonicalAuthorityPurpose = 'effect' | 'retained-result-read';
export interface CanonicalAuthoritySubject {
  purpose: CanonicalAuthorityPurpose;
  applicationRequestId: string;
  requestSha256: string | null;
  /** Existing durable Planner phase, bound by its owner transaction. */
  producerPhase?: 'start' | 'prepare' | 'read' | 'stop';
}
export interface CanonicalGenerationSubject {
  phase: 'admit' | 'admission-read' | 'publish' | 'request-read' | 'accept' | 'complete' | 'completion-read' |
    'terminal-account' | 'terminal-read'; generationJobId: string; requestSha256: string;
}
export interface CanonicalGenerationGrant {
  tenantId: string; actorUserId: string; clerkUserId: string; consentId: string; controlVersion: number;
  requestSha256: string; checkedAtMs: number; expiresAtMs: number;

}
export interface VerifiedGenerationAcceptance {
  grant: CanonicalGenerationGrant;
  sourceAdmission: CanonicalGenerationAdmission;
  sourceAdmissionSha256: string;
  sourceBinding: AcceptedRunBinding;
  sourceRequestSha256: string;
  effectExpiresAtMs: number;
  /** Actual native run-start values, compared against the immutable
   * Core publication before claim. Never read from caller POST fields. */
  typedRequestSha256?: string;
  executionContextSha256?: string;
  acceptedRequestId?: string;
  acceptedPromptSha256?: string;
}
/** Service identity selects no principal. The immutable job and original consent
 * select its actor; canonical Core rows are reread in every owning transaction. */
@Injectable()
export class ObjectiveCanonicalWorkloadAuthority {
  constructor(private readonly prisma: PrismaService, private readonly native: ObjectiveNativeReader) {}
  async verifyGeneration(request: Request, subject: CanonicalGenerationSubject): Promise<CanonicalGenerationGrant> {
    if (!hasInternalServiceIdentity(request)) throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
    const tenantId = await this.prisma.withSystem(tx =>
      objectiveStrategyJobTenantWithinSystemTx(tx, subject.generationJobId));
    return this.prisma.withTenant(tenantId, async tx => {
      const s = await readObjectiveStrategyJobSubjectWithinTx(tx, { tenantId,
        generationJobId: subject.generationJobId, effect: false });
      return { tenantId, actorUserId: s.actorUserId, clerkUserId: s.clerkUserId,
        consentId: s.consentId, controlVersion: s.controlVersion, requestSha256: subject.requestSha256,
        checkedAtMs: s.checkedAtMs, expiresAtMs: s.effectExpiresAtMs };
    });
  }
  async assertGenerationCurrent(tx: Prisma.TransactionClient, grant: CanonicalGenerationGrant,
    subject: CanonicalGenerationSubject): Promise<void> {
    const current = await readObjectiveStrategyJobSubjectWithinTx(tx, { tenantId: grant.tenantId,
      generationJobId: subject.generationJobId, effect: false });
    if (subject.requestSha256 !== grant.requestSha256 || current.actorUserId !== grant.actorUserId ||
        current.clerkUserId !== grant.clerkUserId || current.consentId !== grant.consentId ||
        current.controlVersion !== grant.controlVersion || current.effectExpiresAtMs !== grant.expiresAtMs)
      throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
  async verifyGenerationAcceptance(request: Request, subject: CanonicalGenerationSubject): Promise<VerifiedGenerationAcceptance> {
    const grant = await this.verifyGeneration(request, subject);
    const expected = await this.prisma.withTenant(grant.tenantId, async tx => {
      await this.assertGenerationCurrent(tx, grant, subject);
      const raw = await readGenerationLedger(tx, GENERATION_ADMISSION, grant.tenantId, grant.clerkUserId, subject.generationJobId);
      if (!raw) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
      const admission = parseCanonicalGenerationAdmission(raw), saved = await readCanonicalRequestPublication(tx, admission);
      if (!saved) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
      return { admission, publication: saved.publication };
    });
    const controller = new AbortController(), abort = () => controller.abort();
    request.once('aborted', abort);
    try {
      if (request.aborted) throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
      const raw = await this.native.acceptance(subject.generationJobId,
        canonicalGenerationAdmissionSha256(expected.admission), controller.signal);
      if (request.aborted) throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
      return { grant, ...readNativeObjectiveAcceptance(raw, expected) };
    } finally { request.removeListener('aborted', abort); controller.abort(); }
  }
}
