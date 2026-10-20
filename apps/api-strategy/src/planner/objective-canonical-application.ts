// Shared codec preserves complete private parsing, hashes and paired application reconstruction.
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { createPlannerApplicationCodec } from '@capiro/shared/objective-planner-owner-codec';
export { CanonicalApplicationError, CANONICAL_APPLICATION_RECEIPT, CANONICAL_APPLICATION_HEAD, CANONICAL_APPLICATION_OPERATION } from '@capiro/shared/objective-planner-owner-codec';
export type { CanonicalToken, CanonicalApplicationRequest, CanonicalApplicationGrant, CanonicalCreationAck, StoredCanonicalApplication, CanonicalApplicationObservation, CanonicalApplicationTransaction } from '@capiro/shared/objective-planner-owner-codec';
const codec = createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
export const { applicationUuid, parseCanonicalApplication, applicationJson, applicationHash, canonicalApplicationRequestId, applicationReceiptId, applicationHeadId, executeCanonicalApplicationTransaction, creationAck, checkStoredApplication, applicationObservation } = codec;
