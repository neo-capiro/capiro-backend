import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { CanonicalApplicationError, type CanonicalApplicationGrant } from './objective-canonical-application.js';
import type { CanonicalGenerationAdmission, SanitizedGenerationIssuance, AcceptedRunBinding } from '../meri/objective-canonical-generation.js';

export type CanonicalAuthorityPurpose = 'effect' | 'retained-result-read';
export interface CanonicalAuthoritySubject {
  purpose: CanonicalAuthorityPurpose;
  applicationRequestId: string;
  requestSha256: string | null;
  /** Fixed producer endpoint: hash binds its WHOLE phase+work envelope, not
   * the different nine-field application body. No caller-selected route. */
  producerPhase?: 'start' | 'prepare' | 'read' | 'stop';
}
export interface CanonicalGenerationSubject {
  phase: 'admit' | 'admission-read' | 'accept'; generationJobId: string; requestSha256: string;
}
export interface CanonicalGenerationGrant {
  tenantId: string; actorUserId: string; clerkUserId: string; consentId: string; controlVersion: number;
  requestSha256: string; checkedAtMs: number; expiresAtMs: number; delegationExpiresAtMs: number; claimExpiresAtMs: number;
}
export interface VerifiedGenerationAcceptance {
  grant: CanonicalGenerationGrant;
  sourceAdmission: CanonicalGenerationAdmission;
  sourceAdmissionSha256: string;
  sourceBinding: AcceptedRunBinding;
  sourceRequestSha256: string;
  issuance: SanitizedGenerationIssuance;
}
/** Centrally allocated binding port. An implementation must authenticate a named
 * workload issuer/audience + original delegated native actor, pin the complete
 * immutable original work/request, and check current claim/revocation authority.
 * No generic internal secret, receipt hash, Clerk context digest, task/model
 * token or caller actor is a substitute. No network/model work belongs in tx. */
@Injectable()
export class ObjectiveCanonicalWorkloadAuthority {
  /** Same centrally owned verifier, distinct GENERATION audience/action. The
   * adapter must authenticate the original native/Clerk delegation and bind
   * this fixed endpoint, phase, actual job and whole HTTP-body SHA. */
  async verifyGeneration(_request: Request, _subject: CanonicalGenerationSubject): Promise<CanonicalGenerationGrant> {
    throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
  async assertGenerationCurrent(_tx: Prisma.TransactionClient, _grant: CanonicalGenerationGrant,
    _subject: CanonicalGenerationSubject): Promise<void> {
    throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
  /** This is NOT a signature over caller JSON. The real adapter must read the
   * original accepted Meri request and genuine ISSUED metadata, verify its
   * protected facts.objectiveGeneration field/full-facts hash before dispatch,
   * and return that exact owner observation. No issue/resolve/material access.
   * It remains unavailable until that actual owner transport is bound. */
  async verifyGenerationAcceptance(_request: Request, _subject: CanonicalGenerationSubject): Promise<VerifiedGenerationAcceptance> {
    throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
  async verify(_request: Request, _subject: CanonicalAuthoritySubject): Promise<CanonicalApplicationGrant> {
    throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
  /** The approved issuer adapter must supply a transaction-local current claim
   * witness/fence bound to this subject. Disabled until that binding is real.
   * Retained reads do not revive the original effect grant/consent. */
  async assertCurrent(_tx: Prisma.TransactionClient, _grant: CanonicalApplicationGrant,
    _subject: CanonicalAuthoritySubject): Promise<void> {
    throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  }
}
