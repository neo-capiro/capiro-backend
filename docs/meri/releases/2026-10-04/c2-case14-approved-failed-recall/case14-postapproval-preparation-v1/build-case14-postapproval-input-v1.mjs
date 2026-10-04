// Codex preparation only. Import into the attended collector process after its
// exact canonical UI approval. Copied JSON is intentionally insufficient.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { currentCase14ApprovalAuthority } from '../../../meri-c1-20261002/evals/meri/live-v1/case14-approval-capture.mjs';
import { PIN, stableHash, validateInput } from './case14-postapproval-inner-v1.mjs';

export function buildCase14PostApprovalInput(approvalOutcome, { maxCostMicros }) {
  const evidence = currentCase14ApprovalAuthority(approvalOutcome);
  assert.equal(evidence.apiSha, PIN.source); assert.equal(evidence.webSha, PIN.source);
  const rateEvidence = JSON.parse(readFileSync(fileURLToPath(new URL('./reviewed-rates-retained.json', import.meta.url)), 'utf8'));
  const input = {
    kind: 'case14-postapproval-native-setup-input', version: 1, sourceSha: PIN.source,
    captureRunId: evidence.captureRunId,
    ctx: { tenantId: PIN.tenantId, tenantSlug: PIN.tenantSlug, userId: PIN.reviewerId,
      clerkUserId: PIN.reviewerClerkId, role: 'user_admin' },
    clientId: PIN.clientId, approvalEvidenceSha256: stableHash(evidence),
    approvedOwner: evidence.after.fixtureEvidence,
    limits: { maxAttempts: 32, maxTokens: 500000, maxCostMicros }, rateEvidence,
  };
  validateInput(input);
  return input;
}

export function writeCase14PostApprovalInput(path, approvalOutcome, limits) {
  const input = buildCase14PostApprovalInput(approvalOutcome, limits);
  const bytes = Buffer.from(JSON.stringify(input) + '\n');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    captureRunId: input.captureRunId, approvalEvidenceSha256: input.approvalEvidenceSha256,
    rateEvidenceSha256: PIN.rateEvidenceSha256, rateEvidenceExpiresAt: PIN.rateEvidenceExpiresAt,
    status: 'LOCAL_INPUT_PREPARED_NOT_EXECUTED' };
}
