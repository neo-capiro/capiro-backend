import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { CanonicalApplicationError, type CanonicalApplicationGrant } from './objective-canonical-application.js';

export type CanonicalAuthorityPurpose = 'effect' | 'retained-result-read';
export interface CanonicalAuthoritySubject {
  purpose: CanonicalAuthorityPurpose;
  applicationRequestId: string;
  requestSha256: string | null;
}
/** Centrally allocated binding port. An implementation must authenticate a named
 * workload issuer/audience + original delegated native actor, pin the complete
 * immutable original work/request, and check current claim/revocation authority.
 * No generic internal secret, receipt hash, Clerk context digest, task/model
 * token or caller actor is a substitute. No network/model work belongs in tx. */
@Injectable()
export class ObjectiveCanonicalWorkloadAuthority {
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
