import type { Prisma } from '@prisma/client';
import type { CandidateIdentityV1 } from './verification-repository.js';

/**
 * Optional caller-owned authorization/correlation checkpoint. It must complete
 * in the transaction that creates or reuses these exact candidate/run rows;
 * throwing aborts the transaction. The verifier owns no caller-specific schema.
 */
export type VerificationPersistenceFenceV1 = (
  tx: Prisma.TransactionClient,
  identity: CandidateIdentityV1,
  candidateId: string,
  verificationRunId: string,
) => Promise<void>;
